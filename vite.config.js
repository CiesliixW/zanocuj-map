import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api/bdl": {
        target: "https://mapserver.bdl.lasy.gov.pl",
        changeOrigin: true,
        secure: true,
        rewrite: (path) =>
          path.replace(
            /^\/api\/bdl/,
            "/arcgis/rest/services/Czas_w_las/WFS_BDL_czas_w_las/MapServer/0/query"
          ),
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
