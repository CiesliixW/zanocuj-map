import "leaflet/dist/leaflet.css";
import "./style.css";
import L from "leaflet";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";

const MIN_ZONE_ZOOM = 7;
const MIN_POI_ZOOM = 10;
const MIN_TRAIL_ZOOM = 11;
const PAD = 0.35;
const HEDGE_MS = 3500;
const OSM_TIMEOUT = 25000;
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 80;
const DEBOUNCE = 250;
// Margines pobierania zwężamy tak, żeby bbox dla Overpass zmieścił się w
// SOFT; dopiero sam widok większy niż HARD jest odrzucany. Przy MIN_POI_ZOOM
// nie zdarza się to na żadnym realnym ekranie.
const SOFT_OSM_AREA = 6;
const HARD_OSM_AREA = 25;
const MAX_MARKERS = 900;
const LIST_MAX = 200;

// Warstwy liniowe BDL. Schematu pól nie znamy, więc pobieramy outFields=*
// i budujemy dymek z tego, co faktycznie przyszło.
const TRAIL_LAYERS = [
  [35, "szlak", "Szlaki turystyczne", "#b45309", null],
  [34, "sciezka", "Ścieżki dydaktyczne", "#0f766e", "6 4"],
];

// Szlaki w Polsce znakuje się kolorem; jeśli warstwa niesie taki atrybut,
// linia dostaje właściwą barwę zamiast domyślnej.
const TRAIL_COLORS = {
  czerwony: "#dc2626",
  niebieski: "#2563eb",
  zielony: "#16a34a",
  zolty: "#ca8a04",
  "żółty": "#ca8a04",
  czarny: "#1f2937",
  bialy: "#6b7280",
  "biały": "#6b7280",
};

// Zrzut całej Polski leży na tej samej domenie co aplikacja, więc nie zależy
// od dostępności ani limitów luster Overpass. Overpass zostaje wyłącznie jako
// awaryjne źródło, gdy zrzutu nie ma.
const SNAPSHOT_URL = "/osm-poland.json";

const SNAPSHOT_TAGS = {
  shelter: "amenity=shelter",
  firepit: "leisure=firepit",
  picnic: "tourism=picnic_site",
};

const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
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

const AMENITY_FIELDS =
  "objectid,nzw_ob,adres,link,wiata,lawostoly,palenisko,parking,toalety_tm,toalety_st,woda_pitna,kuchenka";
const BASIC_FIELDS = "objectid,nzw_ob,adres,link";

// [warstwa, typ filtru, pola, nazwa warstwy do dymka]
// Czwarta kolumna jest po to, że kilka warstw wpada pod jeden filtr: pod
// "Miejsca biwakowe" idą cztery różne rodzaje obiektów i w dymku ma być
// widać, który to konkretnie.
const BDL_LAYERS = [
  [15, "rest", AMENITY_FIELDS, "Miejsce wypoczynku"],
  [5, "shelter", BASIC_FIELDS, "Schronisko leśne"],
  [6, "campsite", BASIC_FIELDS, "Miejsce biwakowania"],
  [8, "campsite", BASIC_FIELDS, "Pole biwakowe"],
  [10, "campsite", BASIC_FIELDS, "Kemping"],
  [12, "campsite", BASIC_FIELDS, "Obozowisko harcerskie"],
  [17, "parking", BASIC_FIELDS, "Parking leśny"],
  [19, "parking", BASIC_FIELDS, "Miejsce postoju pojazdów"],
  [25, "viewpoint", BASIC_FIELDS, "Punkt widokowy"],
  // Warstwa 27 ma inny schemat niż 15 i odrzuca zapytanie o pola
  // udogodnień, więc pobieramy komplet zamiast zgadywać.
  [27, "other", "*", "Obiekt rekreacyjny"],
];

