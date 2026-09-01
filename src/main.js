import "leaflet/dist/leaflet.css";
import "./style.css";
import L from "leaflet";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";

const MIN_ZONE_ZOOM = 8;
const MIN_POI_ZOOM = 10;
const PAD = 0.35;
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 80;
const DEBOUNCE = 250;
const MAX_OSM_AREA = 1.2;
const MAX_MARKERS = 900;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "/api/osm",
];

const TYPES = {
  shelter: ["Wiaty / schronienia", "🛖"],
  firepit: ["Paleniska", "🔥"],
  picnic: ["Miejsca wypoczynku", "🪑"],
  water: ["Woda pitna", "💧"],
  toilets: ["Toalety", "🚻"],
  campsite: ["Miejsca biwakowe", "⛺"],
  parking: ["Parking / postój", "🅿️"],
  viewpoint: ["Punkty widokowe", "👁️"],
};

const BDL_LAYERS = [
  [15, "rest", "objectid,nzw_ob,adres,link,wiata,lawostoly,palenisko,parking,toalety_tm,toalety_st,woda_pitna,kuchenka"],
  [5, "shelter", "objectid,nzw_ob,adres,link"],
  [6, "campsite", "objectid,nzw_ob,adres,link"],
  [17, "parking", "objectid,nzw_ob,adres,link"],
  [19, "parking", "objectid,nzw_ob,adres,link"],
  [25, "viewpoint", "objectid,nzw_ob,adres,link"],
  [27, "other", "objectid,nzw_ob,adres,link,wiata,lawostoly,palenisko,parking,toalety_tm,toalety_st,woda_pitna,kuchenka"],
];

document.querySelector("#app").innerHTML = `
<div class="layout">
  <aside class="sidebar">
    <div class="brand"><div class="brand-badge">🌲</div><div><h1>Zanocuj w lesie</h1><p>Obszary programu + punkty z BDL i OpenStreetMap.</p></div></div>
    <section class="panel"><h2>Pokaż na mapie</h2><div id="filters" class="filters"></div></section>
    <section class="panel stats-panel">
      <div class="stat-row"><span>Obszary Zanocuj w lesie</span><strong id="zones">0</strong></div>
      <div class="stat-row"><span>Punkty BDL</span><strong id="bdl">0</strong></div>
      <div class="stat-row"><span>Punkty OSM</span><strong id="osm">0</strong></div>
      <div class="stat-row"><span>Pokazane markery</span><strong id="shown">0</strong></div>
    </section>
    <section class="panel"><h2>Źródła</h2>
      <label class="source-filter"><input id="src-bdl" type="checkbox" checked> <span class="dot dot-bdl"></span> BDL / Lasy Państwowe</label>
      <label class="source-filter"><input id="src-osm" type="checkbox" checked> <span class="dot dot-osm"></span> OpenStreetMap</label>
      <label class="source-filter"><input id="only-zone" type="checkbox"> Tylko wewnątrz obszarów Zanocuj w lesie</label>
      <label class="source-filter"><input id="hide-bus" type="checkbox"> Ukryj wiaty przystankowe (OSM)</label>
      <p class="hint">Punkty z obu baz są pokazywane osobno. Jeśli BDL i OSM opisują to samo miejsce, markery rozsuwają się, żeby oba były klikalne.</p>
    </section>
    <section class="panel info-panel"><h2>Status</h2><p id="status">Przybliż mapę.</p><details id="debug-wrap" class="debug hidden"><summary>Szczegóły</summary><pre id="debug"></pre></details></section>
    <section class="panel warning-panel"><strong>Uwaga o ogniu</strong><p>Marker paleniska nie oznacza automatycznie, że danego dnia wolno rozpalić ogień. Sprawdź zasady nadleśnictwa.</p></section>
  </aside>
  <main class="map-wrap"><div id="map"></div><div id="map-message" class="map-message hidden"></div></main>
</div>`;

