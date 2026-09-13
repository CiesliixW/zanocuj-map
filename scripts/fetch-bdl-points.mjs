// Pobiera punkty rekreacyjne z BDL dla całego kraju i zapisuje je jako jeden
// plik w public/. Wcześniej każde przesunięcie mapy odpytywało dziesięć warstw
// ArcGIS naraz; punktów jest w skali kraju tyle, że mieszczą się w jednym
// pliku, a zmieniają się na tyle rzadko, że wystarczy odświeżać je raz na dobę.
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { fetchLayer, sameAsBefore } from "./bdl-client.mjs";

const OUT = "public/bdl-points.json";

const AMENITY_FIELDS =
  "objectid,nzw_ob,adres,link,wiata,lawostoly,palenisko,parking,toalety_tm,toalety_st,woda_pitna,kuchenka";
const BASIC_FIELDS = "objectid,nzw_ob,adres,link";

// Kolejność musi się zgadzać z tabelą w src/main.js - i zgadza się przez to,
// że aplikacja czyta ją z tego pliku, a nie z własnej kopii.
const LAYERS = [
  [15, "rest", AMENITY_FIELDS, "Miejsce wypoczynku"],
  [5, "shelter", BASIC_FIELDS, "Schronisko leśne"],
  [6, "campsite", BASIC_FIELDS, "Miejsce biwakowania"],
  [8, "campsite", BASIC_FIELDS, "Pole biwakowe"],
  [10, "campsite", BASIC_FIELDS, "Kemping"],
  [12, "campsite", BASIC_FIELDS, "Obozowisko harcerskie"],
  [17, "parking", BASIC_FIELDS, "Parking leśny"],
  [19, "parking", BASIC_FIELDS, "Miejsce postoju pojazdów"],
  [25, "viewpoint", BASIC_FIELDS, "Punkt widokowy"],
  // Warstwa 27 ma inny schemat niż 15 i odrzuca zapytanie o pola udogodnień,
  // więc pobieramy komplet zamiast zgadywać.
  [27, "other", "*", "Obiekt rekreacyjny"],
];

// Jedno miejsce wypoczynku bywa jednocześnie wiatą, paleniskiem i parkingiem.
// Trzymamy je jako jeden rekord z maską udogodnień, a nie jako sześć kopii tej
// samej nazwy i adresu - to różnica rzędu megabajta w gotowym pliku.
const FLAGS = ["shelter", "firepit", "picnic", "water", "toilets", "parking"];

const yes = (v) =>
  v === true || v === 1 ||
  (typeof v === "string" && ["t", "tak", "y", "yes", "1", "true"].includes(v.trim().toLowerCase()));

const url = (v) => {
  try {
    const u = new URL(v);
    return ["http:", "https:"].includes(u.protocol) ? u.toString() : "";
  } catch {
    return "";
  }
};

const points = [];
const counts = {};

for (const [index, [layer, kind, fields, label]] of LAYERS.entries()) {
  console.error(`Pobieram warstwę ${layer} (${label})...`);

  let features;
  try {
    features = await fetchLayer({ layer, fields, precision: "5", page: 1000, maxPages: 60, label });
  } catch (e) {
    // ArcGIS odrzuca całe zapytanie, gdy w outFields jest pole, którego
    // warstwa nie ma. Schematy nie są udokumentowane, więc zamiast tracić
    // warstwę, ponawiamy raz z kompletem pól.
    if (fields === "*") throw e;
    console.error(`  warstwa ${layer} odrzuciła listę pól - ponawiam z kompletem: ${e.message}`);
    features = await fetchLayer({ layer, fields: "*", precision: "5", page: 1000, maxPages: 60, label });
  }

  let kept = 0;

  for (const f of features) {
    const c = f.geometry?.coordinates;
    if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") continue;
    const p = f.properties || {};

    let flags = 0;
    if (kind === "rest" || kind === "other") {
      if (yes(p.wiata)) flags |= 1;
      if (yes(p.palenisko)) flags |= 2;
      if (yes(p.lawostoly)) flags |= 4;
      if (yes(p.woda_pitna)) flags |= 8;
      if (yes(p.toalety_tm) || yes(p.toalety_st)) flags |= 16;
      if (yes(p.parking)) flags |= 32;
    }

    points.push([
      Math.round(c[1] * 1e5) / 1e5,
      Math.round(c[0] * 1e5) / 1e5,
      index,
      flags,
      p.nzw_ob || "",
      p.adres || "",
      url(p.link),
    ]);
    kept++;
  }

  counts[label] = kept;
  console.error(`  zachowano ${kept} punktów`);
}

if (!points.length) {
  throw new Error("BDL nie zwrócił żadnego punktu - nie nadpisuję zrzutu.");
}

// Porządek po szerokości geograficznej daje stabilny plik: ten sam zestaw
// danych zawsze zapisuje się tak samo, więc commit powstaje tylko przy
// prawdziwej zmianie.
points.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

const payload = {
  generated: new Date().toISOString().slice(0, 19) + "Z",
  fields: ["lat", "lon", "layer", "flags", "name", "address", "link"],
  flags: FLAGS,
  layers: LAYERS.map(([layer, kind, , label]) => [layer, kind, label]),
  count: points.length,
  points,
};

const json = JSON.stringify(payload);
const previous = await readFile(OUT, "utf8").catch(() => null);

if (sameAsBefore(previous, payload, ["layers", "flags", "points"])) {
  console.log(`Punkty bez zmian (${points.length}) - zostawiam poprzedni zrzut.`);
  process.exit(0);
}

await mkdir("public", { recursive: true });
await writeFile(OUT, json);
console.log(`Zapisano ${OUT}: ${points.length} punktów, ${(json.length / 1048576).toFixed(2)} MB`);
console.log("Podział:", counts);
