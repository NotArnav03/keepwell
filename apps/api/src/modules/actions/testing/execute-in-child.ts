import pg from "pg";
import { FakeAudit, FakeDomainEvents } from "@keepwell/contracts/fakes";
import { APP_ROLE_OPTIONS, createDb } from "@keepwell/db";
import { PANTRY_PLAN_CREDENTIALS } from "@keepwell/paypal-mock";
import { PayPalClient } from "../../paypal/client.js";
import { singleAppCredentials } from "../../paypal/credentials.js";
import { DbActionEngine } from "../engine.js";

// A worker in its own process, so engine.test.ts can kill it in the middle of a PayPal call and
// check that the Action is recovered without a second call. Test-only: never imported by the app.

const { DATABASE, PAYPAL, MERCHANT_ID, ACTION_ID } = process.env;
if (!DATABASE || !PAYPAL || !MERCHANT_ID || !ACTION_ID) throw new Error("execute-in-child: missing env");

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const pool = new pg.Pool({ connectionString: DATABASE, max: 3, options: APP_ROLE_OPTIONS });
const engine = new DbActionEngine({
  db: createDb(pool),
  lockPool: pool,
  paypal: new PayPalClient({
    baseUrl: PAYPAL,
    credentials: singleAppCredentials(PANTRY_PLAN_CREDENTIALS),
    log: quiet,
    timeoutMs: 60_000,
  }),
  audit: new FakeAudit(),
  events: new FakeDomainEvents(),
  log: quiet,
});

// The parent kills this process while the call below is in flight; it never returns.
await engine.execute(MERCHANT_ID, ACTION_ID);
await pool.end();
