import { defineConfig } from "vite";

// W dev nie ma funkcji serverless, a osobna konfiguracja proxy musiałaby
// powielać logikę handlerów z api/ - i rozjeżdżać się z nią przy każdej
// zmianie. Zamiast tego uruchamiamy tu te same pliki, dokładając minimalną
// warstwę zgodności z API Vercela (req.query, req.body, res.status, res.json).
function apiHandlers() {
  return {
    name: "api-handlers-dev",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();

        const url = new URL(req.url, "http://localhost");
        const name = url.pathname.slice("/api/".length);
        if (!/^[a-z0-9-]+$/.test(name)) return next();

        let handler;
        try {
          handler = (await server.ssrLoadModule(`/api/${name}.js`)).default;
        } catch {
          return next();
        }
        if (typeof handler !== "function") return next();

        req.query = Object.fromEntries(url.searchParams);
        req.body = await readBody(req);

        res.status = (code) => {
          res.statusCode = code;
          return res;
        };
        res.json = (data) => {
          if (!res.headersSent) res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
          return res;
        };

        try {
          await handler(req, res);
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
    },
  };
}

async function readBody(req) {
  if (req.method !== "POST" && req.method !== "PUT") return undefined;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;

  const type = req.headers["content-type"] || "";
  if (type.includes("application/json")) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

export default defineConfig({
  plugins: [apiHandlers()],
});
