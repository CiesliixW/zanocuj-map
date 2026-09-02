// Zamienia strumień GeoJSON z osmium (osmium export -f geojsonseq) na zwarty
// zrzut używany przez aplikację. Wejście na stdin, wyjście do public/.
import { writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";

const TYPES = ["shelter", "firepit", "picnic"];
const OSM_TYPES = ["node", "way", "relation"];
const OSM_PREFIX = { n: 0, w: 1, r: 2 };

function classify(t) {
  if (t.leisure === "firepit") return "firepit";
  if (t.amenity === "shelter") return "shelter";
  if (t.tourism === "picnic_site") return "picnic";
  return null;
}

// Overpass przy "out center" oddaje środek prostokąta otaczającego, więc dla
// linii i wielokątów liczymy dokładnie to samo - zrzuty pozostają porównywalne.
function centre(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates || [];
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
  }

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
      if (c[0] < minLon) minLon = c[0];
      if (c[0] > maxLon) maxLon = c[0];
      return;
    }
    for (const part of c) walk(part);
  };
  walk(geometry.coordinates || []);

  if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return null;
  return [(minLat + maxLat) / 2, (minLon + maxLon) / 2];
}

const seen = new Set();
const points = [];
let lines = 0;
let skipped = 0;

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  // geojsonseq poprzedza rekordy znakiem RS (RFC 8142).
  const text = line.replace(//g, "").trim();
  if (!text) continue;
  lines++;

  let feature;
  try {
    feature = JSON.parse(text);
  } catch {
    skipped++;
    continue;
  }

  const props = feature.properties || {};
  const kind = classify(props);
  if (!kind) { skipped++; continue; }

  const point = centre(feature.geometry);
  if (!point) { skipped++; continue; }

  // osmium z --add-unique-id=type_id zapisuje identyfikator jako "n123"/"w45".
  const uid = String(props["@id"] ?? feature.id ?? "");
  const osmType = OSM_PREFIX[uid[0]] ?? 0;
  const osmId = Number(uid.slice(1)) || Number(uid) || 0;

  const key = `${osmType}/${osmId}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const bus =
    props.shelter_type === "public_transport" ||
    Boolean(props.public_transport) ||
    props.highway === "bus_stop";

  points.push([
    Math.round(point[0] * 1e5) / 1e5,
    Math.round(point[1] * 1e5) / 1e5,
    TYPES.indexOf(kind),
    bus ? 1 : 0,
    osmType,
    osmId,
    props.name || "",
  ]);
}

if (!points.length) {
  console.error(`Nie rozpoznano żadnego punktu (wczytano ${lines} rekordów) - nie nadpisuję zrzutu.`);
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

const byType = {};
for (const p of points) byType[TYPES[p[2]]] = (byType[TYPES[p[2]]] || 0) + 1;

console.log(`Wczytano ${lines} rekordów, pominięto ${skipped}.`);
console.log(`Zapisano public/osm-poland.json: ${points.length} punktów, ${(json.length / 1048576).toFixed(2)} MB`);
console.log("Podział:", byType, "| wiaty przystankowe:", points.filter((p) => p[3]).length);
