import "leaflet/dist/leaflet.css";
import "./style.css";

import L from "leaflet";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";

const MIN_ZONE_ZOOM = 8;
const MIN_POI_ZOOM = 11;
const BDL_PAGE_SIZE = 250;
const MAX_BDL_PAGES = 20;

const POI_TYPES = {
  shelter: { label: "Wiaty", icon: "🛖" },
  firepit: { label: "Paleniska", icon: "🔥" },
  picnic: { label: "Miejsca piknikowe", icon: "🪑" },
  water: { label: "Woda pitna", icon: "💧" },
  toilets: { label: "Toalety", icon: "🚻" },
  campsite: { label: "Miejsca biwakowe", icon: "⛺" },
};

document.querySelector("#app").innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-badge">🌲</div>
        <div>
          <h1>Zanocuj w lesie</h1>
          <p>OSM + oficjalne obszary programu z Banku Danych o Lasach.</p>
        </div>
      </div>

      <section class="panel">
        <h2>Pokaż na mapie</h2>
        <div id="filters" class="filters"></div>
      </section>

      <section class="panel stats-panel">
        <div class="stat-row">
          <span>Obszary w widoku</span>
          <strong id="zone-count">0</strong>
        </div>
        <div class="stat-row">
          <span>POI w programie</span>
          <strong id="poi-count">0</strong>
        </div>
      </section>

      <section class="panel info-panel">
        <h2>Status</h2>
        <p id="status">Przybliż mapę, żeby wczytać obszary.</p>
        <details id="debug-wrap" class="debug hidden">
          <summary>Szczegóły błędu</summary>
          <pre id="debug"></pre>
        </details>
      </section>

      <section class="panel official-panel">
        <strong>BDL ma też własne informacje o infrastrukturze</strong>
        <p>
          Po kliknięciu obszaru zobaczysz m.in. czy BDL oznaczył dla niego wiatę,
          palenisko, ławostoły lub toalety.
        </p>
      </section>

      <section class="panel warning-panel">
        <strong>Uwaga o ogniu</strong>
        <p>
          Punkt firepit w OSM nie jest automatycznym potwierdzeniem, że obecnie
          wolno tam rozpalać ogień. Sprawdź regulamin i komunikaty nadleśnictwa.
        </p>
      </section>

      <footer>
        Obszary: Bank Danych o Lasach. POI i podkład: OpenStreetMap.
      </footer>
    </aside>

    <main class="map-wrap">
      <div id="map"></div>
      <div id="map-message" class="map-message"></div>
    </main>
  </div>
