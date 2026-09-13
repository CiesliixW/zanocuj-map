// Wspólna obsługa ArcGIS BDL dla skryptów zrzutów. Serwis bywa kapryśny:
// przy zapytaniach obejmujących cały kraj potrafi na kilka minut odpowiadać
// 502 albo urywać połączenie, więc ponawianie musi przeżyć całą taką przerwę,
// a nie tylko pojedynczy błąd.
const SERVICE =
  "https://mapserver.bdl.lasy.gov.pl/arcgis/rest/services/Czas_w_las/WFS_BDL_czas_w_las/MapServer";

// Polska z zapasem - ArcGIS pracuje pewniej z zapytaniem przestrzennym niż
// z samym "1=1" na całej warstwie.
export const POLAND = {
  xmin: 13.5, ymin: 48.5, xmax: 24.5, ymax: 55.5,
  spatialReference: { wkid: 4326 },
};

const ATTEMPTS = 8;
const MAX_BACKOFF = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, attempt = 0) {
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/geo+json,application/json" },
      signal: AbortSignal.timeout(120000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    const data = JSON.parse(text);
    if (data.error) throw new Error(`ArcGIS: ${JSON.stringify(data.error).slice(0, 200)}`);
    return data;
  } catch (e) {
    if (attempt >= ATTEMPTS) throw e;
    // Do minuty przerwy między próbami: awarie BDL liczą się w minutach,
    // a nie w sekundach, więc krótkie ponawianie tylko marnuje przebieg.
    const wait = Math.min(2000 * 2 ** attempt, MAX_BACKOFF);
    console.error(`    ponawiam za ${Math.round(wait / 1000)} s: ${e.message}`);
    await sleep(wait);
    return getJson(url, attempt + 1);
  }
}

// Warstwa strona po stronie. Bez sortowania ArcGIS nie gwarantuje, że kolejne
// strony nie powtórzą ani nie pominą rekordu.
export async function fetchLayer({ layer, fields, tolerance, precision, page = 200, maxPages = 400, label }) {
  const out = [];

  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams({
      where: "1=1",
      geometry: JSON.stringify(POLAND),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: fields,
      returnGeometry: "true",
      outSR: "4326",
      geometryPrecision: precision,
      orderByFields: "objectid",
      resultOffset: String(i * page),
      resultRecordCount: String(page),
      f: "geojson",
    });
    if (tolerance) params.set("maxAllowableOffset", tolerance);

    const data = await getJson(`${SERVICE}/${layer}/query?${params}`);
    const batch = data.features || [];
    out.push(...batch);
    console.error(`  ${label ?? `warstwa ${layer}`}, strona ${i + 1}: ${batch.length} (razem ${out.length})`);
    if (batch.length < page) return out;
  }

  console.error(`  ${label ?? `warstwa ${layer}`}: osiągnięto limit ${maxPages} stron`);
  return out;
}

// Sama data wygenerowania zmienia się co przebieg. Gdyby decydowała o zapisie,
// repozytorium dostawałoby codzienny commit bez żadnej zmiany danych.
export function sameAsBefore(previous, next, keys) {
  if (!previous) return false;
  try {
    const old = JSON.parse(previous);
    return keys.every((k) => JSON.stringify(old[k]) === JSON.stringify(next[k]));
  } catch {
    return false;
  }
}