const $ = (s) => document.querySelector(s);
const statusEl = $("#status");
const debugEl = $("#debug");
const debugWrap = $("#debug-wrap");
const messageEl = $("#map-message");
const enabled = new Set(Object.keys(TYPES));

for (const [type, [label, icon]] of Object.entries(TYPES)) {
  const el = document.createElement("label");
  el.className = "filter";
  el.innerHTML = `<input type="checkbox" data-type="${type}" checked><span class="filter-icon">${icon}</span><span>${label}</span>`;
  $("#filters").appendChild(el);
}

$("#filters").addEventListener("change", (e) => {
  const cb = e.target.closest("input[data-type]");
  if (!cb) return;
  cb.checked ? enabled.add(cb.dataset.type) : enabled.delete(cb.dataset.type);
  renderPois();
});
for (const id of ["#src-bdl", "#src-osm", "#only-zone", "#hide-bus"]) {
  $(id).addEventListener("change", renderPois);
}

const start = readHash() || { lat: 52, lon: 19.2, zoom: 7 };
const map = L.map("map").setView([start.lat, start.lon], start.zoom);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
}).addTo(map);

const zoneLayer = L.geoJSON(null, {
  style: { color: "#236b3d", weight: 1, fillColor: "#6bbf78", fillOpacity: 0.25 },
  onEachFeature(feature, layer) {
    const p = feature.properties || {};
    layer.bindPopup(`<div class="popup"><strong>${esc(p.nzw_ob || p.inv_nr || "Zanocuj w lesie")}</strong>${p.inv_nr ? `<div>Nr: ${esc(p.inv_nr)}</div>` : ""}</div>`);
  },
}).addTo(map);
const poiLayer = L.layerGroup().addTo(map);

const cache = new Map();
let zones = [];
let zoneBoxes = [];
let bdlPois = [];
let osmPois = [];
let loadedFor = null;
let serial = 0;
let timer;
let inFlight = null;
let overpassPreferred = readPreferredEndpoint();

map.on("moveend zoomend", () => { writeHash(); schedule(); });
window.addEventListener("hashchange", () => {
  const h = readHash();
  const c = map.getCenter();
  if (!h) return;
  if (h.zoom === map.getZoom() && Math.abs(h.lat - c.lat) < 1e-5 && Math.abs(h.lon - c.lng) < 1e-5) return;
  map.setView([h.lat, h.lon], h.zoom);
});
schedule();

