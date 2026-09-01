const NOMINATIM = "https://nominatim.openstreetmap.org/search";

// Nominatim wymaga nagłówka identyfikującego aplikację, którego przeglądarka
// ustawić nie może - stąd zapytanie idzie przez tę funkcję, a nie wprost.
const USER_AGENT = "zanocuj-map (+https://github.com/CiesliixW/zanocuj-map)";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const raw = req.query?.q;
  const q = String(Array.isArray(raw) ? raw[0] : raw || "").trim();

  if (q.length < 3) {
    return res.status(400).json({ error: "Query too short" });
  }
  if (q.length > 120) {
    return res.status(413).json({ error: "Query too long" });
  }

  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    limit: "6",
    countrycodes: "pl",
    "accept-language": "pl",
  });

  try {
    const upstream = await fetch(`${NOMINATIM}?${params}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "Geocoder request failed",
        details: (await upstream.text()).slice(0, 300),
      });
    }

    const data = await upstream.json();
    const results = (Array.isArray(data) ? data : []).map((r) => ({
      name: r.display_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
      // Nominatim oddaje [south, north, west, east] jako napisy.
      bbox: Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null,
    }));

    // Nazwy miejscowości praktycznie się nie zmieniają, więc długi cache
    // zdejmuje ruch z Nominatima, który dopuszcza jedno zapytanie na sekundę.
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json({ results });
  } catch (error) {
    return res.status(502).json({
      error: "Could not reach the geocoder",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
