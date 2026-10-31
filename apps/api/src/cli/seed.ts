import { z } from "zod";
import { PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { databaseUrl, loadEnv } from "../env.js";
import { createCore } from "../platform.js";
import { seedDemoMerchant } from "../seed.js";

// `pnpm seed`: sets up the Pantry Plan demo merchant on whatever PayPal and database the
// environment points at (the mock locally, the sandbox on staging and prod-demo). Safe to re-run.
// It changes PayPal (a product, three plans, one webhook) only where those don't exist yet.

const env = loadEnv();
const url = databaseUrl(env);
if (!url) throw new Error("pnpm seed needs DATABASE_URL_UNPOOLED");
const { SEED_MERCHANT_ID: merchantId } = z
  .object({ SEED_MERCHANT_ID: z.uuid().default(PANTRY_PLAN.merchantId) })
  .parse(process.env);
const base = (env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, "");

const log = {
  debug: () => {},
  info: (obj: object, msg: string) => process.stdout.write(`${msg} ${JSON.stringify(obj)}\n`),
  warn: (obj: object, msg: string) => process.stderr.write(`warn: ${msg} ${JSON.stringify(obj)}\n`),
  error: (obj: object, msg: string) => process.stderr.write(`error: ${msg} ${JSON.stringify(obj)}\n`),
};

const core = await createCore(env, url, log);
try {
  await seedDemoMerchant(
    { db: core.db, paypal: core.paypal, engine: core.engine, reconciler: core.reconciler, log },
    { merchantId, webhookUrl: `${base}/webhooks/paypal/${merchantId}` },
  );
} finally {
  await core.jobs.stop();
  await core.pool.end();
}