// Pozycja mapy w adresie URL - link i odświeżenie strony zachowują widok.
function readHash() {
  const m = /^#(\d{1,2})\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(location.hash);
  if (!m) return null;
  const zoom = Number(m[1]);
  const lat = Number(m[2]);
  const lon = Number(m[3]);
  if (zoom < 1 || zoom > 19 || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { zoom, lat, lon };
}

function writeHash() {
  const c = map.getCenter();
  const next = `#${map.getZoom()}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(refresh, DEBOUNCE);
}

async function refresh() {
  const zoom = map.getZoom();
  const view = map.getBounds();

  if (zoom < MIN_ZONE_ZOOM) {
    abortInFlight();
    serial++;
    resetData();
    zoneLayer.clearLayers();
    poiLayer.clearLayers();
    updateCounts(0);
    setStatus(`Przybliż mapę do zoomu ${MIN_ZONE_ZOOM}.`);
    showMessage(`Zoom ${MIN_ZONE_ZOOM}+ pokaże obszary Zanocuj w lesie.`);
    return;
  }

  // Dane pobieramy dla widoku powiększonego o margines, więc drobne
  // przesunięcia mapy obsługujemy z pamięci, bez ruchu sieciowego.
  if (loadedFor && loadedFor.band === band(zoom) && loadedFor.bounds.contains(view)) {
    hideMessage();
    const n = renderPois();
    setStatus(`Obszary: ${zones.length}. BDL: ${bdlPois.length}. OSM: ${osmPois.length}. Na mapie: ${n}. (z pamięci)`);
    return;
  }

  abortInFlight();
  const controller = new AbortController();
  inFlight = controller;
  const id = ++serial;
  const bounds = padBounds(view, PAD);
  const started = performance.now();
  const notes = [];
  let failed = false;

  clearDebug();
  hideMessage();
  setStatus("Pobieram dane...");

  const jobs = [];

  jobs.push(
    loadZones(bounds, zoom, controller.signal).then(
      (features) => {
        if (id !== serial) return;
        zones = features;
        zoneBoxes = features.map(featureBbox);
        zoneLayer.clearLayers();
        zoneLayer.addData({ type: "FeatureCollection", features });
        updateCounts();
      },
      (e) => {
        if (id !== serial) return;
        zones = [];
        zoneBoxes = [];
        zoneLayer.clearLayers();
        failed = true;
        notes.push(`Obszary BDL: ${errText(e)}`);
      }
    )
  );

  if (zoom >= MIN_POI_ZOOM) {
    jobs.push(
      loadBdlPois(bounds, controller.signal).then(
        ({ items, errors }) => {
          if (id !== serial) return;
          bdlPois = items;
          if (errors.length) { failed = true; notes.push(`Punkty BDL: ${errors.join(" | ")}`); }
          renderPois();
        },
        (e) => {
          if (id !== serial) return;
          bdlPois = [];
          failed = true;
          notes.push(`Punkty BDL: ${errText(e)}`);
        }
      )
    );

    jobs.push(
      loadOsm(bounds, controller.signal).then(
        ({ items, endpoint, tried }) => {
          if (id !== serial) return;
          osmPois = items;
          if (tried.length) notes.push(`OSM (pominięte serwery): ${tried.join(" | ")}`);
          if (endpoint) notes.push(`OSM: dane z ${endpoint}`);
          renderPois();
        },
        (e) => {
          if (id !== serial) return;
          osmPois = [];
          failed = true;
          notes.push(`OSM: ${errText(e)}`);
        }
      )
    );
  } else {
    bdlPois = [];
    osmPois = [];
    showMessage(`Przybliż do ${MIN_POI_ZOOM}+, żeby zobaczyć wiaty, paleniska i pozostałe punkty.`);
  }

  await Promise.all(jobs);
  if (id !== serial) return;

  inFlight = null;
  // Nieudane pobranie nie może zostać zapamiętane jako wczytany widok,
  // bo kolejne przesunięcia mapy odtwarzałyby pustkę z pamięci.
  loadedFor = failed ? null : { bounds, band: band(zoom) };
  const shown = renderPois();
  const ms = Math.round(performance.now() - started);
  setStatus(
    zoom >= MIN_POI_ZOOM
      ? `Obszary: ${zones.length}. BDL: ${bdlPois.length}. OSM: ${osmPois.length}. Na mapie: ${shown}. (${ms} ms)`
      : `Obszary: ${zones.length}. (${ms} ms)`
  );
  if (notes.length) setDebug(notes.join("\n"));
}

/* ---------------------------------------------------------------- BDL --- */

function loadZones(bounds, zoom, signal) {
  const offset = zoom >= 13 ? "0.00002" : zoom >= 11 ? "0.00006" : "0.0002";
  return loadBdlLayer(0, bounds, "objectid,tur_sleep_poly_id,inv_nr,nzw_ob,link", {
    signal,
    maxAllowableOffset: offset,
    geometryPrecision: "5",
    maxPages: 3,
  });
}

async function loadBdlPois(bounds, signal) {
  const results = await Promise.allSettled(
    BDL_LAYERS.map(async ([layer, kind, fields]) => {
      const features = await loadBdlLayer(layer, bounds, fields, {
        signal,
        geometryPrecision: "6",
        maxPages: 2,
      });
      return features.flatMap((f) => normalizeBdl(f, layer, kind));
    })
  );

  const items = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else errors.push(`warstwa ${BDL_LAYERS[i][0]}: ${errText(r.reason)}`);
  });
  return { items: unique(items), errors };
}

async function loadBdlLayer(layer, bounds, fields, opts) {
  const { signal, maxAllowableOffset, geometryPrecision, maxPages } = opts;
  const geometry = JSON.stringify({
    xmin: round(bounds.getWest()), ymin: round(bounds.getSouth()),
    xmax: round(bounds.getEast()), ymax: round(bounds.getNorth()),
    spatialReference: { wkid: 4326 },
  });

  const out = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      layer: String(layer), where: "1=1", geometry, geometryType: "esriGeometryEnvelope", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects", outFields: fields, returnGeometry: "true", outSR: "4326",
      geometryPrecision, resultOffset: String(offset), resultRecordCount: "1000", f: "geojson",
    });
    if (maxAllowableOffset) params.set("maxAllowableOffset", maxAllowableOffset);

    const url = `/api/bdl?${params}`;
    const data = await cached(url, () => getJson(url, signal, 20000));
    const batch = data.features || [];
    out.push(...batch);
    if (batch.length < 1000) break;
    offset += batch.length;
  }
  return out;
}

function normalizeBdl(feature, layer, kind) {
  const c = feature.geometry?.coordinates;
  if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") return [];
  const p = feature.properties || {};
  const base = {
    source: "BDL", layer, lon: c[0], lat: c[1],
    name: p.nzw_ob || null, address: p.adres || null, link: safeUrl(p.link),
  };
  const idBase = `${layer}:${p.objectid ?? c.join(",")}`;
  const out = [];
  const add = (type) => out.push({ ...base, id: `BDL:${idBase}:${type}`, type });

  if (["shelter", "campsite", "parking", "viewpoint"].includes(kind)) add(kind);
  if (kind === "rest" || kind === "other") {
    if (yes(p.wiata)) add("shelter");
    if (yes(p.palenisko)) add("firepit");
    if (yes(p.lawostoly)) add("picnic");
    if (yes(p.woda_pitna)) add("water");
    if (yes(p.toalety_tm) || yes(p.toalety_st)) add("toilets");
    if (yes(p.parking)) add("parking");
    if (kind === "rest" && !out.length) add("picnic");
  }
  return out;
}

/* ---------------------------------------------------------- OpenStreetMap */

function overpassQuery(bounds) {
  const bbox = [
    round(bounds.getSouth()), round(bounds.getWest()),
    round(bounds.getNorth()), round(bounds.getEast()),
  ].join(",");
  return `[out:json][timeout:25];
(
  nwr["amenity"="shelter"](${bbox});
  nwr["tourism"="picnic_site"](${bbox});
  nwr["leisure"="firepit"](${bbox});
);
out center;`;
}

async function loadOsm(bounds, signal) {
  const area = (bounds.getNorth() - bounds.getSouth()) * (bounds.getEast() - bounds.getWest());
  if (area > MAX_OSM_AREA) {
    throw new Error("obszar zbyt duży dla Overpass - przybliż mapę");
  }

  const q = overpassQuery(bounds);
  const key = `osm:${q}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return { items: hit.data, endpoint: "cache", tried: [] };
  }

  const order = [
    ...(overpassPreferred ? [overpassPreferred] : []),
    ...OVERPASS_ENDPOINTS.filter((u) => u !== overpassPreferred),
  ];
  const tried = [];

  for (const url of order) {
    try {
      const data = await postForm(url, { data: q }, signal, 20000);
      // HTTP 200 z zerem elementów to poprawna odpowiedź, a nie awaria -
      // nie wolno przez nią przechodzić do kolejnych serwerów.
      const items = unique((data.elements || []).map(normalizeOsm).filter(Boolean));
      cacheSet(key, items);
      rememberEndpoint(url);
      return { items, endpoint: url, tried };
    } catch (e) {
      if (signal?.aborted) throw e;
      tried.push(`${url}: ${errText(e)}`);
      if (overpassPreferred === url) overpassPreferred = null;
    }
  }

  throw new Error(`żaden serwer Overpass nie odpowiedział\n${tried.join("\n")}`);
}