`;

const filtersEl = document.querySelector("#filters");
const statusEl = document.querySelector("#status");
const zoneCountEl = document.querySelector("#zone-count");
const poiCountEl = document.querySelector("#poi-count");
const mapMessageEl = document.querySelector("#map-message");
const debugWrapEl = document.querySelector("#debug-wrap");
const debugEl = document.querySelector("#debug");

const enabledTypes = new Set(Object.keys(POI_TYPES));

for (const [type, config] of Object.entries(POI_TYPES)) {
  const label = document.createElement("label");
  label.className = "filter";
  label.innerHTML = `
    <input type="checkbox" data-type="${type}" checked />
    <span class="filter-icon">${config.icon}</span>
    <span>${config.label}</span>
  `;
  filtersEl.appendChild(label);
}

filtersEl.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[type=checkbox]");
  if (!checkbox) return;

  checkbox.checked
    ? enabledTypes.add(checkbox.dataset.type)
    : enabledTypes.delete(checkbox.dataset.type);

  renderPois();
});

const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true,
}).setView([52.0, 19.2], 7);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
}).addTo(map);

const zonesLayer = L.geoJSON(null, {
  style: {
    color: "#236b3d",
    weight: 1,
    fillColor: "#6bbf78",
    fillOpacity: 0.25,
  },
  onEachFeature(feature, layer) {
    const props = feature.properties || {};
    const title = props.nzw_ob || props.inv_nr || "Zanocuj w lesie";
    const link = safeHttpUrl(props.link);

    const amenities = [
      flagLine("🛖", "Wiata", props.wiata),
      flagLine("🔥", "Palenisko", props.palenisko),
      flagLine("🪑", "Ławostoły", props.lawostoly),
      flagLine("🚻", "Toalety", props.toalety_tm),
      flagLine("🍳", "Kuchenka", props.kuchenka),
    ].filter(Boolean).join("");

    layer.bindPopup(`
      <div class="popup">
        <strong>${escapeHtml(title)}</strong>
        ${props.inv_nr ? `<div>Nr: ${escapeHtml(props.inv_nr)}</div>` : ""}
        ${amenities ? `<div class="amenities">${amenities}</div>` : ""}
        ${
          link
            ? `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">Informacje BDL</a>`
            : ""
        }
      </div>
    `);
  },
}).addTo(map);

const poiLayer = L.layerGroup().addTo(map);

let zones = [];
let visiblePois = [];
let requestSerial = 0;
let debounceTimer = null;

map.on("moveend zoomend", scheduleRefresh);
scheduleRefresh();

function scheduleRefresh() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(refreshView, 350);
}

async function refreshView() {
  const zoom = map.getZoom();

  if (zoom < MIN_ZONE_ZOOM) {
    requestSerial++;
    zones = [];
    visiblePois = [];
    zonesLayer.clearLayers();
    poiLayer.clearLayers();
    zoneCountEl.textContent = "0";
    poiCountEl.textContent = "0";
    statusEl.textContent = "Przybliż mapę, żeby wczytać obszary Zanocuj w lesie.";
    showMapMessage(`Przybliż mapę do poziomu ${MIN_ZONE_ZOOM}, żeby zobaczyć obszary programu.`);
    clearDebug();
    return;
  }

  const serial = ++requestSerial;
  const bounds = map.getBounds();

  hideMapMessage();
  clearDebug();
  statusEl.textContent = "Pobieram obszary Zanocuj w lesie z BDL...";

  try {
    const newZones = await loadZonesForBounds(bounds);

    if (serial !== requestSerial) return;

    zones = newZones;
    zonesLayer.clearLayers();
    zonesLayer.addData({
      type: "FeatureCollection",
      features: zones,
    });

    zoneCountEl.textContent = String(zones.length);

    if (zoom < MIN_POI_ZOOM) {
      visiblePois = [];
      renderPois();
      statusEl.textContent = `Wczytano ${zones.length} obszarów. Przybliż jeszcze, żeby wyszukać wiaty i pozostałe POI z OSM.`;
      showMapMessage(`Obszary BDL są widoczne. Zoom ${MIN_POI_ZOOM}+ uruchamia wyszukiwanie infrastruktury OSM.`);
      return;
    }

    hideMapMessage();
    statusEl.textContent = "Szukam infrastruktury OSM w tych obszarach...";

    const pois = await loadPoisForBounds(bounds);

    if (serial !== requestSerial) return;

    visiblePois = dedupePois(
      pois.filter((poi) => poi.type).filter(isPoiInsideAnyZone)
    );
    renderPois();

    statusEl.textContent =
      zones.length === 0
        ? "W aktualnym widoku nie znaleziono obszarów Zanocuj w lesie."
        : `Wczytano ${zones.length} obszarów i ${visiblePois.length} obiektów OSM znajdujących się w ich granicach.`;
  } catch (error) {
    console.error(error);

    if (serial !== requestSerial) return;

    zones = [];
    visiblePois = [];
    zonesLayer.clearLayers();
    poiLayer.clearLayers();
    zoneCountEl.textContent = "0";
    poiCountEl.textContent = "0";

    statusEl.textContent = "Nie udało się pobrać danych dla tego widoku.";
    setDebug(error);
  }
}

async function loadZonesForBounds(bounds) {
  const south = bounds.getSouth();
  const west = bounds.getWest();
  const north = bounds.getNorth();
  const east = bounds.getEast();

  const geometry = JSON.stringify({
    xmin: west,
    ymin: south,
    xmax: east,
    ymax: north,
    spatialReference: { wkid: 4326 },
  });

  const all = [];
  let offset = 0;

  for (let page = 0; page < MAX_BDL_PAGES; page++) {
    const params = new URLSearchParams({
      where: "1=1",
      geometry,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields:
        "objectid,foreign_key,tur_sleep_poly_id,inv_nr,nzw_ob,link,wiata,lawostoly,palenisko,toalety_tm,kuchenka,uwagi",
      returnGeometry: "true",
      outSR: "4326",
      maxAllowableOffset: "0.00002",
      geometryPrecision: "5",
      resultOffset: String(offset),
      resultRecordCount: String(BDL_PAGE_SIZE),
      f: "geojson",
    });

    const response = await fetch(`/api/bdl?${params.toString()}`);

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(`BDL HTTP ${response.status}: ${body}`);
    }

    const collection = await response.json();

    if (collection?.error) {
      throw new Error(`BDL: ${JSON.stringify(collection.error)}`);
    }

    const batch = collection.features || [];
    all.push(...batch);

    if (batch.length < BDL_PAGE_SIZE) break;

    offset += batch.length;
  }

  return dedupeFeatures(all);
}

async function loadPoisForBounds(bounds) {
  const south = bounds.getSouth();
  const west = bounds.getWest();
  const north = bounds.getNorth();
  const east = bounds.getEast();
  const bbox = [south, west, north, east].join(",");

  const query = buildOverpassQuery(bbox);

  const response = await fetch("/api/osm", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: new URLSearchParams({ data: query }),
  });

  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(`Overpass HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();

  return (data.elements || [])
    .map(normalizeOsmElement)
    .filter(Boolean);
}

