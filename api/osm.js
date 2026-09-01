const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let query = null;

  if (typeof req.body === "string") {
    query = new URLSearchParams(req.body).get("data");
  } else if (req.body && typeof req.body === "object") {
    query = req.body.data || req.body.query || null;
  }

  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "Missing Overpass query" });
  }

  if (query.length > 20000) {
    return res.status(413).json({ error: "Query too large" });
  }

  const failures = [];

  for (const url of OVERPASS_URLS) {
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "application/json",
          "User-Agent": "zanocuj-map/0.4 (+https://github.com/CiesliixW/zanocuj-map)",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(28000),
      });

      if (!upstream.ok) {
        const body = await upstream.text();
        failures.push(`${url}: HTTP ${upstream.status} ${body.slice(0, 250)}`);
        continue;
      }

      const data = await upstream.json();

      res.setHeader(
        "Cache-Control",
        "public, s-maxage=300, stale-while-revalidate=900"
      );
      res.setHeader("X-Overpass-Endpoint", url);

      return res.status(200).json(data);
    } catch (error) {
      failures.push(
        `${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return res.status(502).json({
    error: "All Overpass endpoints failed",
    details: failures,
  });
}
