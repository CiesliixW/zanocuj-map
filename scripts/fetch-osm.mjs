// Zrzuca punkty OSM dla Polski do statycznego pliku, żeby aplikacja nie
// zależała od Overpass w czasie działania. Uruchamiane z GitHub Actions.
import { writeFile, mkdir } from "node:fs/promises";

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const AREA = { south: 49.0, west: 14.1, north: 54.9, east: 24.2 };
const TILE = 1.0;
const RETRIES = 8;
const BACKOFF_MS = [5000, 10000, 20000, 30000, 45000, 60000, 60000, 60000];
const TYPES = ["shelter", "firepit", "picnic"];
const OSM_TYPES = ["node", "way", "relation"];

// Filtr obszarowy na Polskę odcina Czechy, Niemcy czy Słowację, które w
// narożnikach kafli potrafią oddać więcej punktów niż sama Polska. Mniej
// danych to i mniejszy plik, i lżejsze zapytania, które nie kończą się 504.
const query = (s, w, n, e, useArea) => {
  const box = `(${s},${w},${n},${e})`;
  const area = useArea ? "(area.pl)" : "";
  return `[out:json][timeout:240];
${useArea ? 'area["ISO3166-1"="PL"][admin_level=2]->.pl;\n' : ""}(
  nwr["amenity"="shelter"]${area}${box};
  nwr["tourism"="picnic_site"]${area}${box};
  nwr["leisure"="firepit"]${area}${box};
);
out center;`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (url) => new URL(url).host;

// Lustro, które się sypie, spada na koniec kolejki zamiast marnować co drugą
// próbę - w praktyce jedno bywa całkowicie padnięte przez cały przebieg.
const failures = new Map(MIRRORS.map((m) => [m, 0]));
const byHealth = () => [...MIRRORS].sort((a, b) => failures.get(a) - failures.get(b));

async function askOverpass(q) {
  let lastError = null;

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const order = byHealth();
    const url = order[attempt % order.length];

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "zanocuj-map snapshot (+https://github.com/CiesliixW/zanocuj-map)",
        },
        body: new URLSearchParams({ data: q }),
        signal: AbortSignal.timeout(300000),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120).replace(/\s+/g, " ")}`);
      }

      const data = await res.json();
      failures.set(url, Math.max(0, failures.get(url) - 1));
      return data;
    } catch (error) {
      lastError = error;
      failures.set(url, failures.get(url) + 1);
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      console.warn(`    ${host(url)} odmówił (${error.message}); ponawiam za ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw new Error(`wszystkie lustra odmówiły: ${lastError?.message}`);
}

const tiles = [];
for (let s = AREA.south; s < AREA.north; s += TILE) {
  for (let w = AREA.west; w < AREA.east; w += TILE) {
    tiles.push([
      Number(s.toFixed(2)),
      Number(w.toFixed(2)),
      Number(Math.min(s + TILE, AREA.north).toFixed(2)),
      Number(Math.min(w + TILE, AREA.east).toFixed(2)),
    ]);
  }
}

function normalize(e) {
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

  // Krotka zamiast obiektu - plik jest wielokrotnie mniejszy.
  // [lat, lon, typ, wiataPrzystankowa, typOsm, idOsm, nazwa]
  return [
    Math.round(lat * 1e5) / 1e5,
    Math.round(lon * 1e5) / 1e5,
    TYPES.indexOf(type),
    bus ? 1 : 0,
    Math.max(0, OSM_TYPES.indexOf(e.type)),
    e.id,
    t.name || "",
  ];
}

const seen = new Set();
const points = [];

async function runTile(tile, label) {
  const [s, w, n, e] = tile;
  const data = await askOverpass(query(s, w, n, e, useArea));
  let added = 0;

  for (const el of data.elements || []) {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    const row = normalize(el);
    if (!row) continue;
    seen.add(key);
    points.push(row);
    added++;
  }

  console.log(`${label} ${s},${w} -> ${data.elements?.length || 0} obiektów, ${added} nowych (razem ${points.length})`);
}

// Filtr obszarowy zwraca pustkę bez błędu, gdy lustro ma nieaktualną bazę
// obszarów. Sonda nad Warszawą - miejscem, gdzie punkty na pewno są - wykrywa
// taki przypadek, zanim zmarnujemy na niego cały przebieg.
let useArea = true;
console.log("Sprawdzam filtr obszarowy na Polskę...");
const probe = await askOverpass(query(52.0, 20.5, 52.5, 21.0, true));
if (!(probe.elements || []).length) {
  useArea = false;
  console.warn("Filtr obszarowy nie zwrócił nic - przechodzę na sam bbox (plik będzie większy o punkty zza granicy).");
} else {
  console.log(`Filtr obszarowy działa (sonda: ${probe.elements.length} obiektów).`);
}

console.log(`\nPobieram ${tiles.length} kafli po ${TILE} stopnia...`);

let pending = tiles;

// Pojedynczy kafel nie może wywalić całego przebiegu - nieudane wracają do
// drugiego podejścia, kiedy lustra zdążą się pozbierać.
for (let pass = 1; pass <= 2 && pending.length; pass++) {
  if (pass > 1) {
    console.log(`\nPodejście ${pass}: ponawiam ${pending.length} nieudanych kafli za 60s...`);
    await sleep(60000);
  }

  const stillFailing = [];
  for (const [i, tile] of pending.entries()) {
    try {
      await runTile(tile, `[${pass}.${i + 1}/${pending.length}]`);
    } catch (error) {
      console.warn(`  kafel ${tile[0]},${tile[1]} nieudany: ${error.message}`);
      stillFailing.push(tile);
    }
    await sleep(2000);
  }
  pending = stillFailing;
}

if (pending.length) {
  console.error(`\nNie udało się pobrać ${pending.length} kafli - nie nadpisuję zrzutu, żeby nie zostawić dziur.`);
  for (const t of pending) console.error(`  ${t[0]},${t[1]}`);
  process.exit(1);
}

if (!points.length) {
  console.error("Overpass nie zwrócił żadnych punktów - nie nadpisuję zrzutu.");
  process.exit(1);
}

points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

const payload = {
  generated: new Date().toISOString().slice(0, 19) + "Z",
  types: TYPES,
  osmTypes: OSM_TYPES,
  fields: ["lat", "lon", "type", "bus", "osmType", "osmId", "name"],
  count: points.length,
  points,
};

const json = JSON.stringify(payload);
await mkdir("public", { recursive: true });
await writeFile("public/osm-poland.json", json);

console.log(`\nZapisano public/osm-poland.json: ${points.length} punktów, ${(json.length / 1048576).toFixed(2)} MB`);

const byType = {};
for (const p of points) byType[TYPES[p[2]]] = (byType[TYPES[p[2]]] || 0) + 1;
console.log("Podział:", byType, "| wiaty przystankowe:", points.filter((p) => p[3]).length);