document.querySelector("#app").innerHTML = `
<div class="layout">
  <aside class="sidebar">
    <header class="rail-head">
      <h1>Zanocuj w lesie</h1>
      <p class="rail-sub">Lasy Państwowe · OpenStreetMap</p>
    </header>

    <section class="rail-section">
      <label class="field-label" for="search">Szukaj miejsca</label>
      <div class="input-row">
        <input id="search" type="search" placeholder="Miasto lub gmina" autocomplete="off">
        <button id="search-go" class="btn btn-secondary" type="button">Szukaj</button>
      </div>
      <ul id="search-results" class="option-list hidden"></ul>
      <p id="search-note" class="note hidden"></p>
    </section>

    <section class="rail-section">
      <h2 class="rail-label">Rodzaje miejsc</h2>
      <div id="filters" class="check-list"></div>
    </section>

    <section class="rail-section">
      <h2 class="rail-label">Źródła i zakres</h2>
      <div class="check-list">
        <label class="check"><input id="src-bdl" type="checkbox" checked><span class="glyph-dot dot-bdl"></span><span>BDL / Lasy Państwowe</span></label>
        <label class="check"><input id="src-osm" type="checkbox"><span class="glyph-dot dot-osm"></span><span>OpenStreetMap</span></label>
        <label class="check check-wide"><input id="only-zone" type="checkbox" checked><span>Tylko w obszarach programu</span></label>
        <label class="check check-wide"><input id="hide-bus" type="checkbox"><span>Bez wiat przystankowych</span></label>
      </div>
      <p class="note note-rule">Punkty z obu baz są niezależne. Gdy opisują to samo miejsce, markery rozsuwają się, żeby oba dało się kliknąć.</p>
    </section>

    <section class="rail-section">
      <h2 class="rail-label">Warstwy liniowe</h2>
      <div class="check-list">
        <label class="check"><input id="trail-35" type="checkbox" data-trail="35"><span class="glyph-dash dash-szlak"></span><span>Szlaki turystyczne</span></label>
        <label class="check"><input id="trail-34" type="checkbox" data-trail="34"><span class="glyph-dash dash-sciezka"></span><span>Ścieżki dydaktyczne</span></label>
      </div>
    </section>

    <section class="rail-section">
      <h2 class="rail-label">W tym widoku</h2>
      <dl class="summary">
        <div><dt>Obszary programu</dt><dd id="zones">0</dd></div>
        <div><dt>Punkty BDL</dt><dd id="bdl">0</dd></div>
        <div><dt>Punkty OSM</dt><dd id="osm">0</dd></div>
        <div><dt>Markery na mapie</dt><dd id="shown">0</dd></div>
        <div><dt>Szlaki i ścieżki</dt><dd id="trails">0</dd></div>
      </dl>
    </section>

    <section class="rail-section rail-foot">
      <p id="status" class="note">Przybliż mapę.</p>
      <details id="debug-wrap" class="details hidden"><summary>Szczegóły techniczne</summary><pre id="debug"></pre></details>
      <p class="note note-rule">Marker paleniska nie oznacza, że danego dnia wolno rozpalić ogień. Sprawdź zasady nadleśnictwa.</p>
    </section>
  </aside>

  <div id="scrim" class="scrim"></div>

  <main class="map-wrap">
    <div id="map"></div>
    <div class="map-bar">
      <div class="toolbar">
        <button id="menu-toggle" class="btn btn-icon" type="button" aria-expanded="false" aria-label="Filtry i ustawienia">☰</button>
        <select id="list-type" class="control" aria-label="Czego szukać">
          <option value="">Wszystkie typy</option>
        </select>
        <select id="list-sort" class="control" aria-label="Sortowanie listy">
          <option value="center">Od środka mapy</option>
          <option value="me">Od mojej lokalizacji</option>
        </select>
        <button id="list-toggle" class="btn btn-primary" type="button" aria-expanded="false">
          Lista <span id="list-count" class="count">0</span>
        </button>
      </div>
      <div id="list-panel" class="float hidden">
        <ul id="place-list" class="place-list"></ul>
        <p id="list-note" class="list-note hidden"></p>
      </div>
    </div>
    <div id="map-message" class="map-message hidden"></div>
  </main>
</div>`;

const $ = (s) => document.querySelector(s);
const statusEl = $("#status");
const debugEl = $("#debug");
const debugWrap = $("#debug-wrap");
const messageEl = $("#map-message");
const enabled = new Set(Object.keys(TYPES));

for (const [type, [label, icon]] of Object.entries(TYPES)) {
  const el = document.createElement("label");
  el.className = "check";
  el.innerHTML =
    `<input type="checkbox" data-type="${type}" checked>` +
    `<span class="check-glyph">${icon}</span>` +
    `<span>${label}</span>` +
    `<span class="check-count" data-count="${type}">0</span>`;
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

// Szlaki wymagają pobrania z sieci, więc ich przełączenie musi unieważnić
// zapamiętany widok, a nie tylko przerysować to, co już jest w pamięci.
for (const id of ["#trail-35", "#trail-34"]) {
  $(id).addEventListener("change", () => { loadedFor = null; schedule(); });
}

/* ----------------------------------------------------------------- lista --- */

const listEl = $("#place-list");
const listNote = $("#list-note");
const listPanel = $("#list-panel");
const listToggle = $("#list-toggle");

// Selektor typów wypełniamy z tej samej definicji co filtry mapy, żeby nie
// rozjechały się przy dodaniu kolejnego typu.
for (const [type, [label, icon]] of Object.entries(TYPES)) {
  const opt = document.createElement("option");
  opt.value = type;
  opt.textContent = `${icon} ${label}`;
  $("#list-type").appendChild(opt);
}

// Pasek leży nad mapą, więc jego kliknięcia i scroll nie mogą przechodzić
// do Leafletu jako przeciąganie czy zoom.
const bar = document.querySelector(".map-bar");
L.DomEvent.disableClickPropagation(bar);
L.DomEvent.disableScrollPropagation(bar);

// Na wąskim ekranie panel boczny jest szufladą - mapa ma zostać pełnoekranowa.
const menuToggle = $("#menu-toggle");

function setMenu(open) {
  document.body.classList.toggle("menu-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
}

menuToggle.addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));

