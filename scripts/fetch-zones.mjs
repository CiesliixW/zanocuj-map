// Pobiera wszystkie obszary "Zanocuj w lesie" z BDL i zapisuje je jako jeden
// plik w public/. Aplikacja rysuje go od razu po wczytaniu, bez czekania na
// ArcGIS - granice zmieniają się rzadko, więc odświeża je raz na dobę
// harmonogram w Actions, a nie każde przesunięcie mapy u użytkownika.
import { writeFile, readFile, mkdir } from "node:fs/promises";

const SERVICE =
  "https://mapserver.bdl.lasy.gov.pl/arcgis/rest/services/Czas_w_las/WFS_BDL_czas_w_las/MapServer/0/query";

// Polska z zapasem - ArcGIS pracuje pewniej z zapytaniem przestrzennym niż
// z samym "1=1" na całej warstwie.
const POLAND = { xmin: 13.5, ymin: 48.5, xmax: 24.5, ymax: 55.5, spatialReference: { wkid: 4326 } };

const PAGE = 250;
const MAX_PAGES = 200;
// Plik idzie do przeglądarki przy każdym pierwszym wejściu, więc ma swój
// budżet. Zaczynamy od geometrii najdokładniejszej i sięgamy po grubsze
// uproszczenie dopiero wtedy, gdy ta się nie mieści.
const BUDGET = 3 * 1024 * 1024;
const TOLERANCES = ["0.0002", "0.0005", "0.001"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 0) {
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/geo+json,application/json" },
      signal: AbortSignal.timeout(120000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    if (data.error) throw new Error(`ArcGIS: ${JSON.stringify(data.error).slice(0, 300)}`);
    return data;
  } catch (e) {
    if (attempt >= 4) throw e;
    const wait = 2000 * 2 ** attempt;
    console.error(`  ponawiam za ${wait} ms: ${e.message}`);
    await sleep(wait);
    return getJson(url, attempt + 1);
  }
}

async function fetchAll(tolerance) {
  const features = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      where: "1=1",
      geometry: JSON.stringify(POLAND),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "objectid,inv_nr,nzw_ob,link",
      returnGeometry: "true",
      outSR: "4326",
      maxAllowableOffset: tolerance,
      // Cztery miejsca po przecinku to ok. 11 m - i tak drobniej, niż sięga
      // uproszczenie, a piąte miejsce powiększyłoby plik bez żadnego zysku.
      geometryPrecision: "4",
      // Bez sortowania ArcGIS nie gwarantuje, że kolejne strony nie powtórzą
      // ani nie pominą rekordu.
      orderByFields: "objectid",
      resultOffset: String(page * PAGE),
      resultRecordCount: String(PAGE),
      f: "geojson",
    });

    const data = await getJson(`${SERVICE}?${params}`);
    const batch = data.features || [];
    features.push(...batch);
    process.stderr.write(`  strona ${page + 1}: ${batch.length} (razem ${features.length})\n`);
    if (batch.length < PAGE) break;
  }

  return features;
}

function clean(feature) {
  const p = feature.properties || {};
  return {
    type: "Feature",
    properties: {
      objectid: p.objectid ?? null,
      inv_nr: p.inv_nr || null,
      nzw_ob: p.nzw_ob || null,
      link: typeof p.link === "string" && /^https?:\/\//i.test(p.link) ? p.link : null,
    },
    geometry: feature.geometry,
  };
}

let chosen = null;

for (const tolerance of TOLERANCES) {
  console.error(`Pobieram obszary z uproszczeniem ${tolerance} stopnia...`);
  const features = await fetchAll(tolerance);

  if (!features.length) {
    throw new Error("BDL nie zwrócił żadnego obszaru - nie nadpisuję zrzutu.");
  }

  const payload = {
    generated: new Date().toISOString().slice(0, 19) + "Z",
    tolerance,
    count: features.length,
    features: features.map(clean),
  };
  const json = JSON.stringify(payload);
  const mb = json.length / 1048576;
  console.error(`  ${features.length} obszarów, ${mb.toFixed(2)} MB`);

  chosen = { json, features: features.length, mb, tolerance };
  if (json.length <= BUDGET) break;
  console.error("  ponad budżet - próbuję grubszego uproszczenia");
}

// Sama data wygenerowania zmienia się co przebieg. Gdyby decydowała o zapisie,
// repozytorium dostawałoby codzienny commit bez żadnej zmiany granic.
const previous = await readFile("public/zones-poland.json", "utf8").catch(() => null);

if (previous) {
  try {
    const old = JSON.parse(previous);
    const same =
      old.tolerance === chosen.tolerance &&
      JSON.stringify(old.features) === JSON.stringify(JSON.parse(chosen.json).features);
    if (same) {
      console.log(`Granice bez zmian (${chosen.features} obszarów) - zostawiam poprzedni zrzut.`);
      process.exit(0);
    }
  } catch {
    /* uszkodzony poprzedni plik - nadpisujemy */
  }
}

await mkdir("public", { recursive: true });
await writeFile("public/zones-poland.json", chosen.json);
console.log(
  `Zapisano public/zones-poland.json: ${chosen.features} obszarów, ` +
  `${chosen.mb.toFixed(2)} MB, uproszczenie ${chosen.tolerance}`
);