function normalizeOsm(e) {
  const t = e.tags || {};
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  let type = null;
  if (t.leisure === "firepit") type = "firepit";
  else if (t.amenity === "shelter") type = "shelter";
  else if (t.tourism === "picnic_site") type = "picnic";
  if (!type) return null;

  const bus =
    t.shelter_type === "public_transport" ||
    Boolean(t.public_transport) ||
    t.highway === "bus_stop";

  return {
    id: `OSM:${e.type}/${e.id}`, source: "OSM", osmType: e.type, osmId: e.id,
    lat, lon, type, bus, name: t.name || null,
    tagLine: [t.amenity && `amenity=${t.amenity}`, t.tourism && `tourism=${t.tourism}`, t.leisure && `leisure=${t.leisure}`]
      .filter(Boolean).join(", "),
  };
}

/* ------------------------------------------------------------ rendering --- */

function renderPois() {
  poiLayer.clearLayers();

  const showBdl = $("#src-bdl").checked;
  const showOsm = $("#src-osm").checked;
  const onlyZone = $("#only-zone").checked;
  const hideBus = $("#hide-bus").checked;

  const list = [...bdlPois, ...osmPois]
    .filter((p) => enabled.has(p.type))
    .filter((p) => (p.source === "BDL" ? showBdl : showOsm))
    .filter((p) => !(hideBus && p.source === "OSM" && p.bus));

  for (const p of list) p.inZone = insideZone(p.lon, p.lat);

  const visible = onlyZone ? list.filter((p) => p.inZone) : list;
  const capped = visible.slice(0, MAX_MARKERS);
  fanOut(capped);

  for (const p of capped) poiLayer.addLayer(buildMarker(p));

  if (visible.length > capped.length) {
    showMessage(`Pokazuję ${capped.length} z ${visible.length} punktów. Przybliż, żeby zobaczyć resztę.`);
  }

  updateCounts(capped.length);
  return capped.length;
}

