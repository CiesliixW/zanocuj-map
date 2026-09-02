const SERVICE =
  "https://mapserver.bdl.lasy.gov.pl/arcgis/rest/services/Czas_w_las/WFS_BDL_czas_w_las/MapServer";

const ALLOWED_LAYERS = new Set([
  "0",   // Zanocuj w lesie polygons
  "5",   // Schroniska leśne - points
  "6",   // Miejsca biwakowania - points
  "8",   // Pola biwakowe - points
  "10",  // Kempingi - points
  "12",  // Obozowiska harcerskie - points
  "15",  // Miejsca wypoczynku - points
  "17",  // Parkingi leśne - points
  "19",  // Miejsca postoju pojazdów - points
  "25",  // Punkty widokowe - points
  "27",  // Inne punktowe obiekty rekreacyjne - points
  "34",  // Ścieżki dydaktyczne - lines
  "35",  // Szlaki turystyczne - lines
]);

const ALLOWED_PARAMS = new Set([
  "where",
  "geometry",
  "geometryType",
  "inSR",
  "spatialRel",
  "outFields",
  "returnGeometry",
  "outSR",
  "maxAllowableOffset",
  "geometryPrecision",
  "resultOffset",
  "resultRecordCount",
  "f",
]);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const layer = String(req.query?.layer ?? "0");

  if (!ALLOWED_LAYERS.has(layer)) {
    return res.status(400).json({ error: "Unsupported BDL layer" });
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(req.query || {})) {
    if (key === "layer") continue;
    if (!ALLOWED_PARAMS.has(key)) continue;

    if (Array.isArray(value)) {
      if (value.length) params.set(key, String(value[0]));
    } else if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }

  if (!params.has("where")) params.set("where", "1=1");
  if (!params.has("f")) params.set("f", "geojson");
  if (!params.has("returnGeometry")) params.set("returnGeometry", "true");
  if (!params.has("outSR")) params.set("outSR", "4326");
  if (!params.has("resultRecordCount")) params.set("resultRecordCount", "500");

  const url = `${SERVICE}/${layer}/query?${params.toString()}`;

  try {
    // Bez własnego limitu zawieszony BDL kończy się platformowym 504 bez
    // treści; z limitem przeglądarka dostaje czytelny błąd JSON.
    const upstream = await fetch(url, {
      headers: {
        Accept: "application/geo+json,application/json",
      },
      signal: AbortSignal.timeout(9000),
    });

    const text = await upstream.text();

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "BDL request failed",
        layer,
        status: upstream.status,
        details: text.slice(0, 1200),
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "BDL returned a non-JSON response",
        layer,
        details: text.slice(0, 1200),
      });
    }

    if (data?.error) {
      return res.status(502).json({
        error: "BDL ArcGIS error",
        layer,
        details: data.error,
      });
    }

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=1800, stale-while-revalidate=86400"
    );

    return res.status(200).json(data);
  } catch (error) {
    return res.status(502).json({
      error: "Could not reach BDL",
      layer,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
