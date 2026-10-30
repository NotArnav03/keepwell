// Builds the one-file widget merchants load with a script tag.
//   node scripts/bundle.mjs           → dist-bundle/v1.js
//   node scripts/bundle.mjs --check   → fails if v1.js is over the 50 KB gzip budget (runs in `pnpm test`)
//   node scripts/bundle.mjs --serve   → http://localhost:5177 with dev/index.html, rebuilt on every load
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const BUDGET_BYTES = 50 * 1024;
const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] ?? "--build";

const options = {
  absWorkingDir: root,
  entryPoints: { v1: "src/index.ts" },
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  legalComments: "none",
  logLevel: "warning",
};

if (mode === "--serve") {
  const ctx = await esbuild.context({ ...options, outdir: "dev", sourcemap: true, minify: false });
  const { port } = await ctx.serve({ servedir: "dev", port: 5177 });
  process.stdout.write(
    `Widget dev page: http://localhost:${port}/?scenario=pause (needs pnpm dev:fake-sessions)\n`,
  );
} else {
  const check = mode === "--check";
  const result = await esbuild.build({ ...options, outdir: "dist-bundle", write: !check });
  const file = check ? result.outputFiles[0] : null;
  const bytes = file ? file.contents : (await import("node:fs")).readFileSync(`${root}/dist-bundle/v1.js`);
  const gzipped = gzipSync(bytes).length;
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  process.stdout.write(
    `v1.js: ${kb(bytes.length)} raw, ${kb(gzipped)} gzipped (budget ${kb(BUDGET_BYTES)})\n`,
  );
  if (gzipped > BUDGET_BYTES) {
    process.stderr.write("The widget is over its 50 KB gzip budget (packages/widget/CLAUDE.md).\n");
    process.exit(1);
  }
}
