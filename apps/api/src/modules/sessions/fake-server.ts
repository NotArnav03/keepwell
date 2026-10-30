import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  Id,
  ReasonCategory,
  SessionError,
  canTransition,
  type ActionState,
  type ActionType,
  type Offer,
  type OfferMenu,
  type SubscriberPrincipal,
} from "@keepwell/contracts";
import {
  FakePayPalGateway,
  FakeSessionsApi,
  PANTRY_PLAN,
  pantryPlanSubscription,
  type SessionScript,
} from "@keepwell/contracts/fakes";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { demoStoreRoutes } from "../demo/store-routes.js";
import { verifyWidgetToken } from "../portal/jwt.js";
import { sessionRoutes } from "./routes.js";

// The sessions API on fakes, for building the widget before the real module (#32) exists:
// `pnpm dev:fake-sessions`. FakeAgent talks, and a timer moves each Action the way PayPal would.
// Nothing is stored and nothing leaves this process. Auth is either a fake token that picks a
// scenario (`Authorization: Bearer fake:downgrade`, see GET /) or a real HS256 widget token from
// the demo store's routes, which are mounted here too on a fake PayPal holding I-FAKE-<SCENARIO>.

const SCENARIOS = ["pause", "downgrade", "annual", "discount", "refund", "none", "l1"] as const;
type Scenario = (typeof SCENARIOS)[number];
const Scenario = z.enum(SCENARIOS);
const FakeToken = /^Bearer fake:([a-z0-9]+)(?::(widget|portal))?$/;
const FakeQuery = z.object({ fake: z.string().optional() });

const env = loadEnv();
if (env.APP_ENV !== "local") {
  throw new Error("The fake sessions server is for local development only (APP_ENV=local)");
}
const publicUrl = z
  .url()
  .parse(process.env.API_PUBLIC_URL || `http://localhost:${env.PORT}`)
  .replace(/\/$/, "");
// Local only, so a fixed fallback is fine; WIDGET_TOKEN_SECRET (in .env) wins when set.
const signingSecret = process.env.WIDGET_TOKEN_SECRET || "local-fake-sessions-secret";

// One subscription per scenario, all Maya on Standard, so sessions never cross scenarios.
const now = new Date();
const subscriptions = SCENARIOS.map((scenario, i) =>
  pantryPlanSubscription(now, {
    id: `0199a1b2-c3d4-7e5f-8a6b-${String(i + 1).padStart(12, "0")}`,
    paypalSubscriptionId: `I-FAKE-${scenario.toUpperCase()}`,
  }),
);
const scenarioOf = new Map(subscriptions.map((s, i) => [s.id, SCENARIOS[i] ?? "pause"]));
const maya = pantryPlanSubscription(now);
const nextBilling = maya.nextBillingTime ?? now.toISOString();

const offers = {
  pause: { id: "offer-pause", kind: "pause", cycles: 2, resumesOn: addMonths(nextBilling, 2) },
  downgrade: {
    id: "offer-downgrade",
    kind: "downgrade",
    toPlanId: PANTRY_PLAN.lite.planId,
    toPlanName: PANTRY_PLAN.lite.name,
    newPrice: PANTRY_PLAN.lite.price,
  },
  annual: {
    id: "offer-annual",
    kind: "switch_annual",
    toPlanId: PANTRY_PLAN.annual.planId,
    newPrice: PANTRY_PLAN.annual.price,
    effectiveMonthly: { value: "10.00", currency: "USD" },
  },
  discount: {
    id: "offer-discount",
    kind: "discount",
    percent: 25,
    cycles: 3,
    newPrice: { value: "9.00", currency: "USD" },
    firstAffectedBilling: nextBilling,
  },
  refund: {
    id: "offer-refund",
    kind: "refund_partial",
    amount: { value: "6.00", currency: "USD" },
    ofPaymentOn: maya.lastPayment?.time ?? now.toISOString(),
  },
} satisfies Record<string, Offer>;