function buildOverpassQuery(bbox) {
  return `
[out:json][timeout:20];
(
  nwr["amenity"="shelter"](${bbox});
  nwr["leisure"="firepit"](${bbox});
  nwr["fireplace"="yes"](${bbox});
  nwr["tourism"="picnic_site"](${bbox});
  nwr["leisure"="picnic_table"](${bbox});
  nwr["amenity"="drinking_water"](${bbox});
  nwr["amenity"="toilets"](${bbox});
  nwr["tourism"="camp_site"](${bbox});
);
out center tags;
  `.trim();
}

function normalizeOsmElement(element) {
  const tags = element.tags || {};

  if (
    tags.amenity === "shelter" &&
    (tags.shelter_type === "public_transport" ||
      tags.public_transport ||
      tags.highway === "bus_stop")
  ) {
    return null;
  }

  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;

  if (typeof lat !== "number" || typeof lon !== "number") return null;

  return {
    id: `${element.type}/${element.id}`,
    osmType: element.type,
    osmId: element.id,
    lat,
    lon,
    type: classifyPoi(tags),
    name: tags.name || null,
    tags,
  };
}

function classifyPoi(tags) {
  if (tags.leisure === "firepit" || tags.fireplace === "yes") return "firepit";
  if (tags.amenity === "shelter") return "shelter";
  if (tags.tourism === "picnic_site" || tags.leisure === "picnic_table") return "picnic";
  if (tags.amenity === "drinking_water") return "water";
  if (tags.amenity === "toilets") return "toilets";
  if (tags.tourism === "camp_site") return "campsite";
  return null;
}

function isPoiInsideAnyZone(poi) {
  const p = point([poi.lon, poi.lat]);

  return zones.some((zone) => {
    try {
      return booleanPointInPolygon(p, zone);
    } catch {
      return false;
    }
  });
}

function dedupeFeatures(features) {
  const seen = new Set();

  return features.filter((feature) => {
    const id =
      feature.properties?.objectid ??
      feature.properties?.tur_sleep_poly_id ??
      JSON.stringify(feature.geometry).slice(0, 120);

    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function dedupePois(pois) {
  const seen = new Set();

  return pois.filter((poi) => {
    const key = `${poi.type}:${poi.osmType}:${poi.osmId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderPois() {
  poiLayer.clearLayers();

  const filtered = visiblePois.filter((poi) => enabledTypes.has(poi.type));
  poiCountEl.textContent = String(filtered.length);

  for (const poi of filtered) {
    const config = POI_TYPES[poi.type];

    const icon = L.divIcon({
      className: "poi-marker",
      html: `<div class="poi-marker-inner" title="${escapeHtml(config.label)}">${config.icon}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -18],
    });

    const marker = L.marker([poi.lat, poi.lon], { icon });
    const osmUrl = `https://www.openstreetmap.org/${poi.osmType}/${poi.osmId}`;
    const name = poi.name || singularLabel(poi.type);

    marker.bindPopup(`
      <div class="popup">
        <strong>${config.icon} ${escapeHtml(name)}</strong>
        <div>${escapeHtml(config.label)}</div>
        <div class="popup-source">Źródło: OpenStreetMap</div>
        <a href="${osmUrl}" target="_blank" rel="noreferrer">Otwórz obiekt w OSM</a>
      </div>
    `);

    marker.addTo(poiLayer);
  }
}

function flagLine(icon, label, value) {
  if (!isPositiveFlag(value)) return "";
  return `<div>${icon} ${escapeHtml(label)} - BDL</div>`;
}

function isPositiveFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;

  return ["t", "tak", "y", "yes", "1"].includes(value.trim().toLowerCase());
}

function singularLabel(type) {
  return {
    shelter: "Wiata",
    firepit: "Palenisko",
    picnic: "Miejsce piknikowe",
    water: "Woda pitna",
    toilets: "Toaleta",
    campsite: "Miejsce biwakowe",
  }[type] || "Obiekt";
}

function showMapMessage(message) {
  mapMessageEl.textContent = message;
  mapMessageEl.classList.remove("hidden");
}

function hideMapMessage() {
  mapMessageEl.classList.add("hidden");
}

function clearDebug() {
  debugEl.textContent = "";
  debugWrapEl.classList.add("hidden");
}

function setDebug(error) {
  debugEl.textContent =
    error instanceof Error ? error.message : String(error);
  debugWrapEl.classList.remove("hidden");
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    return text.slice(0, 800);
  } catch {
    return "brak treści błędu";
  }
}

function safeHttpUrl(value) {
  if (!value || typeof value !== "string") return null;

  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    return null;
  }

  return null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
