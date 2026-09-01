import "leaflet/dist/leaflet.css";
import "./style.css";
import L from "leaflet";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";

const MIN_ZONE_ZOOM = 8;
const MIN_POI_ZOOM = 11;

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
    <div class="brand"><div class="brand-badge">🌲</div><div><h1>Zanocuj w lesie</h1><p>Oficjalne dane BDL + OpenStreetMap.</p></div></div>
    <section class="panel"><h2>Pokaż na mapie</h2><div id="filters" class="filters"></div></section>
    <section class="panel stats-panel">
      <div class="stat-row"><span>Obszary w widoku</span><strong id="zones">0</strong></div>
      <div class="stat-row"><span>Punkty BDL</span><strong id="bdl">0</strong></div>
      <div class="stat-row"><span>Punkty OSM</span><strong id="osm">0</strong></div>
      <div class="stat-row"><span>Pokazane markery</span><strong id="shown">0</strong></div>
    </section>
    <section class="panel"><h2>Źródła</h2>
      <label class="source-filter"><input id="src-bdl" type="checkbox" checked> BDL / Lasy Państwowe</label>
      <label class="source-filter"><input id="src-osm" type="checkbox" checked> OpenStreetMap</label>
    </section>
    <section class="panel info-panel"><h2>Status</h2><p id="status">Przybliż mapę.</p><details id="debug-wrap" class="debug hidden"><summary>Szczegóły</summary><pre id="debug"></pre></details></section>
    <section class="panel warning-panel"><strong>Uwaga o ogniu</strong><p>Marker paleniska nie oznacza automatycznie, że danego dnia wolno rozpalić ogień. Sprawdź zasady nadleśnictwa.</p></section>
  </aside>
  <main class="map-wrap"><div id="map"></div><div id="map-message" class="map-message"></div></main>
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
$("#src-bdl").addEventListener("change", renderPois);
$("#src-osm").addEventListener("change", renderPois);

const map = L.map("map", { preferCanvas: true }).setView([52, 19.2], 7);
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

let zones = [];
let bdlPois = [];
let osmRaw = [];
let osmPois = [];
let serial = 0;
let timer;

map.on("moveend zoomend", schedule);
schedule();

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(refresh, 350);
}

async function refresh() {
  const zoom = map.getZoom();
  if (zoom < MIN_ZONE_ZOOM) {
    serial++;
    zones = []; bdlPois = []; osmRaw = []; osmPois = [];
    zoneLayer.clearLayers(); poiLayer.clearLayers(); updateCounts();
    setStatus(`Przybliż mapę do zoomu ${MIN_ZONE_ZOOM}.`);
    showMessage(`Zoom ${MIN_ZONE_ZOOM}+ pokaże obszary Zanocuj w lesie.`);
    return;
  }

  const id = ++serial;
  const bounds = map.getBounds();
  clearDebug(); hideMessage(); setStatus("Pobieram obszary BDL...");

  try {
    zones = await loadBdl(0, bounds, "objectid,tur_sleep_poly_id,inv_nr,nzw_ob,link", true);
    if (id !== serial) return;
    zoneLayer.clearLayers();
    zoneLayer.addData({ type: "FeatureCollection", features: zones });
    updateCounts();

    if (zoom < MIN_POI_ZOOM) {
      bdlPois = []; osmRaw = []; osmPois = []; renderPois();
      setStatus(`Wczytano ${zones.length} obszarów. Zoom ${MIN_POI_ZOOM}+ wczyta infrastrukturę.`);
      showMessage(`Przybliż do ${MIN_POI_ZOOM}+, żeby zobaczyć wiaty, paleniska i pozostałe POI.`);
      return;
    }

    setStatus("Pobieram punkty BDL i OSM...");
    const [bdlResult, osmResult] = await Promise.allSettled([loadAllBdlPois(bounds), loadOsm(bounds)]);
    if (id !== serial) return;

    const errors = [];
    if (bdlResult.status === "fulfilled") bdlPois = bdlResult.value.filter(insideZone);
    else { bdlPois = []; errors.push(`BDL POI: ${errText(bdlResult.reason)}`); }

    if (osmResult.status === "fulfilled") {
      osmRaw = osmResult.value;
      osmPois = osmRaw;
    } else {
      osmRaw = [];
      osmPois = [];
      errors.push(`OSM: ${errText(osmResult.reason)}`);
    }

    renderPois();
    setStatus(`Obszary: ${zones.length}. BDL: ${bdlPois.length}. OSM: ${osmPois.length}.`);
    if (errors.length) setDebug(errors.join("\n\n"));
    else if (!osmRaw.length) setDebug("Overpass zwrócił 0 obiektów dla aktualnego widoku mapy.");
  } catch (e) {
    if (id !== serial) return;
    zones = []; bdlPois = []; osmRaw = []; osmPois = [];
    zoneLayer.clearLayers(); poiLayer.clearLayers(); updateCounts();
    setStatus("Nie udało się pobrać danych dla tego widoku.");
    setDebug(e);
  }
}

async function loadAllBdlPois(bounds) {
  const batches = await Promise.all(BDL_LAYERS.map(async ([layer, kind, fields]) => {
    const features = await loadBdl(layer, bounds, fields, false);
    return features.flatMap((f) => normalizeBdl(f, layer, kind));
  }));
  return unique(batches.flat());
}