const scripts: Record<Scenario, SessionScript> = {
  pause: { menu: menu([offers.pause]) },
  downgrade: { menu: menu([offers.downgrade]) },
  annual: { menu: menu([offers.annual]) },
  discount: { menu: menu([offers.discount]) },
  refund: { menu: menu([offers.refund]) },
  none: { menu: menu([]) },
  // AI down: reason chips, and each chip shows the policy's default offer for it (or none).
  l1: {
    fallbackLevel: "L1",
    menu: menu([offers.pause, offers.downgrade, offers.refund], {
      temporary: offers.pause.id,
      price: offers.downgrade.id,
      low_usage: offers.refund.id,
    }),
  },
};

const api = new FakeSessionsApi({
  subscriptions,
  scripts: Object.fromEntries(subscriptions.map((s) => [s.id, scripts[scenarioOf.get(s.id) ?? "pause"]])),
  streamUrl: (sessionId, principal) =>
    `${publicUrl}/v1/sessions/${sessionId}/stream?fake=${scenarioOf.get(principal.subscriptionId) ?? "pause"}`,
});

const app = buildServer(env);

await app.register(sessionRoutes, {
  prefix: "/v1",
  sessions: api,
  authenticate: (request) => new Promise((resolve) => resolve(principalFor(request))),
  // Any page on any port may call the fake, so the widget can be tried from a third-party origin.
  allowOrigin: () => true,
});

// Pantry Plan's backend, on a fake PayPal that knows each scenario's subscription as ACTIVE.
const gateway = new FakePayPalGateway();
for (const s of subscriptions) {
  gateway.put(PANTRY_PLAN.merchantId, {
    id: s.paypalSubscriptionId,
    plan_id: s.paypalPlanId,
    status: "ACTIVE",
  });
}
await app.register(demoStoreRoutes, {
  prefix: "/v1",
  gateway,
  merchantId: PANTRY_PLAN.merchantId,
  plans: Object.fromEntries(PANTRY_PLAN.plans.map((p) => [p.planId, p.name])),
  signingSecret,
  allowOrigin: () => true,
});

// PayPal's approval page for downgrades and annual switches, faked: Approve or Cancel.
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
  done(null, body),
);
app.get("/fake-paypal/approve/:actionId", (request, reply) => {
  const { actionId } = z.object({ actionId: Id }).parse(request.params);
  return reply.type("text/html; charset=utf-8").send(approvalPage(actionId));
});
app.post("/fake-paypal/approve/:actionId", async (request, reply) => {
  const { actionId } = z.object({ actionId: Id }).parse(request.params);
  const { decision } = z.object({ decision: z.enum(["approve", "cancel"]) }).parse(request.query);
  const moved = await move(actionId, decision === "approve" ? "APPLIED" : "ABANDONED");
  if (moved && decision === "approve") later(actionId, 5000, "CONFIRMED");
  return reply.type("text/html; charset=utf-8")
    .send(`<!doctype html><p>${moved ? "Done" : "Nothing to do"}. You can close this window.</p>
<script>window.close()</script>`);
});

app.get("/", () => ({
  service: "Keepwell fake sessions API (local development only)",
  usage: "Send `Authorization: Bearer fake:<scenario>` (or `fake:<scenario>:portal`). Default: pause.",
  scenarios: SCENARIOS,
}));

// A new Action moves the way PayPal would move it, with roughly sandbox timings.
api.events.on("action.state_changed", "fake.paypal", (event) => {
  const { actionId, type, from } = event.payload;
  if (from === null) playLikePayPal(actionId, type);
  return Promise.resolve();
});

