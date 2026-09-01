const BDL_URL =
  "https://mapserver.bdl.lasy.gov.pl/arcgis/rest/services/Czas_w_las/WFS_BDL_czas_w_las/MapServer/0/query";

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

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(req.query || {})) {
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
  if (!params.has("resultRecordCount")) params.set("resultRecordCount", "250");

  try {
    const upstream = await fetch(`${BDL_URL}?${params.toString()}`, {
      headers: {
        Accept: "application/geo+json,application/json",
      },
    });

    const contentType = upstream.headers.get("content-type") || "";

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({
        error: "BDL request failed",
        status: upstream.status,
        details: body.slice(0, 1000),
      });
    }

    if (!contentType.includes("json") && !contentType.includes("geo")) {
      const body = await upstream.text();
      return res.status(502).json({
        error: "BDL returned a non-JSON response",
        details: body.slice(0, 1000),
      });
    }

    const data = await upstream.json();

    if (data?.error) {
      return res.status(502).json({
        error: "BDL ArcGIS error",
        details: data.error,
      });
    }

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400"
    );

    return res.status(200).json(data);
  } catch (error) {
    return res.status(502).json({
      error: "Could not reach BDL",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
