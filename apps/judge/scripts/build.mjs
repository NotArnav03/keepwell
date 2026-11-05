// Builds Judge Mode's page, a static site, into dist/.
//   node scripts/build.mjs           → dist/
//   node scripts/build.mjs --serve   → http://localhost:5180, rebuilt on every load
//
// The page calls /v1 on its own origin; on Render a rewrite sends /v1/* to the API, as for the
// dashboard and the portal. --serve does the same with a small proxy. Only public values go into
// the page: the sandbox buyer's test login is meant to be shown to judges (sandbox money only).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = process.env;
const apiUrl = (env.API_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const settings = {
  // Empty: same origin, through the rewrite. Set JUDGE_API_BASE only to call the API directly.
  api: (env.JUDGE_API_BASE || "").replace(/\/$/, ""),
  apiOrigin: new URL(apiUrl).origin,
  storeUrl: env.JUDGE_STORE_URL || "http://localhost:5176/",
  dashboardUrl: env.JUDGE_DASHBOARD_URL || "",
  evalsUrl: env.JUDGE_EVALS_URL || "",
  buyerEmail: env.JUDGE_BUYER_EMAIL || "",
  buyerPassword: env.JUDGE_BUYER_PASSWORD || "",
  support: env.JUDGE_SUPPORT_CONTACT || "help@pantryplan.example",
};

const options = {
  absWorkingDir: root,
  entryPoints: { judge: "src/main.tsx" },
  bundle: true,
  // A module script, so the widget's own "install on a script tag with data-api" check stays off.
  format: "esm",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  jsxImportSource: "preact",
  legalComments: "none",
  logLevel: "warning",
};

function page() {
  const attributes = Object.entries({
    "data-api": settings.api,
    "data-api-origin": settings.apiOrigin,
    "data-store-url": settings.storeUrl,
    "data-dashboard-url": settings.dashboardUrl,
    "data-evals-url": settings.evalsUrl,
    "data-buyer-email": settings.buyerEmail,
    "data-buyer-password": settings.buyerPassword,
    "data-support": settings.support,
  })
    .map(([key, value]) => `${key}="${String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`)
    .join(" ");
  return readFileSync(`${root}/public/index.html`, "utf8").replace("data-keepwell-judge", attributes);
}

// Start clean, so nothing from an earlier build or dev session ships.
rmSync(`${root}/dist`, { recursive: true, force: true });
mkdirSync(`${root}/dist`, { recursive: true });
cpSync(`${root}/public`, `${root}/dist`, { recursive: true });
writeFileSync(`${root}/dist/index.html`, page());

if (process.argv[2] === "--serve") {
  const ctx = await esbuild.context({ ...options, outdir: "dist", minify: false, sourcemap: true });
  const built = await ctx.serve({ servedir: "dist", host: "127.0.0.1", port: 5181 });
  const api = new URL(apiUrl);
  // /v1/* and /status go to the API, everything else to esbuild: the local twin of the rewrite.
  createServer((req, res) => {
    const toApi = (req.url?.startsWith("/v1/") || req.url === "/status") ?? false;
    const upstream = request(
      {
        hostname: toApi ? api.hostname : "127.0.0.1",
        port: toApi ? api.port || 80 : built.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(toApi ? `Can't reach the API at ${apiUrl}; is pnpm dev:fake-sessions running?` : "esbuild");
    });
    req.pipe(upstream);
  }).listen(5180, () => {
    process.stdout.write(`Judge Mode: http://localhost:5180/ (/v1 proxied to ${apiUrl})\n`);
  });
} else {
  await esbuild.build({ ...options, outdir: "dist" });
}
