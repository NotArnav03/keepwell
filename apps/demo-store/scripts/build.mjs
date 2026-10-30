// Builds Pantry Plan, the static demo store, into dist/ (a Render static site on its own origin).
//   node scripts/build.mjs           → dist/
//   node scripts/build.mjs --serve   → http://localhost:5176, rebuilt on every load
// Config comes from the environment (root .env when run through pnpm). Only public values: the
// PayPal *client id* is public by design. With no PAYPAL_CLIENT_ID the store runs in fake mode.
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = process.env;
const config = {
  apiBase: (env.API_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, ""),
  widgetBase: (env.WIDGET_CDN_URL || "http://localhost:5177").replace(/\/$/, ""),
  paypalClientId: env.PAYPAL_CLIENT_ID || null,
  plans: [
    {
      key: "lite",
      name: "Lite",
      priceLabel: "$6 / month",
      paypalPlanId: env.PAYPAL_PLAN_LITE || "P-PANTRY-LITE",
    },
    {
      key: "standard",
      name: "Standard",
      priceLabel: "$12 / month",
      paypalPlanId: env.PAYPAL_PLAN_STANDARD || "P-PANTRY-STANDARD",
    },
    {
      key: "annual",
      name: "Standard Annual",
      priceLabel: "$120 / year",
      paypalPlanId: env.PAYPAL_PLAN_ANNUAL || "P-PANTRY-ANNUAL",
    },
  ],
  supportContact: "help@pantryplan.example",
  autopayUrl: "https://www.sandbox.paypal.com/myaccount/autopay/",
};

const options = {
  absWorkingDir: root,
  entryPoints: { store: "src/store.ts", account: "src/account.ts" },
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,
  define: { __PANTRY_PLAN_CONFIG__: JSON.stringify(config) },
  logLevel: "warning",
};

mkdirSync(`${root}/dist`, { recursive: true });
cpSync(`${root}/public`, `${root}/dist`, { recursive: true });

if (process.argv[2] === "--serve") {
  const ctx = await esbuild.context({ ...options, outdir: "dist", minify: false, sourcemap: true });
  const { port } = await ctx.serve({ servedir: "dist", port: 5176 });
  const mode = config.paypalClientId ? "PayPal sandbox" : "FAKE PAYPAL";
  process.stdout.write(`Pantry Plan (${mode}): http://localhost:${port}/ (API ${config.apiBase})\n`);
} else {
  await esbuild.build({ ...options, outdir: "dist" });
}