function playLikePayPal(actionId: string, type: ActionType): void {
  later(actionId, 300, "EXECUTING", () => {
    if (type === "revise") {
      // The buyer approves on the fake approval page.
      later(actionId, 700, "AWAITING_BUYER", undefined, `${publicUrl}/fake-paypal/approve/${actionId}`);
    } else {
      // PayPal answers in about a second; its webhook confirms the change seconds later.
      later(actionId, 900, "APPLIED", () => later(actionId, 5000, "CONFIRMED"));
    }
  });
}

function later(actionId: string, ms: number, to: ActionState, then?: () => void, approveUrl?: string): void {
  setTimeout(() => {
    move(actionId, to, approveUrl)
      .then((moved) => {
        if (moved) then?.();
      })
      .catch((err: unknown) => {
        app.log.error({ err, actionId, to }, "fake PayPal step failed");
      });
  }, ms);
}

async function move(actionId: string, to: ActionState, approveUrl?: string): Promise<boolean> {
  const action = await api.actions.get(PANTRY_PLAN.merchantId, actionId);
  // A cancel may have superseded it meanwhile, or the buyer already answered.
  if (!action || !canTransition(action.state, to)) return false;
  await api.actions.transition(actionId, to, approveUrl === undefined ? {} : { approveUrl });
  return true;
}

function principalFor(request: FastifyRequest): SubscriberPrincipal {
  const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer !== undefined && !bearer.startsWith("fake:")) {
    // A real widget token, as the demo store's backend signs it: bound to one PayPal subscription.
    const verified = verifyWidgetToken(bearer, signingSecret, new Date());
    const subscription = verified.ok
      ? subscriptions.find((s) => s.paypalSubscriptionId === verified.claims.sid)
      : undefined;
    if (!verified.ok || !subscription || verified.claims.mid !== subscription.merchantId) {
      throw new SessionError("unauthorized", "Invalid or expired widget token");
    }
    return { merchantId: subscription.merchantId, subscriptionId: subscription.id, channel: "widget" };
  }
  const token = request.headers.authorization?.match(FakeToken);
  const query = FakeQuery.safeParse(request.query);
  const name = token?.[1] ?? (query.success ? query.data.fake : undefined) ?? "pause";
  const scenario = Scenario.safeParse(name);
  if (!scenario.success) {
    throw new SessionError(
      "unauthorized",
      `Unknown fake scenario "${name}"; try one of ${SCENARIOS.join(", ")}`,
    );
  }
  const subscription = subscriptions[SCENARIOS.indexOf(scenario.data)];
  if (!subscription) throw new SessionError("internal", `No subscription for ${scenario.data}`);
  return {
    merchantId: subscription.merchantId,
    subscriptionId: subscription.id,
    channel: token?.[2] === "portal" ? "portal" : "widget",
  };
}

function menu(list: Offer[], defaults: Partial<Record<ReasonCategory, string>> = {}): OfferMenu {
  return {
    policyVersion: PANTRY_PLAN.policy.version,
    computedAt: now.toISOString(),
    offers: list,
    defaultByReason: Object.fromEntries(
      ReasonCategory.options.map((reason) => [reason, defaults[reason] ?? null]),
    ) as Record<ReasonCategory, string | null>,
    excluded: [],
  };
}

function addMonths(iso: string, months: number): string {
  const date = new Date(iso);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString();
}

function approvalPage(actionId: string): string {
  const action = `/fake-paypal/approve/${actionId}`;
  return `<!doctype html>
<meta charset="utf-8"><title>Fake PayPal approval</title>
<main style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto">
  <p><strong>FAKE PAYPAL</strong> (local development only)</p>
  <p>Pantry Plan wants to change your subscription. Approve the change?</p>
  <form method="post">
    <button formaction="${action}?decision=approve">Approve</button>
    <button formaction="${action}?decision=cancel">Cancel</button>
  </form>
</main>`;
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
}

process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));

await app.listen({ host: env.HOST, port: env.PORT });
app.log.info({ scenarios: SCENARIOS }, `fake sessions API ready: ${publicUrl}/v1/sessions`);
