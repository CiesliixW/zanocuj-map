const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Funkcja serverless musi zdążyć odpowiedzieć w limicie platformy, inaczej
// przeglądarka dostaje 504 bez treści zamiast czytelnego błędu JSON.
const TOTAL_BUDGET_MS = 9000;
const MIN_ATTEMPT_MS = 2500;

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let query = null;

  // GET pozwala CDN Vercela cache'ować odpowiedź; POST zostaje dla zgodności.
  if (req.method === "GET") {
    const q = req.query?.data;
    query = Array.isArray(q) ? q[0] : q || null;
  } else if (typeof req.body === "string") {
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

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const failures = [];

  for (const url of OVERPASS_URLS) {
    const left = deadline - Date.now();
    if (left < MIN_ATTEMPT_MS) {
      failures.push(`${url}: pominięty, zabrakło czasu`);
      continue;
    }

    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "application/json,text/plain,*/*",
          "User-Agent": "zanocuj-map/0.4 (+https://github.com/CiesliixW/zanocuj-map)",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(left),
      });

      if (!upstream.ok) {
        const body = await upstream.text();
        failures.push(`${url}: HTTP ${upstream.status} ${body.slice(0, 200)}`);
        continue;
      }

      const data = await upstream.json();

      // Wiaty i paleniska zmieniają się rzadko - długi cache zdejmuje ruch
      // z luster Overpass i sprawia, że powtórne widoki są natychmiastowe.
      res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
      res.setHeader("X-Overpass-Endpoint", url);
      res.setHeader("X-Overpass-Count", String(data.elements?.length || 0));

      return res.status(200).json(data);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return res.status(502).json({
    error: "All Overpass endpoints failed",
    details: failures,
  });
}
