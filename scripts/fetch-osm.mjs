// Zrzuca punkty OSM dla Polski do statycznego pliku, żeby aplikacja nie
// zależała od Overpass w czasie działania. Uruchamiane z GitHub Actions.
import { writeFile, mkdir } from "node:fs/promises";

const MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Polska z zapasem
const AREA = { south: 48.9, west: 14.0, north: 55.0, east: 24.3 };
const TILE = 1.5;
const RETRIES = 4;
const TYPES = ["shelter", "firepit", "picnic"];
const OSM_TYPES = ["node", "way", "relation"];

const query = (s, w, n, e) => `[out:json][timeout:180];
(
  nwr["amenity"="shelter"](${s},${w},${n},${e});
  nwr["tourism"="picnic_site"](${s},${w},${n},${e});
  nwr["leisure"="firepit"](${s},${w},${n},${e});
);
out center;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askOverpass(q) {
  let lastError = null;

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
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
        throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
      return await res.json();
    } catch (error) {
      lastError = error;
      const wait = 15000 * (attempt + 1);
      console.warn(`  ${url} nie odpowiedział (${error.message}); ponawiam za ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw new Error(`wszystkie lustra odmówiły: ${lastError?.message}`);
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
  // [lat, lon, typ, flagi, typOsm, idOsm, nazwa]
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

const tiles = [];
for (let s = AREA.south; s < AREA.north; s += TILE) {
  for (let w = AREA.west; w < AREA.east; w += TILE) {
    tiles.push([s, w, Math.min(s + TILE, AREA.north), Math.min(w + TILE, AREA.east)]);
  }
}

console.log(`Pobieram ${tiles.length} kafli...`);

const seen = new Set();
const points = [];

for (const [i, tile] of tiles.entries()) {
  const [s, w, n, e] = tile;
  process.stdout.write(`[${i + 1}/${tiles.length}] ${s.toFixed(1)},${w.toFixed(1)} ... `);
  const data = await askOverpass(query(s, w, n, e));
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

  console.log(`${data.elements?.length || 0} obiektów, ${added} nowych (razem ${points.length})`);
  await sleep(3000);
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

await mkdir("public", { recursive: true });
await writeFile("public/osm-poland.json", JSON.stringify(payload));

const bytes = JSON.stringify(payload).length;
console.log(`\nZapisano public/osm-poland.json: ${points.length} punktów, ${(bytes / 1048576).toFixed(2)} MB`);

const byType = {};
for (const p of points) byType[TYPES[p[2]]] = (byType[TYPES[p[2]]] || 0) + 1;
console.log("Podział:", byType, "| wiaty przystankowe:", points.filter((p) => p[3]).length);