function buildMarker(p) {
  const [label, emoji] = TYPES[p.type];
  const badge = p.source === "BDL" ? "LP" : "OSM";
  const cls = p.source === "BDL" ? "marker-bdl" : "marker-osm";
  const [dx, dy] = p.offset || [0, 0];

  const icon = L.divIcon({
    className: "poi-marker",
    html: `<div class="poi-marker-inner ${cls}${p.inZone ? " in-zone" : ""}"><span>${emoji}</span><small>${badge}</small></div>`,
    iconSize: [42, 42],
    iconAnchor: [21 - dx, 21 - dy],
  });

  const marker = L.marker([p.lat, p.lon], { icon, riseOnHover: true });

  let link = "";
  if (p.source === "OSM") {
    link = `<a target="_blank" rel="noreferrer" href="https://www.openstreetmap.org/${p.osmType}/${p.osmId}">Otwórz w OSM</a>`;
  } else if (p.link) {
    link = `<a target="_blank" rel="noreferrer" href="${esc(p.link)}">Informacje BDL</a>`;
  }

  marker.bindPopup(
    `<div class="popup">` +
      `<strong>${emoji} ${esc(p.name || label)}</strong>` +
      `<div>${esc(label)}</div>` +
      `<div class="popup-source ${p.source === "BDL" ? "source-bdl" : "source-osm"}">Źródło: ${p.source === "BDL" ? "Bank Danych o Lasach (LP)" : "OpenStreetMap"}</div>` +
      (p.tagLine ? `<div class="popup-tags">${esc(p.tagLine)}</div>` : "") +
      (p.address ? `<div>${esc(p.address)}</div>` : "") +
      `<div class="popup-zone">${p.inZone ? "✅ w obszarze Zanocuj w lesie" : "➖ poza obszarem Zanocuj w lesie"}</div>` +
      link +
    `</div>`
  );
  return marker;
}

