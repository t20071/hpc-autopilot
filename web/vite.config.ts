import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// In `npm run dev`, serve the api/*.ts serverless functions the way Vercel does,
// reading keys from .env in web/ or the repository root.
function localApi(mode: string): Plugin {
  return {
    name: "local-api",
    configureServer(server) {
      Object.assign(process.env, loadEnv(mode, "..", ""), loadEnv(mode, ".", ""));
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/([a-z-]+)$/);
        if (!match) return next();
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const mod = await server.ssrLoadModule(`/api/${match[1]}.ts`).catch(() => null);
        if (!mod) return next();
        const fail = (code: number, error: string) => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error }));
        };
        const shim = {
          status(code: number) {
            res.statusCode = code;
            return shim;
          },
          json(body: unknown) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(body));
          },
        };
        try {
          await mod.default({ method: req.method, headers: req.headers, body: raw || undefined }, shim);
        } catch (err) {
          fail(500, String(err));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), localApi(mode)],
  test: { environment: "node" },
}) as never);
