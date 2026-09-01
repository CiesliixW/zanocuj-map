const originalFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  const isOverpass = url.includes("overpass") || url === "/api/osm";

  if (isOverpass && init?.body) {
    try {
      if (init.body instanceof URLSearchParams) {
        const params = new URLSearchParams(init.body.toString());
        const query = params.get("data");
        if (query) {
          params.set("data", query.replaceAll("out center tags;", "out center;"));
          init = { ...init, body: params };
        }
      } else if (typeof init.body === "string") {
        const params = new URLSearchParams(init.body);
        const query = params.get("data");
        if (query) {
          params.set("data", query.replaceAll("out center tags;", "out center;"));
          init = { ...init, body: params.toString() };
        }
      }
    } catch (error) {
      console.warn("Could not normalize Overpass query", error);
    }
  }

  return originalFetch(input, init);
};

await import("./main.js");
