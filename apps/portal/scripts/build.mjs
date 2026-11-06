// Builds the hosted portal, a static site, into dist/.
//   node scripts/build.mjs           → dist/
//   node scripts/build.mjs --serve   → http://localhost:5178, rebuilt on every load
//
// The page calls /v1 on its own origin. On Render a rewrite sends /v1/* to the API (as for the
// dashboard), so the PORTAL cookie is first-party. --serve does the same with a small proxy, so local
// development behaves like the deployed site. Only public values go into the page.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = process.env;
const apiUrl = (env.API_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const settings = {
  // Empty: same origin, through the rewrite. Set PORTAL_API_BASE only to call the API directly.
  api: (env.PORTAL_API_BASE || "").replace(/\/$/, ""),
  // The API's own origin, the only one whose post-approval message the widget believes.
  apiOrigin: new URL(apiUrl).origin,
  merchant: env.PORTAL_MERCHANT_SLUG || "pantry-plan",
  merchantName: env.PORTAL_MERCHANT_NAME || "Pantry Plan",
  support: env.PORTAL_SUPPORT_CONTACT || "help@pantryplan.example",
};

const options = {
  absWorkingDir: root,
  entryPoints: { portal: "src/main.tsx" },
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
    "data-merchant": settings.merchant,
    "data-merchant-name": settings.merchantName,
    "data-support": settings.support,
  })
    .map(([key, value]) => `${key}="${String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`)
    .join(" ");
  return readFileSync(`${root}/public/index.html`, "utf8").replace("data-keepwell-portal", attributes);
}

// Start clean, so nothing from an earlier build or dev session ships.
rmSync(`${root}/dist`, { recursive: true, force: true });
mkdirSync(`${root}/dist`, { recursive: true });
cpSync(`${root}/public`, `${root}/dist`, { recursive: true });
writeFileSync(`${root}/dist/index.html`, page());

if (process.argv[2] === "--serve") {
  const ctx = await esbuild.context({ ...options, outdir: "dist", minify: false, sourcemap: true });
  const built = await ctx.serve({ servedir: "dist", host: "127.0.0.1", port: 5179 });
  const api = new URL(apiUrl);
  // /v1/* goes to the API, everything else to esbuild: the local twin of the Render rewrite.
  createServer((req, res) => {
    const toApi = req.url?.startsWith("/v1/") ?? false;
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
  }).listen(5178, () => {
    process.stdout.write(`Hosted portal: http://localhost:5178/ (/v1 proxied to ${apiUrl})\n`);
  });
} else {
  await esbuild.build({ ...options, outdir: "dist" });
}