// Markery z BDL i OSM opisujące to samo miejsce muszą zostać oba widoczne,
// więc pokrywające się punkty rozsuwamy po okręgu.
function fanOut(list) {
  const groups = new Map();
  for (const p of list) {
    p.offset = [0, 0];
    const key = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    const g = groups.get(key);
    g ? g.push(p) : groups.set(key, [p]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const r = g.length === 2 ? 24 : 22 + g.length * 3;
    g.forEach((p, i) => {
      const a = (2 * Math.PI * i) / g.length - Math.PI / 2;
      p.offset = [Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)];
    });
  }
}

function insideZone(lon, lat) {
  if (!zones.length) return false;
  const p = point([lon, lat]);
  for (let i = 0; i < zones.length; i++) {
    const b = zoneBoxes[i];
    if (!b || lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    try {
      if (booleanPointInPolygon(p, zones[i])) return true;
    } catch {
      /* pomijamy uszkodzoną geometrię */
    }
  }
  return false;
}

function updateCounts(shown = null) {
  $("#zones").textContent = zones.length;
  $("#bdl").textContent = bdlPois.length;
  $("#osm").textContent = osmPois.length;
  if (shown !== null) $("#shown").textContent = shown;
}

/* ---------------------------------------------------------------- utils --- */

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  const data = await fn();
  cacheSet(key, data);
  return data;
}

function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { ts: Date.now(), data });
}

async function getJson(url, signal, ms) {
  const r = await fetchWithTimeout(url, {}, signal, ms);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function postForm(url, body, signal, ms) {
  const r = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams(body),
  }, signal, ms);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchWithTimeout(url, options, signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`przekroczono ${ms} ms`)), ms);
  const forward = () => ctrl.abort(signal.reason);

  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", forward, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forward);
  }
}

function abortInFlight() {
  if (inFlight) inFlight.abort();
  inFlight = null;
}

function resetData() {
  zones = []; zoneBoxes = []; bdlPois = []; osmPois = []; loadedFor = null;
}

function band(zoom) {
  return zoom >= MIN_POI_ZOOM ? "poi" : "zones";
}

function padBounds(b, f) {
  const dLat = (b.getNorth() - b.getSouth()) * f;
  const dLon = (b.getEast() - b.getWest()) * f;
  return L.latLngBounds(
    [b.getSouth() - dLat, b.getWest() - dLon],
    [b.getNorth() + dLat, b.getEast() + dLon]
  );
}

function featureBbox(f) {
  const g = f?.geometry;
  if (!g?.coordinates) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
      return;
    }
    for (const part of c) walk(part);
  };
  walk(g.coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

function readPreferredEndpoint() {
  try {
    const v = localStorage.getItem("overpass-endpoint");
    return OVERPASS_ENDPOINTS.includes(v) ? v : null;
  } catch { return null; }
}

function rememberEndpoint(url) {
  overpassPreferred = url;
  try { localStorage.setItem("overpass-endpoint", url); } catch { /* prywatny tryb */ }
}

// Zaokrąglenie bboxa stabilizuje klucze cache przy drobnych ruchach mapy.
function round(v) { return Math.round(v * 10000) / 10000; }
function unique(items) { const seen = new Set(); return items.filter((x) => !seen.has(x.id) && seen.add(x.id)); }
function yes(v) { return v === true || v === 1 || (typeof v === "string" && ["t","tak","y","yes","1","true"].includes(v.trim().toLowerCase())); }
function esc(v) { return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function safeUrl(v) { try { const u = new URL(v); return ["http:","https:"].includes(u.protocol) ? u.toString() : null; } catch { return null; } }
function errText(e) { return e instanceof Error ? e.message : String(e); }
function setStatus(s) { statusEl.textContent = s; }
function showMessage(s) { messageEl.textContent = s; messageEl.classList.remove("hidden"); }
function hideMessage() { messageEl.classList.add("hidden"); }
function clearDebug() { debugEl.textContent = ""; debugWrap.classList.add("hidden"); }
function setDebug(e) { debugEl.textContent = errText(e); debugWrap.classList.remove("hidden"); }
