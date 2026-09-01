// Geokodowanie nazw miejscowości. Oba źródła stoją na danych OpenStreetMap:
// Nominatim to natywny geokoder OSM (ten sam, który obsługuje wyszukiwarkę na
// openstreetmap.org), Photon jest zbudowany na tych samych danych i bywa
// dostępny, gdy Nominatim odrzuca ruch z serwerowni.
//
// Zapytania idą przez tę funkcję, a nie wprost z przeglądarki: Nominatim
// wymaga nagłówka User-Agent identyfikującego aplikację, którego przeglądarka
// ustawić nie może.
const USER_AGENT = "zanocuj-map (+https://github.com/CiesliixW/zanocuj-map)";
const POLAND = { west: 14.1, south: 49.0, east: 24.2, north: 54.9 };
const TIMEOUT_MS = 7000;

const PROVIDERS = [
  {
    name: "nominatim",
    url: (q) =>
      "https://nominatim.openstreetmap.org/search?" +
      new URLSearchParams({
        q,
        format: "jsonv2",
        limit: "6",
        countrycodes: "pl",
        "accept-language": "pl",
      }),
    parse: (data) =>
      (Array.isArray(data) ? data : []).map((r) => ({
        name: r.display_name,
        lat: Number(r.lat),
        lon: Number(r.lon),
        // Nominatim oddaje [south, north, west, east] jako napisy.
        bbox: Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null,
      })),
  },
  {
    name: "photon",
    url: (q) =>
      "https://photon.komoot.io/api/?" +
      new URLSearchParams({
        q,
        limit: "6",
        lang: "pl",
        bbox: `${POLAND.west},${POLAND.south},${POLAND.east},${POLAND.north}`,
      }),
    parse: (data) =>
      (data?.features || []).map((f) => {
        const p = f.properties || {};
        const [lon, lat] = f.geometry?.coordinates || [];
        // Photon oddaje extent jako [west, north, east, south].
        const e = p.extent;
        return {
          name: [p.name, p.city, p.county, p.state, p.country].filter(Boolean).join(", "),
          lat: Number(lat),
          lon: Number(lon),
          bbox: Array.isArray(e) && e.length === 4 ? [e[3], e[1], e[0], e[2]] : null,
        };
      }),
  },
];

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const raw = req.query?.q;
  const q = String(Array.isArray(raw) ? raw[0] : raw || "").trim();

  if (q.length < 3) return res.status(400).json({ error: "Query too short" });
  if (q.length > 120) return res.status(413).json({ error: "Query too long" });

  const failures = [];

  for (const provider of PROVIDERS) {
    try {
      const upstream = await fetch(provider.url(q), {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!upstream.ok) {
        const body = (await upstream.text()).slice(0, 150).replace(/\s+/g, " ").trim();
        failures.push(`${provider.name}: HTTP ${upstream.status} ${body}`);
        continue;
      }

      const results = provider
        .parse(await upstream.json())
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon))
        // Aplikacja pokrywa wyłącznie Polskę, więc trafienia spoza kraju
        // byłyby tylko szumem.
        .filter(
          (r) =>
            r.lat >= POLAND.south && r.lat <= POLAND.north &&
            r.lon >= POLAND.west && r.lon <= POLAND.east
        );

      // Pusty wynik z działającego geokodera jest poprawną odpowiedzią -
      // takie miejsce po prostu nie istnieje - i nie może uruchamiać kolejnego
      // dostawcy ani udawać awarii.
      res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
      res.setHeader("X-Geocoder", provider.name);
      return res.status(200).json({ results, source: provider.name });
    } catch (error) {
      failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return res.status(502).json({
    error: "Żaden geokoder nie odpowiedział",
    details: failures,
  });
}