// Na wąskim pasku nie mieszczą się dwa selektory naraz i nazwa typu obcina się
// do dwóch znaków. Sortowanie jest wyborem drugorzędnym, więc na telefonie
// przenosi się do panelu listy - jeden element, bez duplikowania id.
const sortSelect = $("#list-sort");
const narrow = window.matchMedia("(max-width: 760px)");

function placeSortSelect() {
  if (narrow.matches) listPanel.prepend(sortSelect);
  else $(".toolbar").insertBefore(sortSelect, listToggle);
}

placeSortSelect();
narrow.addEventListener("change", placeSortSelect);
$("#scrim").addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });

// Wybór z listy dotyczy mapy, więc szuflada nie ma jej zasłaniać.
listEl.addEventListener("click", () => setMenu(false));

listToggle.addEventListener("click", () => {
  const open = listPanel.classList.toggle("hidden") === false;
  listToggle.setAttribute("aria-expanded", String(open));
});

$("#list-type").addEventListener("change", (e) => {
  listType = e.target.value;
  if (listType) listPanel.classList.remove("hidden");
  listToggle.setAttribute("aria-expanded", String(!listPanel.classList.contains("hidden")));
  renderPois();
});

$("#list-sort").addEventListener("change", async (e) => {
  sortMode = e.target.value;
  if (sortMode === "me" && !userPos) {
    listNote.textContent = "Pytam o lokalizację...";
    listNote.classList.remove("hidden");
    try {
      userPos = await currentPosition();
      listNote.classList.add("hidden");
    } catch (err) {
      // Bez zgody na lokalizację lista nadal ma działać, tylko od środka mapy.
      sortMode = "center";
      $("#list-sort").value = "center";
      listNote.textContent = `Nie udało się ustalić lokalizacji: ${errText(err)}. Sortuję od środka mapy.`;
      listNote.classList.remove("hidden");
    }
  }
  renderPois();
});

listEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const poi = listRows.find((r) => r.p.id === btn.dataset.id)?.p;
  if (!poi) return;

  // Przesunięcie mapy uruchamia odświeżenie, które przebudowuje markery, więc
  // sam openPopup() zostałby po chwili zamknięty. Wybór trzeba zapamiętać i
  // odtworzyć po każdym przerysowaniu.
  focusId = poi.id;
  map.setView([poi.lat, poi.lon], Math.max(map.getZoom(), 16));
  markerById.get(poi.id)?.openPopup();
});

let listRows = [];

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("przeglądarka nie udostępnia lokalizacji"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.message || "odmowa dostępu")),
      { timeout: 10000, maximumAge: 300000 }
    );
  });
}

