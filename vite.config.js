import { defineConfig } from "vite";

const BDL_SERVICE =
  "https://mapserver.bdl.lasy.gov.pl/arcgis/rest/services/Czas_w_las/WFS_BDL_czas_w_las/MapServer";

export default defineConfig({
  server: {
    proxy: {
      "/api/bdl": {
        target: "https://mapserver.bdl.lasy.gov.pl",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => {
          const url = new URL(path, "http://localhost");
          const layer = url.searchParams.get("layer") || "0";
          url.searchParams.delete("layer");
          return `${BDL_SERVICE.replace("https://mapserver.bdl.lasy.gov.pl", "")}/${layer}/query?${url.searchParams.toString()}`;
        },
      },
      // W dev nie ma funkcji serverless, więc proxy musi samo dołożyć
      // parametry, które w produkcji ustawia api/geocode.js.
      "/api/geocode": {
        target: "https://nominatim.openstreetmap.org",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => {
          const url = new URL(path, "http://localhost");
          const params = new URLSearchParams({
            q: url.searchParams.get("q") || "",
            format: "jsonv2",
            limit: "6",
            countrycodes: "pl",
            "accept-language": "pl",
          });
          return `/search?${params.toString()}`;
        },
      },
      "/api/osm": {
        target: "https://overpass-api.de",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/osm/, "/api/interpreter"),
      },
    },
  },
});