async function loadBdl(layer, bounds, fields, polygon) {
  const geometry = JSON.stringify({
    xmin: bounds.getWest(), ymin: bounds.getSouth(), xmax: bounds.getEast(), ymax: bounds.getNorth(),
    spatialReference: { wkid: 4326 },
  });
  const out = [];
  let offset = 0;

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      layer: String(layer), where: "1=1", geometry, geometryType: "esriGeometryEnvelope", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects", outFields: fields, returnGeometry: "true", outSR: "4326",
      geometryPrecision: polygon ? "5" : "6", resultOffset: String(offset), resultRecordCount: "500", f: "geojson",
    });
    if (polygon) params.set("maxAllowableOffset", "0.00002");
    const r = await fetch(`/api/bdl?${params}`);
    if (!r.ok) throw new Error(`BDL layer ${layer}: HTTP ${r.status} ${await r.text()}`);
    const data = await r.json();
    const batch = data.features || [];
    out.push(...batch);
    if (batch.length < 500) break;
    offset += batch.length;
  }
  return out;
}

function normalizeBdl(feature, layer, kind) {
  const c = feature.geometry?.coordinates;
  if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") return [];
  const p = feature.properties || {};
  const base = { source: "BDL", layer, idBase: `${layer}:${p.objectid ?? c.join(",")}`, lon: c[0], lat: c[1], name: p.nzw_ob || null, address: p.adres || null, link: safeUrl(p.link) };
  const out = [];
  const add = (type) => out.push({ ...base, id: `BDL:${base.idBase}:${type}`, type });

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

async function loadOsm(bounds) {
  const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()].join(",");
  const q = `
[out:json][timeout:30];
(
  nwr["amenity"="shelter"](${bbox});
  nwr["tourism"="picnic_site"](${bbox});
  nwr["leisure"="firepit"](${bbox});
);
out center tags;
  `.trim();

  const attempts = [
    ["https://overpass.private.coffee/api/interpreter", false],
    ["/api/osm", true],
    ["https://overpass-api.de/api/interpreter", false],
  ];
  const errors = [];

  for (const [url] of attempts) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 28000);
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: q }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!r.ok) {
        errors.push(`${url}: HTTP ${r.status}`);
        continue;
      }

      const data = await r.json();
      const items = unique((data.elements || []).map(normalizeOsm).filter(Boolean));
      if (items.length) return items;
      errors.push(`${url}: 0 wyników`);
    } catch (e) {
      errors.push(`${url}: ${errText(e)}`);
    }
  }

  if (errors.length) throw new Error(errors.join("\n"));
  return [];
}

function normalizeOsm(e) {
  const t = e.tags || {};
  if (t.amenity === "shelter" && (t.shelter_type === "public_transport" || t.public_transport || t.highway === "bus_stop")) return null;
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  let type = null;
  if (t.leisure === "firepit") type = "firepit";
  else if (t.amenity === "shelter") type = "shelter";
  else if (t.tourism === "picnic_site") type = "picnic";
  if (!type) return null;

  return { id: `OSM:${e.type}/${e.id}`, source: "OSM", osmType: e.type, osmId: e.id, lat, lon, type, name: t.name || null };
}

function insideZone(poi) {
  const p = point([poi.lon, poi.lat]);
  return zones.some((z) => {
    try { return booleanPointInPolygon(p, z); }
    catch { return false; }
  });
}

function renderPois() {
  poiLayer.clearLayers();
  const showBdl = $("#src-bdl").checked;
  const showOsm = $("#src-osm").checked;
  const list = [...bdlPois, ...osmPois].filter((p) => enabled.has(p.type) && ((p.source === "BDL" && showBdl) || (p.source === "OSM" && showOsm)));

  for (const p of list) {
    const [label, emoji] = TYPES[p.type];
    const badge = p.source === "BDL" ? "LP" : "OSM";
    const cls = p.source === "BDL" ? "marker-bdl" : "marker-osm";
    const icon = L.divIcon({ className: "poi-marker", html: `<div class="poi-marker-inner ${cls}"><span>${emoji}</span><small>${badge}</small></div>`, iconSize: [42, 42], iconAnchor: [21, 21] });
    const marker = L.marker([p.lat, p.lon], { icon });
    let link = "";
    if (p.source === "OSM") link = `<a target="_blank" rel="noreferrer" href="https://www.openstreetmap.org/${p.osmType}/${p.osmId}">Otwórz w OSM</a>`;
    else if (p.link) link = `<a target="_blank" rel="noreferrer" href="${esc(p.link)}">Informacje BDL</a>`;
    marker.bindPopup(`<div class="popup"><strong>${emoji} ${esc(p.name || label)}</strong><div>${esc(label)}</div><div class="popup-source ${p.source === "BDL" ? "source-bdl" : ""}">Źródło: ${p.source === "BDL" ? "Bank Danych o Lasach" : "OpenStreetMap"}</div>${p.address ? `<div>${esc(p.address)}</div>` : ""}${link}</div>`);
    marker.addTo(poiLayer);
  }
  updateCounts(list.length);
}

function updateCounts(shown = null) {
  $("#zones").textContent = zones.length;
  $("#bdl").textContent = bdlPois.length;
  $("#osm").textContent = osmPois.length;
  $("#shown").textContent = shown ?? [...bdlPois, ...osmPois].length;
}

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