function renderList(items) {
  // Selektor zawęża wyłącznie listę; filtry w panelu decydują o tym, co jest
  // narysowane na mapie, więc lista nigdy nie pokazuje punktu, którego na
  // mapie nie ma.
  const scoped = listType ? items.filter((p) => p.type === listType) : items;

  // Widok jest już zawężony do obszaru na ekranie, więc pozostaje uporządkować
  // go po odległości od punktu odniesienia.
  const centre = map.getCenter();
  const ref = sortMode === "me" && userPos ? userPos : { lat: centre.lat, lon: centre.lng };

  listRows = scoped
    .map((p) => ({ p, d: distanceKm(ref.lat, ref.lon, p.lat, p.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, LIST_MAX);

  $("#list-count").textContent = scoped.length;

  if (!listRows.length) {
    // W trakcie pobierania pokazujemy szkielet o układzie wiersza, żeby lista
    // nie skakała po wczytaniu; pustka to dopiero wynik zakończonego zapytania.
    listEl.innerHTML = document.body.classList.contains("loading")
      ? Array.from({ length: 3 }, () =>
          `<li class="skeleton"><span></span><span></span><span></span></li>`).join("")
      : `<li class="place-empty">${
          listType ? "Brak takich punktów w tym widoku." : "Brak punktów w tym widoku."
        }</li>`;
    return;
  }

  listEl.innerHTML = listRows
    .map(({ p, d }) => {
      const [label, emoji] = TYPES[p.type];
      const name = p.name || p.layerLabel || label;
      const badge = p.source === "BDL" ? "LP" : "OSM";
      return (
        `<li><button type="button" data-id="${esc(p.id)}">` +
          `<span class="place-icon">${emoji}</span>` +
          `<span class="place-text"><span class="place-name">${esc(name)}</span>` +
          `<span class="place-meta">${esc(p.layerLabel || label)} · ${badge}${p.inZone ? " · w obszarze" : ""}</span></span>` +
          `<span class="place-dist">${formatDistance(d)}</span>` +
        `</button></li>`
      );
    })
    .join("");
}

function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(km < 10 ? 1 : 0).replace(".", ",")} km`;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* --------------------------------------------------------- wyszukiwarka --- */

const searchInput = $("#search");
const searchList = $("#search-results");
const searchNote = $("#search-note");
let searchTimer;
let searchAbort = null;
let searchHits = [];

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 3) {
    hideResults();
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 400);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hideResults(); searchInput.blur(); }
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(searchTimer);
    if (searchHits.length) goTo(searchHits[0]);
    else runSearch(searchInput.value.trim());
  }
});

$("#search-go").addEventListener("click", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length >= 3) runSearch(q);
});

searchList.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-index]");
  if (li) goTo(searchHits[Number(li.dataset.index)]);
});

async function runSearch(q) {
  if (q.length < 3) return;
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();

  note("Szukam...");
  searchList.classList.add("hidden");

  try {
    const r = await fetchWithTimeout(
      `/api/geocode?q=${encodeURIComponent(q)}`, {}, searchAbort.signal, 12000
    );
    const data = await r.json().catch(() => null);

    if (!r.ok) {
      // Treść błędu mówi, który geokoder odmówił i z jakim kodem - bez tego
      // diagnoza sprowadza się do zgadywania.
      const detail = Array.isArray(data?.details) ? ` - ${data.details.join(" | ")}` : "";
      note(`Wyszukiwanie nie zadziałało: ${data?.error || `HTTP ${r.status}`}${detail}`);
      return;
    }

    searchHits = (data?.results || []).filter(
      (h) => Number.isFinite(h.lat) && Number.isFinite(h.lon)
    );

    if (!searchHits.length) {
      note("Brak wyników.");
      return;
    }

    searchList.innerHTML = searchHits
      .map((r, i) => `<li data-index="${i}"><button type="button">${esc(r.name)}</button></li>`)
      .join("");
    searchList.classList.remove("hidden");
    searchNote.classList.add("hidden");
  } catch (e) {
    if (searchAbort.signal.aborted) return;
    note(`Wyszukiwanie nie zadziałało: ${errText(e)}`);
  }
}

function goTo(hit) {
  if (!hit) return;
  hideResults();
  searchInput.value = hit.name.split(",")[0];

  if (hit.bbox && hit.bbox.length === 4 && hit.bbox.every(Number.isFinite)) {
    const [south, north, west, east] = hit.bbox;
    map.fitBounds([[south, west], [north, east]], { maxZoom: 15 });
  } else {
    map.setView([hit.lat, hit.lon], 13);
  }
}

function hideResults() {
  searchHits = [];
  searchList.classList.add("hidden");
  searchList.innerHTML = "";
  searchNote.classList.add("hidden");
}

function note(text) {
  searchNote.textContent = text;
  searchNote.classList.remove("hidden");
}

// Dymki Leafletu powstają i znikają w locie, więc nasłuch jest delegowany.
document.addEventListener("click", (e) => {
  if (e.target.closest(".leaflet-popup-close-button")) focusId = null;
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy-coords");
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.coords);
    btn.textContent = "skopiowane";
  } catch {
    // Bez HTTPS albo bez zgody na schowek zostaje zaznaczenie ręczne.
    const code = btn.parentElement.querySelector("code");
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    btn.textContent = "zaznaczone";
  }
  setTimeout(() => { btn.textContent = "kopiuj"; }, 1600);
});

const start = readHash() || { lat: 52, lon: 19.2, zoom: 7 };
const map = L.map("map").setView([start.lat, start.lon], start.zoom);

const baseLayers = {
  "Mapa": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }),
  "Satelita": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Zdjęcia &copy; Esri, Maxar, Earthstar Geographics" }
  ),
  // Ortofotomapa Geoportalu jest dla Polski dużo ostrzejsza niż zdjęcia
  // globalne, ale pokrywa wyłącznie teren kraju.
  "Ortofoto PL": L.tileLayer(
    "https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution" +
      "?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default" +
      "&FORMAT=image/jpeg&tileMatrixSet=EPSG:3857&tileMatrix=EPSG:3857:{z}&tileRow={y}&tileCol={x}",
    { maxZoom: 19, attribution: "Ortofotomapa &copy; Główny Urząd Geodezji i Kartografii" }
  ),
};

baseLayers[readBaseLayer()].addTo(map);
L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);
map.on("baselayerchange", (e) => {
  try { localStorage.setItem("basemap", e.name); } catch { /* tryb prywatny */ }
  document.body.classList.toggle("on-imagery", e.name !== "Mapa");
});
document.body.classList.toggle("on-imagery", readBaseLayer() !== "Mapa");

function readBaseLayer() {
  try {
    const v = localStorage.getItem("basemap");
    if (v && baseLayers[v]) return v;
  } catch { /* tryb prywatny */ }
  return "Mapa";
}

const zoneLayer = L.geoJSON(null, {
  // Jasny fiolet nad zielenią lasu mieszał się w szarość (4% nasycenia), stąd
  // mocniejsze wypełnienie i wyraźniejsza obwódka.
  style: zoneStyle,
  onEachFeature(feature, layer) {
    const p = feature.properties || {};
    layer.bindPopup(`<div class="popup"><strong>${esc(p.nzw_ob || p.inv_nr || "Zanocuj w lesie")}</strong>${p.inv_nr ? `<div>Nr: ${esc(p.inv_nr)}</div>` : ""}</div>`);
  },
}).addTo(map);
// Linie pod markerami, żeby nie zasłaniały punktów.
const trailLayer = L.geoJSON(null, {
  style: trailStyle,
  onEachFeature(feature, layer) {
    layer.bindPopup(trailPopup(feature));
  },
}).addTo(map);
const poiLayer = L.layerGroup().addTo(map);

// Jasny fiolet nad zielenią lasu mieszał się w szarość (4% nasycenia), stąd
// mocniejsze wypełnienie i wyraźniejsza obwódka. Przy widoku kraju obszary mają
// po kilka pikseli, więc grubszy kontur robi z nich widoczne punkty - inaczej
// użytkownik nie wie, że w ogóle są, dopóki nie przybliży.
function zoneStyle() {
  const far = map.getZoom() < 10;
  return {
    color: "#6b21a8",
    weight: far ? 4 : 2.5,
    fillColor: "#a855f7",
    fillOpacity: far ? 0.6 : 0.45,
  };
}

map.on("zoomend", () => zoneLayer.setStyle(zoneStyle));

const cache = new Map();
let zones = [];
let zoneBoxes = [];
let bdlPois = [];
let osmPois = [];
let trailCount = 0;
const markerById = new Map();
let userPos = null;
let sortMode = "center";
let listType = "";
let focusId = null;
let loadedFor = null;
let serial = 0;
let timer;
let inFlight = null;
let overpassPreferred = readPreferredEndpoint();
let snapshot = null;
let snapshotState = "unknown";
let snapshotPromise = null;

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
    document.body.classList.remove("loading");
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
  const bounds = padBounds(view, padFor(view));
  const started = performance.now();
  const notes = [];
  let failed = false;
  let osmError = null;

  clearDebug();
  hideMessage();
  document.body.classList.add("loading");
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
          if (endpoint) notes.push(`OSM: ${endpoint}`);
          renderPois();
        },
        (e) => {
          if (id !== serial) return;
          osmPois = [];
          failed = true;
          osmError = errText(e).split("\n")[0];
          notes.push(`OSM: ${errText(e)}`);
        }
      )
    );
  } else {
    bdlPois = [];
    osmPois = [];
    showMessage(`Przybliż do ${MIN_POI_ZOOM}+, żeby zobaczyć wiaty, paleniska i pozostałe punkty.`);
  }

  const wantedTrails = TRAIL_LAYERS.filter(([id]) => $(`#trail-${id}`).checked);
  if (zoom >= MIN_TRAIL_ZOOM && wantedTrails.length) {
    jobs.push(
      loadTrails(wantedTrails, bounds, zoom, controller.signal).then(
        ({ features, errors }) => {
          if (id !== serial) return;
          drawTrails(features);
          if (errors.length) { failed = true; notes.push(`Szlaki: ${errors.join(" | ")}`); }
        },
        (e) => {
          if (id !== serial) return;
          drawTrails([]);
          failed = true;
          notes.push(`Szlaki: ${errText(e)}`);
        }
      )
    );
  } else {
    drawTrails([]);
    if (wantedTrails.length && zoom < MIN_TRAIL_ZOOM) {
      showMessage(`Przybliż do ${MIN_TRAIL_ZOOM}+, żeby zobaczyć szlaki.`);
    }
  }

  await Promise.all(jobs);
  if (id !== serial) return;
  document.body.classList.remove("loading");

  inFlight = null;
  // Nieudane pobranie nie może zostać zapamiętane jako wczytany widok,
  // bo kolejne przesunięcia mapy odtwarzałyby pustkę z pamięci.
  loadedFor = failed ? null : { bounds, band: band(zoom) };
  const shown = renderPois();
  const ms = Math.round(performance.now() - started);
  setStatus(
    zoom < MIN_POI_ZOOM
      ? `Obszary: ${zones.length}. (${ms} ms)`
      : `Obszary: ${zones.length}. BDL: ${bdlPois.length}. OSM: ${osmError ? `błąd - ${osmError}` : osmPois.length}. Na mapie: ${shown}. (${ms} ms)`
  );
  if (notes.length) setDebug(notes.join("\n"), failed);
}

/* ---------------------------------------------------------------- BDL --- */

// Koszt zapytania o strefy skaluje się z obszarem widoku, a przy zoomie 7
// obejmuje on cały kraj. Dokładna geometria nie mieści się wtedy w budżecie
// czasu proxy, a i tak jest niewidoczna: przy tej skali piksel to ponad
// kilometr. Uproszczenie, precyzja i liczba stron idą więc w parze z zoomem.
const ZONE_DETAIL = [
  { minZoom: 13, offset: "0.00002", precision: "5", pages: 3 },
  { minZoom: 11, offset: "0.00006", precision: "5", pages: 3 },
  { minZoom: 9, offset: "0.0002", precision: "5", pages: 3 },
  { minZoom: 0, offset: "0.01", precision: "3", pages: 1 },
];

function loadZones(bounds, zoom, signal) {
  const detail = ZONE_DETAIL.find((d) => zoom >= d.minZoom);
  return loadBdlLayer(0, bounds, "objectid,tur_sleep_poly_id,inv_nr,nzw_ob,link", {
    signal,
    maxAllowableOffset: detail.offset,
    geometryPrecision: detail.precision,
    maxPages: detail.pages,
  });
}

async function loadBdlPois(bounds, signal) {
  const results = await Promise.allSettled(
    BDL_LAYERS.map(async ([layer, kind, fields, label]) => {
      const opts = { signal, geometryPrecision: "6", maxPages: 2 };
      let features;

      try {
        features = await loadBdlLayer(layer, bounds, fields, opts);
      } catch (error) {
        // ArcGIS odrzuca całe zapytanie, gdy w outFields jest pole, którego
        // warstwa nie ma. Schematy nie są udokumentowane, więc zamiast tracić
        // warstwę, ponawiamy raz z kompletem pól.
        if (fields === "*" || signal?.aborted) throw error;
        features = await loadBdlLayer(layer, bounds, "*", opts);
      }

      return features.flatMap((f) => normalizeBdl(f, layer, kind, label));
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

function normalizeBdl(feature, layer, kind, label) {
  const c = feature.geometry?.coordinates;
  if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") return [];
  const p = feature.properties || {};
  const base = {
    source: "BDL", layer, lon: c[0], lat: c[1],
    name: p.nzw_ob || null, address: p.adres || null, link: safeUrl(p.link),
  };
  const idBase = `${layer}:${p.objectid ?? c.join(",")}`;
  const out = [];
  // Etykieta warstwy pasuje tylko tam, gdzie warstwa odpowiada typowi wprost.
  // Punkt wyprowadzony z flagi udogodnienia (palenisko przy miejscu
  // wypoczynku) opisuje samo udogodnienie, a nie warstwę, z której pochodzi.
  const add = (type, layerLabel = null) =>
    out.push({ ...base, id: `BDL:${idBase}:${type}`, type, layerLabel });

  if (["shelter", "campsite", "parking", "viewpoint"].includes(kind)) add(kind, label);
  if (kind === "rest" || kind === "other") {
    if (yes(p.wiata)) add("shelter");
    if (yes(p.palenisko)) add("firepit");
    if (yes(p.lawostoly)) add("picnic");
    if (yes(p.woda_pitna)) add("water");
    if (yes(p.toalety_tm) || yes(p.toalety_st)) add("toilets");
    if (yes(p.parking)) add("parking");
    // Warstwa "inne obiekty" bywa bez flag udogodnień; bez tego jej punkty
    // przepadłyby mimo udanego pobrania. Etykieta warstwy w dymku mówi, czym
    // obiekt jest naprawdę.
    if (!out.length) add("picnic", label);
  }
  return out;
}

/* --------------------------------------------------------------- szlaki --- */

async function loadTrails(wanted, bounds, zoom, signal) {
  // Linie bywają gęste, więc upraszczamy geometrię tym mocniej, im dalej
  // jesteśmy - inaczej payload rośnie do megabajtów.
  const offset = zoom >= 14 ? "0.00002" : zoom >= 12 ? "0.00008" : "0.0002";

  const results = await Promise.allSettled(
    wanted.map(async ([layer, kind]) => {
      const features = await loadBdlLayer(layer, bounds, "*", {
        signal,
        maxAllowableOffset: offset,
        geometryPrecision: "5",
        maxPages: 2,
      });
      // Znacznik rodzaju wędruje w properties, bo styl i dymek dostają
      // wyłącznie feature.
      for (const f of features) {
        f.properties = { ...(f.properties || {}), __kind: kind };
      }
      return features;
    })
  );

  const features = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") features.push(...r.value);
    else errors.push(`warstwa ${wanted[i][0]}: ${errText(r.reason)}`);
  });
  return { features, errors };
}

function drawTrails(features) {
  trailLayer.clearLayers();
  trailCount = features.length;
  if (features.length) {
    trailLayer.addData({ type: "FeatureCollection", features });
  }
  $("#trails").textContent = trailCount;
}

function trailStyle(feature) {
  const p = feature?.properties || {};
  const spec = TRAIL_LAYERS.find(([, kind]) => kind === p.__kind);
  const [, , , fallback, dash] = spec || [, , , "#b45309", null];
  return {
    color: trailColor(p) || fallback,
    weight: 3,
    opacity: 0.85,
    dashArray: dash,
    lineCap: "round",
  };
}

function trailColor(p) {
  for (const [key, value] of Object.entries(p)) {
    if (!/kolor/i.test(key) || typeof value !== "string") continue;
    const hit = TRAIL_COLORS[value.trim().toLowerCase()];
    if (hit) return hit;
  }
  return null;
}

// Schemat warstw liniowych nie jest nam znany, więc dymek pokazuje pola,
// które faktycznie przyszły, pomijając techniczne.
function trailPopup(feature) {
  const p = { ...(feature?.properties || {}) };
  const kind = p.__kind;
  delete p.__kind;

  const spec = TRAIL_LAYERS.find(([, k]) => k === kind);
  const title = p.nzw_ob || p.nazwa || (spec ? spec[2] : "Szlak");

  const rows = Object.entries(p)
    .filter(([k, v]) =>
      !/^(objectid|globalid|shape|se_anno|st_length|st_area)/i.test(k) &&
      v !== null && v !== "" && typeof v !== "object"
    )
    .slice(0, 8)
    .map(([k, v]) => `<div><span class="popup-key">${esc(k)}</span> ${esc(v)}</div>`)
    .join("");

  return (
    `<div class="popup"><strong>🥾 ${esc(title)}</strong>` +
    `<div class="popup-source source-bdl">Źródło: Bank Danych o Lasach (LP)</div>` +
    (rows ? `<div class="popup-fields">${rows}</div>` : "") +
    `</div>`
  );
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
  const snap = await loadSnapshot();
  if (snap) {
    return { items: pointsFrom(snap, bounds), endpoint: `zrzut z ${snap.generated}`, tried: [] };
  }

  if (areaOf(bounds) > HARD_OSM_AREA) {
    throw new Error("obszar zbyt duży dla Overpass - przybliż mapę");
  }

  const q = overpassQuery(bounds);
  const key = `osm:${q}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return { items: hit.data, endpoint: "pamięć podręczna", tried: [] };
  }

  const order = [
    ...(overpassPreferred ? [overpassPreferred] : []),
    ...OVERPASS_ENDPOINTS.filter((u) => u !== overpassPreferred),
  ];

  const { data, url, tried } = await raceOverpass(order, q, signal);
  // HTTP 200 z zerem elementów to poprawna odpowiedź, a nie awaria -
  // nie wolno przez nią przechodzić do kolejnych serwerów.
  const items = unique((data.elements || []).map(normalizeOsm).filter(Boolean));
  cacheSet(key, items);
  rememberEndpoint(url);
  return { items, endpoint: `serwer ${url}`, tried };
}

// Lustra Overpass regularnie padają albo odbijają zapytanie limitem, więc nie
// czekamy na każde po kolei: co HEDGE_MS dokładamy kolejne równolegle i bierzemy
// pierwszą poprawną odpowiedź, a resztę anulujemy.
function raceOverpass(order, q, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);

    const local = new AbortController();
    const onAbort = () => local.abort(signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    const tried = [];
    let index = 0;
    let running = 0;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const launch = () => {
      if (settled || index >= order.length) return;
      const url = order[index++];
      running++;

      askOverpass(url, q, local.signal).then(
        (data) => {
          if (settled) return;
          settled = true;
          cleanup();
          local.abort();
          resolve({ data, url, tried });
        },
        (e) => {
          running--;
          if (settled) return;
          if (signal?.aborted) {
            settled = true;
            cleanup();
            reject(signal.reason);
            return;
          }
          tried.push(`${url}: ${errText(e)}`);
          if (overpassPreferred === url) overpassPreferred = null;
          if (index < order.length) launch();
          else if (running === 0) {
            settled = true;
            cleanup();
            reject(new Error(
              `żaden z ${order.length} serwerów Overpass nie odpowiedział\n${tried.join("\n")}`
            ));
          }
        }
      );

      if (index < order.length) {
        clearTimeout(timer);
        timer = setTimeout(launch, HEDGE_MS);
      }
    };

    launch();
  });
}

// Pobierany raz na sesję; celowo bez sygnału z refresh(), żeby ruch mapą
// nie anulował zapytania i nie zapamiętał zrzutu jako niedostępnego.
function loadSnapshot() {
  if (snapshotState === "ready") return Promise.resolve(snapshot);
  if (snapshotState === "missing") return Promise.resolve(null);

  if (!snapshotPromise) {
    snapshotPromise = getJson(SNAPSHOT_URL, null, 30000).then(
      (data) => {
        if (!Array.isArray(data?.points)) throw new Error("nieprawidłowy format zrzutu");
        snapshot = data;
        snapshotState = "ready";
        return snapshot;
      },
      () => {
        snapshotState = "missing";
        return null;
      }
    );
  }
  return snapshotPromise;
}

function pointsFrom(snap, bounds) {
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const out = [];

  for (const [lat, lon, type, bus, osmType, osmId, name] of snap.points) {
    if (lat < south || lat > north || lon < west || lon > east) continue;
    const kind = snap.types[type];
    const osmKind = snap.osmTypes[osmType];
    out.push({
      id: `OSM:${osmKind}/${osmId}`,
      source: "OSM",
      osmType: osmKind,
      osmId,
      lat,
      lon,
      type: kind,
      bus: Boolean(bus),
      name: name || null,
      tagLine: SNAPSHOT_TAGS[kind] || "",
    });
  }
  return out;
}

function askOverpass(url, q, signal) {
  return url.startsWith("/api/")
    ? getJson(`${url}?data=${encodeURIComponent(q)}`, signal, OSM_TIMEOUT)
    : postForm(url, { data: q }, signal, OSM_TIMEOUT);
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

  // Filtr typu stosujemy na końcu, żeby dało się policzyć, ile trafień
  // dałby każdy typ przy obecnych pozostałych ustawieniach - liczba przy
  // filtrze mówi, czy warto go w ogóle włączać.
  const pool = [...bdlPois, ...osmPois]
    .filter((p) => (p.source === "BDL" ? showBdl : showOsm))
    .filter((p) => !(hideBus && p.source === "OSM" && p.bus));

  const list = pool.filter((p) => enabled.has(p.type));

  for (const p of pool) p.inZone = insideZone(p.lon, p.lat);

  const inScope = onlyZone ? pool.filter((p) => p.inZone) : pool;
  const visible = inScope.filter((p) => enabled.has(p.type));
  updateTypeCounts(inScope);
  const capped = visible.slice(0, MAX_MARKERS);
  fanOut(capped);

  markerById.clear();
  for (const p of capped) {
    const marker = buildMarker(p);
    markerById.set(p.id, marker);
    poiLayer.addLayer(marker);
  }

  renderList(visible);
  if (focusId) markerById.get(focusId)?.openPopup();

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
    iconSize: [34, 34],
    iconAnchor: [17 - dx, 17 - dy],
  });

  const marker = L.marker([p.lat, p.lon], { icon, riseOnHover: true });
  marker.on("click", () => { focusId = p.id; });

  let link = "";
  if (p.source === "OSM") {
    link = `<a target="_blank" rel="noreferrer" href="https://www.openstreetmap.org/${p.osmType}/${p.osmId}">Otwórz w OSM</a>`;
  } else if (p.link) {
    link = `<a target="_blank" rel="noreferrer" href="${esc(p.link)}">Informacje BDL</a>`;
  }

  const coords = `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
  const maps = `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

  // Parametry idą w listę definicyjną, bo to uporządkowana specyfikacja,
  // a nie ciąg zdań. Akcje są wydzielone i tekstowe - żadna z nich nie jest
  // na tyle ważna, żeby konkurować z akcją główną na pasku mapy.
  const spec = (key, value) => `<dt>${key}</dt><dd>${value}</dd>`;

  marker.bindPopup(
    `<div class="popup">` +
      `<strong class="popup-title">${emoji} ${esc(p.name || p.layerLabel || label)}</strong>` +
      `<span class="popup-kind">${esc(p.layerLabel || label)}</span>` +
      `<dl class="popup-specs">` +
        spec("Źródło", `<span class="${p.source === "BDL" ? "source-bdl" : "source-osm"}">${
          p.source === "BDL" ? "Bank Danych o Lasach" : "OpenStreetMap"}</span>`) +
        (p.tagLine ? spec("Tagi", esc(p.tagLine)) : "") +
        (p.address ? spec("Adres", esc(p.address)) : "") +
        spec("Obszar", p.inZone ? "w obszarze programu" : "poza obszarem programu") +
        spec("Współrzędne", `<span class="popup-coords">${coords}</span>`) +
      `</dl>` +
      `<div class="popup-actions">` +
        `<button type="button" class="copy-coords" data-coords="${coords}">Kopiuj współrzędne</button>` +
        `<a target="_blank" rel="noreferrer" href="${maps}">Google Maps</a>` +
        link +
      `</div>` +
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
    const r = g.length === 2 ? 20 : 18 + g.length * 3;
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

// Liczba przy każdym typie liczona jest po zastosowaniu pozostałych filtrów,
// więc odpowiada na pytanie "ile dostanę, jeśli to włączę".
function updateTypeCounts(items) {
  const counts = new Map();
  for (const p of items) counts.set(p.type, (counts.get(p.type) || 0) + 1);

  for (const el of document.querySelectorAll(".check-count")) {
    const n = counts.get(el.dataset.count) || 0;
    el.textContent = n;
    el.dataset.empty = n ? "0" : "1";
  }
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
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 150).replace(/\s+/g, " ").trim()}`);
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
  if (f <= 0) return b;
  const dLat = (b.getNorth() - b.getSouth()) * f;
  const dLon = (b.getEast() - b.getWest()) * f;
  return L.latLngBounds(
    [b.getSouth() - dLat, b.getWest() - dLon],
    [b.getNorth() + dLat, b.getEast() + dLon]
  );
}

function areaOf(b) {
  return (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
}

// Duży widok dostaje mniejszy margines, zamiast zostać odrzucony.
function padFor(view) {
  const area = areaOf(view);
  if (area <= 0) return PAD;
  const scale = Math.sqrt(SOFT_OSM_AREA / area);
  return Math.max(0, Math.min(PAD, (scale - 1) / 2));
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
function setDebug(e, open = false) {
  debugEl.textContent = errText(e);
  debugWrap.classList.remove("hidden");
  if (open) debugWrap.open = true;
}
