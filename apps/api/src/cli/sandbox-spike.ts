import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { PayPalGatewayError, type PayPalSubscription } from "@keepwell/contracts";
import { loadEnv } from "../env.js";
import { PayPalClient } from "../modules/paypal/client.js";
import { MOCK_CREDENTIALS, singleAppCredentials } from "../modules/paypal/credentials.js";
import { recordingFetch, type Exchange } from "../modules/paypal/recorder.js";

// `pnpm spike <step> [--mock]`: spike Q2 and the gateway's assumptions, on the real sandbox (#5).
// One $1.00/day subscription that a person approves as the sandbox buyer, then suspend and
// activate it and see what PayPal does with billing. Every call goes through the gateway, so a
// response our schemas reject shows up here; each one is saved, scrubbed, as a paypal-mock fixture.
//
// A research tool, not a product path: it calls suspend and activate on the gateway directly,
// where the product goes through the action engine. Sandbox only (the gateway refuses live hosts).
// --mock runs the same steps against paypal-mock, to try the script without credentials.

const STEPS = ["setup", "status", "quick", "pause", "resume", "list", "cancel"] as const;
type Step = (typeof STEPS)[number];

const MERCHANT = "sandbox-spike";
const PLAN_NAME = "Keepwell spike: $1.00 a day";
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const args = process.argv.slice(2);
const mock = args.includes("--mock");
const step = z.enum(STEPS).safeParse(args.find((a) => !a.startsWith("--")));
if (!step.success) {
  process.stdout.write(`usage: pnpm spike <${STEPS.join("|")}> [--mock]\n`);
  process.exit(1);
}

const env = loadEnv();
if (!mock && !(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET)) {
  throw new Error(
    "Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env to a sandbox REST app (US business account)",
  );
}

// ---------- where things go ----------

const stateDir = join(ROOT, ".spike");
const statePath = join(stateDir, mock ? "mock.json" : "sandbox.json");
const fixturesDir = (question: string) =>
  mock
    ? join(stateDir, "mock-recordings", question)
    : join(ROOT, "packages/paypal-mock/fixtures/spikes", question);

const State = z.object({
  planId: z.string().optional(),
  subscriptionId: z.string().optional(),
  /** When `pause` ran, and the billing time PayPal showed just before it. */
  pausedAt: z.string().optional(),
  nextBillingBeforePause: z.string().optional(),
});
type State = z.infer<typeof State>;

function loadState(): State {
  if (!existsSync(statePath)) return {};
  return State.parse(JSON.parse(readFileSync(statePath, "utf8")));
}

function saveState(state: State): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

let question = "q2";
let recording = true;
const saved: string[] = [];

function record(exchange: Exchange): void {
  if (!recording) return;
  const dir = fixturesDir(question);
  mkdirSync(dir, { recursive: true });
  const n = readdirSync(dir).filter((f) => f.endsWith(".json")).length + 1;
  const file = join(dir, `${String(n).padStart(2, "0")}-${step.data}-${label(exchange)}.json`);
  writeFileSync(file, `${JSON.stringify(exchange, null, 2)}\n`);
  saved.push(file);
}

/** "post-suspend", "get-subscriptions-id", "get-transactions": enough to find a file again. */
function label({ request }: Exchange): string {
  const segments = request.path.split("?")[0]?.split("/").filter(Boolean) ?? [];
  const last = segments.at(-1) ?? "root";
  const isId = /^(I-|P-|PROD-|WH-)|\d/.test(last);
  return `${request.method.toLowerCase()}-${isId ? `${segments.at(-2) ?? ""}-id` : last}`;
}

const paypal = new PayPalClient({
  baseUrl: mock ? env.PAYPAL_MOCK_URL : env.PAYPAL_API_BASE,
  credentials: singleAppCredentials(
    mock
      ? MOCK_CREDENTIALS
      : // Checked above; the narrowing doesn't survive into this expression.
        { clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "" },
  ),
  log: { info: () => {}, warn: (obj, msg) => out(`  warn: ${msg} ${JSON.stringify(obj)}`) },
  fetch: recordingFetch(record),
});

// ---------- reading what PayPal says ----------

const Extras = z.looseObject({
  billing_info: z
    .looseObject({
      cycle_executions: z.array(z.looseObject({ cycles_completed: z.number().optional() })).optional(),
    })
    .optional(),
});

