import { z } from "zod";
import { APP_ROLE_OPTIONS, createDb } from "@keepwell/db";
import { PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { databaseUrl, loadEnv } from "../env.js";
import { createPool } from "../db.js";
import { provisionMerchantOwner } from "../modules/merchant/provision.js";

const env = loadEnv();
const url = databaseUrl(env);
if (!url) throw new Error("pnpm merchant:user needs DATABASE_URL_UNPOOLED");

const input = z
  .object({
    SEED_MERCHANT_ID: z.uuid().default(PANTRY_PLAN.merchantId),
    MERCHANT_BOOTSTRAP_EMAIL: z.email(),
    MERCHANT_BOOTSTRAP_PASSWORD: z.string().min(12),
  })
  .parse(process.env);

const pool = createPool(
  url,
  (error) => process.stderr.write(`Postgres idle connection error (${error.name})\n`),
  {
    connectionOptions: APP_ROLE_OPTIONS,
    max: 1,
  },
);

try {
  const db = createDb(pool);
  const user = await provisionMerchantOwner(db, {
    merchantId: input.SEED_MERCHANT_ID,
    email: input.MERCHANT_BOOTSTRAP_EMAIL,
    password: input.MERCHANT_BOOTSTRAP_PASSWORD,
  });
  process.stdout.write(`Provisioned merchant owner ${user.id} for merchant ${user.merchantId}.\n`);
} finally {
  await pool.end();
}
