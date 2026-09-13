// Pobiera wszystkie obszary "Zanocuj w lesie" z BDL i zapisuje je jako jeden
// plik w public/. Aplikacja rysuje go od razu po wczytaniu, bez czekania na
// ArcGIS - granice zmieniają się rzadko, więc odświeża je raz na dobę
// harmonogram w Actions, a nie każde przesunięcie mapy u użytkownika.
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { fetchLayer, sameAsBefore } from "./bdl-client.mjs";

const OUT = "public/zones-poland.json";

// Plik idzie do przeglądarki przy pierwszym wejściu, więc ma swój budżet.
// Zaczynamy od geometrii najdokładniejszej i sięgamy po grubsze uproszczenie
// dopiero wtedy, gdy ta się nie mieści.
const BUDGET = 3 * 1024 * 1024;
const TOLERANCES = ["0.0002", "0.0005", "0.001"];

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
  const features = await fetchLayer({
    layer: 0,
    fields: "objectid,inv_nr,nzw_ob,link",
    tolerance,
    // Cztery miejsca po przecinku to ok. 11 m - i tak drobniej, niż sięga
    // uproszczenie, a piąte powiększyłoby plik bez żadnego zysku.
    precision: "4",
    label: "obszary",
  });

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
  console.error(`  ${features.length} obszarów, ${(json.length / 1048576).toFixed(2)} MB`);

  chosen = { payload, json };
  if (json.length <= BUDGET) break;
  console.error("  ponad budżet - próbuję grubszego uproszczenia");
}

const previous = await readFile(OUT, "utf8").catch(() => null);

if (sameAsBefore(previous, chosen.payload, ["tolerance", "features"])) {
  console.log(`Granice bez zmian (${chosen.payload.count} obszarów) - zostawiam poprzedni zrzut.`);
  process.exit(0);
}

await mkdir("public", { recursive: true });
await writeFile(OUT, chosen.json);
console.log(
  `Zapisano ${OUT}: ${chosen.payload.count} obszarów, ` +
  `${(chosen.json.length / 1048576).toFixed(2)} MB, uproszczenie ${chosen.payload.tolerance}`
);
