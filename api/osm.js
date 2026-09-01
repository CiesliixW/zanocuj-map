const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

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

  try {
    const upstream = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body: new URLSearchParams({ data: query }),
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({
        error: "Overpass request failed",
        status: upstream.status,
        details: body.slice(0, 1000),
      });
    }

    const data = await upstream.json();

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=900"
    );

    return res.status(200).json(data);
  } catch (error) {
    return res.status(502).json({
      error: "Could not reach Overpass",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
