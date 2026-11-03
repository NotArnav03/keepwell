import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { PANTRY_PLAN } from "@keepwell/contracts/fakes";
import { databaseUrl, loadEnv } from "../env.js";
import { checkApproval } from "../modules/pool/refill.js";
import { createCore } from "../platform.js";

// `pnpm pool:refill [count] [--wait <minutes>]`: tops up the judge pool (#15, ARCHITECTURE.md
// §6.17) on whatever PayPal and database the environment points at. It creates `count` new
// subscriptions on the Standard plan and writes their approval links to .pool-refill/links.txt.
// People approve them in a browser as the team's US sandbox buyers (spike Q10: the manual path).
// It watches every 30 seconds and enrols each one in the pool once PayPal shows it ACTIVE.
//
// Each created subscription is saved before the next is made, so a run that stops loses
// nothing: the next run (with or without a count) picks the unapproved ones up again.
// Bulk creation, so only when M1 or the user asks (tools/CLAUDE.md), and at most 50 a run.

const MAX_PER_RUN = 50;
const POLL_MS = 30_000;
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DIR = join(ROOT, ".pool-refill");

const Args = z.object({
  count: z.coerce.number().int().min(0).max(MAX_PER_RUN).default(0),
  wait: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(60),
});
const argv = process.argv.slice(2);
const waitAt = argv.indexOf("--wait");
const { count, wait } = Args.parse({
  count: argv.find((a, i) => !a.startsWith("--") && i !== waitAt + 1),
  wait: waitAt === -1 ? undefined : argv[waitAt + 1],
});

const env = loadEnv();
const url = databaseUrl(env);
if (!url) throw new Error("pnpm pool:refill needs DATABASE_URL_UNPOOLED");
const { SEED_MERCHANT_ID: merchantId } = z
  .object({ SEED_MERCHANT_ID: z.uuid().default(PANTRY_PLAN.merchantId) })
  .parse(process.env);

const Pending = z.array(z.object({ id: z.string(), approveUrl: z.string(), createdAt: z.string() }));
type Pending = z.infer<typeof Pending>;
const pendingPath = join(DIR, `${merchantId}.json`);

function loadPending(): Pending {
  return existsSync(pendingPath) ? Pending.parse(JSON.parse(readFileSync(pendingPath, "utf8"))) : [];
}

function savePending(pending: Pending): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`);
  const lines = pending.map((p, i) => `${String(i + 1).padStart(3)}  ${p.id}  ${p.approveUrl}`);
  writeFileSync(join(DIR, "links.txt"), `${lines.join("\n")}\n`);
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const log = {
  debug: () => {},
  info: () => {},
  warn: (obj: object, msg: string) => process.stderr.write(`warn: ${msg} ${JSON.stringify(obj)}\n`),
  error: (obj: object, msg: string) => process.stderr.write(`error: ${msg} ${JSON.stringify(obj)}\n`),
};

const core = await createCore(env, url, log);
try {
  const plan = (await core.paypal.listPlans(merchantId)).find(
    (p) => p.name === "Standard" && p.status === "ACTIVE",
  );
  if (!plan) throw new Error("No ACTIVE Standard plan at PayPal: run pnpm seed first");

  let pending = loadPending();
  if (pending.length > 0) out(`${pending.length} from earlier runs still waiting for approval`);
  for (let i = 0; i < count; i++) {
    const created = await core.paypal.createSubscription(merchantId, {
      planId: plan.id,
      customId: "keepwell-pool",
      // example.com is reserved for examples: the approver lands on a harmless page.
      returnUrl: "https://example.com/?keepwell-pool=approved",
      cancelUrl: "https://example.com/?keepwell-pool=cancelled",
      requestId: `pool:${merchantId}:${Date.now()}:${i}`,
    });
    pending.push({ id: created.id, approveUrl: created.approveUrl, createdAt: new Date().toISOString() });
    savePending(pending);
  }
  if (count > 0) out(`created ${count} subscriptions on ${plan.name}`);
  savePending(pending);
  if (pending.length > 0) {
    out(`\nApprove each link as a US sandbox PERSONAL (buyer) account; split them across the team.`);
    out(`The list is in ${join(DIR, "links.txt")}\n`);
    pending.forEach((p, i) => out(`${String(i + 1).padStart(3)}  ${p.approveUrl}`));
    out(`\nWatching for approvals for up to ${wait} minutes (Ctrl-C is safe: re-run to carry on)...`);
  }

  const deadline = Date.now() + wait * 60_000;
  let enrolled = 0;
  while (pending.length > 0) {
    const still: Pending = [];
    for (const entry of pending) {
      const check = await checkApproval(core.paypal, merchantId, entry.id);
      if (check.kind === "active") {
        if (await core.judgePool.enroll(merchantId, entry.id)) enrolled++;
        out(`  ${new Date().toISOString()}  ${entry.id} approved, in the pool`);
      } else if (check.kind === "waiting") {
        still.push(entry);
      } else {
        out(`  ${entry.id} is ${check.why}: dropped`);
      }
      // Saved after each one, so a crash mid-round doesn't make the next run redo the round.
      savePending([...still, ...pending.slice(pending.indexOf(entry) + 1)]);
    }
    pending = still;
    savePending(pending);
    if (pending.length === 0 || Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }

  const counts = await core.judgePool.counts(merchantId);
  out(`\nenrolled ${enrolled} this run; ${pending.length} still waiting for approval`);
  out(
    `pool: ${counts.available} available, ${counts.leased} leased, ${counts.restoring} restoring, ${counts.consumed} consumed`,
  );
} finally {
  await core.jobs.stop();
  await core.pool.end();
}