interface Reading {
  label: string;
  at: string;
  status: string;
  nextBilling: string;
  lastPayment: string;
  outstanding: string;
  failed: string;
  cyclesCompleted: string;
}

function reading(label: string, s: PayPalSubscription): Reading {
  const billing = s.billing_info;
  const cycles = Extras.parse(s).billing_info?.cycle_executions?.[0]?.cycles_completed;
  return {
    label,
    at: new Date().toISOString(),
    status: s.status,
    nextBilling: billing?.next_billing_time ?? "-",
    lastPayment: billing?.last_payment
      ? `${billing.last_payment.amount.value} at ${billing.last_payment.time}`
      : "-",
    outstanding: billing?.outstanding_balance?.value ?? "-",
    failed: String(billing?.failed_payments_count ?? "-"),
    cyclesCompleted: cycles === undefined ? "-" : String(cycles),
  };
}

async function read(label: string): Promise<Reading> {
  return reading(label, await paypal.getSubscription(MERCHANT, subscriptionId()));
}

function table(rows: Reading[]): void {
  const columns: [keyof Reading, string][] = [
    ["label", "when"],
    ["status", "status"],
    ["nextBilling", "next_billing_time"],
    ["lastPayment", "last_payment"],
    ["outstanding", "outstanding"],
    ["failed", "failed"],
    ["cyclesCompleted", "cycles done"],
  ];
  const width = columns.map(([key, title]) => Math.max(title.length, ...rows.map((r) => r[key].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(width[i] ?? 0)).join("  ");
  out(line(columns.map(([, title]) => title)));
  for (const row of rows) out(line(columns.map(([key]) => row[key])));
}

async function transactions(): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const list = await paypal.listTransactions(MERCHANT, subscriptionId(), {
    start: start.toISOString(),
    end: end.toISOString(),
  });
  out(`transactions (last 30 days): ${list.length}`);
  for (const t of list)
    out(`  ${t.time}  ${t.status}  ${t.grossAmount.value} ${t.grossAmount.currency_code}  ${t.id}`);
}

// ---------- the steps ----------

let state = loadState();

function subscriptionId(): string {
  if (!state.subscriptionId) throw new Error("No spike subscription yet: run `pnpm spike setup` first");
  return state.subscriptionId;
}

const steps: Record<Step, () => Promise<void>> = {
  /** A $1.00/day plan (made once), then a new subscription for the buyer to approve. */
  async setup() {
    // The first call fetches the token: a refusal surfaces with PayPal's reason and debug id.
    const plans = await paypal.listPlans(MERCHANT);
    out("OAuth ok");
    const existing = plans.find((p) => p.name === PLAN_NAME && p.status === "ACTIVE");
    let planId = existing?.id;
    if (!planId) {
      const product = await paypal.createProduct(MERCHANT, {
        name: "Keepwell spike",
        requestId: "keepwell-spike-product-1",
      });
      ({ planId } = await paypal.createPlan(MERCHANT, {
        productId: product.id,
        name: PLAN_NAME,
        price: { value: "1.00", currency: "USD" },
        interval: { unit: "DAY", count: 1 },
        requestId: "keepwell-spike-plan-1",
      }));
      out(`created plan ${planId}`);
    } else {
      out(`reusing plan ${planId}`);
    }
    const created = await paypal.createSubscription(MERCHANT, {
      planId,
      customId: "keepwell-spike",
      // example.com is reserved for examples: the buyer lands on a harmless page after approving.
      returnUrl: "https://example.com/?keepwell-spike=approved",
      cancelUrl: "https://example.com/?keepwell-spike=cancelled",
      requestId: `keepwell-spike-subscription-${Date.now()}`,
    });
    state = { planId, subscriptionId: created.id };
    saveState(state);
    out(`\nsubscription ${created.id} is ${created.status}. Open this link and approve it as the`);
    out("sandbox PERSONAL (buyer) account, a US one (spike Q1: India accounts fail):\n");
    out(`  ${created.approveUrl}\n`);
    out("Waiting for the approval (up to 15 minutes; Ctrl-C is safe, `pnpm spike status` checks later)...");
    recording = false;
    let last = "";
    for (const started = Date.now(); Date.now() - started < 15 * 60_000; await sleep(5000)) {
      const { status } = await paypal.getSubscription(MERCHANT, created.id);
      if (status !== last) out(`  ${new Date().toISOString()}  ${status}`);
      last = status;
      if (status === "ACTIVE") break;
    }
    recording = true;
    table([await read("after approval")]);
    await transactions();
  },

  async status() {
    table([await read("now")]);
    await transactions();
  },

  /** A short pause: suspend, activate a few seconds later, and watch billing for a minute. */
  async quick() {
    const rows = [await read("before")];
    await paypal.suspend(MERCHANT, subscriptionId(), "Keepwell spike Q2: short pause");
    rows.push(await read("suspended"));
    await sleep(10_000);
    await paypal.activate(MERCHANT, subscriptionId(), "Keepwell spike Q2: resume");
    rows.push(await read("activated"));
    await sleep(60_000);
    rows.push(await read("+60 s"));
    table(rows);
    await transactions();
  },

  /** Suspends and leaves it: `resume` after the next billing time shows what PayPal does with the missed cycle. */
  async pause() {
    const before = await read("before");
    await paypal.suspend(MERCHANT, subscriptionId(), "Keepwell spike Q2: pause across a billing date");
    table([before, await read("suspended")]);
    state = { ...state, pausedAt: new Date().toISOString(), nextBillingBeforePause: before.nextBilling };
    saveState(state);
    out(`\nRun \`pnpm spike resume\` after ${before.nextBilling} (when the missed charge would have been).`);
  },

  async resume() {
    const due = state.nextBillingBeforePause;
    if (due && Date.parse(due) > Date.now()) {
      out(
        `note: the billing time from before the pause (${due}) hasn't passed yet, so this is the short-pause case`,
      );
    }
    const rows = [await read("suspended")];
    await paypal.activate(MERCHANT, subscriptionId(), "Keepwell spike Q2: resume after a billing date");
    rows.push(await read("activated"));
    await sleep(60_000);
    rows.push(await read("+60 s"));
    table(rows);
    await transactions();
    out(
      "\nRun `pnpm spike status` again in an hour or so: PayPal may charge a missed cycle later, not at once.",
    );
  },

  /** Ends the spike: cancels its subscription so the daily $1.00 sandbox charge stops. Irreversible. */
  async cancel() {
    const rows = [await read("before")];
    await paypal.cancel(MERCHANT, subscriptionId(), "Keepwell spike Q2: done");
    rows.push(await read("cancelled"));
    table(rows);
    await transactions();
    out(
      "\nThe spike subscription is cancelled. `pnpm spike setup` starts a new one if a later spike needs it.",
    );
  },

  /** The reconciler's sweep relies on listing subscriptions (ARCHITECTURE.md §6.3): does PayPal serve it? */
  async list() {
    question = "gateway";
    const checks: [string, Parameters<PayPalClient["listSubscriptions"]>[1]][] = [
      ["by plan", { ...(state.planId && { planIds: [state.planId] }) }],
      ["updated in the last day", { statusUpdatedAfter: new Date(Date.now() - 86_400_000).toISOString() }],
    ];
    for (const [name, query] of checks) {
      try {
        const page = await paypal.listSubscriptions(MERCHANT, query);
        const found = page.items.some((s) => s.id === state.subscriptionId);
        out(
          `${name}: ${page.items.length} on page 1 (total ${page.totalItems ?? "?"}), spike subscription ${found ? "listed" : "NOT listed"}`,
        );
      } catch (err) {
        if (!(err instanceof PayPalGatewayError)) throw err;
        out(`${name}: PayPal refused: ${describe(err)}`);
      }
    }
  },
};

function describe(err: PayPalGatewayError): string {
  const { status, issue, debugId } = err.details;
  return `${err.kind} ${status ?? ""} ${issue ?? ""}: ${err.message} (debug id ${debugId ?? "-"})`;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

try {
  out(`${mock ? "paypal-mock" : "PayPal sandbox"}: ${step.data}\n`);
  await steps[step.data]();
} catch (err) {
  // The raw answer is already saved, so a schema the sandbox breaks is a finding, not a dead end.
  if (err instanceof z.ZodError) out(`\nOur schema rejected PayPal's answer:\n${z.prettifyError(err)}`);
  else if (err instanceof PayPalGatewayError) out(`\nPayPal error: ${describe(err)}`);
  else throw err;
  process.exitCode = 1;
} finally {
  if (saved.length > 0) out(`\n${saved.length} responses saved (scrubbed) under ${fixturesDir(question)}`);
}
