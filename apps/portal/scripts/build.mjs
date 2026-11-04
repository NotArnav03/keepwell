// Builds the hosted portal, a static site, into dist/.
//   node scripts/build.mjs           → dist/
//   node scripts/build.mjs --serve   → http://localhost:5178, rebuilt on every load
// Only public values: where the API is, and which merchant this portal belongs to.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = process.env;
const settings = {
  api: (env.API_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, ""),
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
    "data-merchant": settings.merchant,
    "data-merchant-name": settings.merchantName,
    "data-support": settings.support,
  })
    .map(([key, value]) => `${key}="${String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`)
    .join(" ");
  return readFileSync(`${root}/public/index.html`, "utf8").replace("data-keepwell-portal", attributes);
}

mkdirSync(`${root}/dist`, { recursive: true });
cpSync(`${root}/public`, `${root}/dist`, { recursive: true });
writeFileSync(`${root}/dist/index.html`, page());

if (process.argv[2] === "--serve") {
  const ctx = await esbuild.context({ ...options, outdir: "dist", minify: false, sourcemap: true });
  const { port } = await ctx.serve({ servedir: "dist", port: 5178 });
  process.stdout.write(`Hosted portal: http://localhost:${port}/ (API ${settings.api})\n`);
} else {
  await esbuild.build({ ...options, outdir: "dist" });
}
