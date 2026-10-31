import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dunningCases, insights, merchants, sessions, subscriptions, type Db, type Tx } from "@keepwell/db";
import { uuidv7 } from "@keepwell/contracts/fakes";
import { handleRefreshViewsJob } from "./jobs.js";
import { insightsOverview, overviewKpis } from "./queries.js";

// The SQL tests, shared by the Postgres 18 run (queries.test.ts, CI) and any other opener.

export interface OpenedDb {
  db: Db;
  close: () => Promise<void>;
}

const A = "0199b000-0000-7000-8000-00000000000a";
const B = "0199b000-0000-7000-8000-00000000000b";
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const range = { from: "2026-10-19", to: "2026-11-01" };

interface SubSeed {
  planName?: string;
  value?: string;
  unit?: "DAY" | "WEEK" | "MONTH" | "YEAR";
  status?: "ACTIVE" | "CANCELLED";
}

async function seedSubscription(tx: Tx, merchantId: string, n: string, o: SubSeed = {}): Promise<string> {
  const [row] = await tx
    .insert(subscriptions)
    .values({
      merchantId,
      paypalSubscriptionId: `I-${n}`,
      paypalPlanId: "P-1",
      planName: o.planName ?? "Standard",
      status: o.status ?? "ACTIVE",
      intervalUnit: o.unit ?? "MONTH",
      intervalCount: 1,
      priceValue: o.value ?? "12.00",
      priceCurrency: "USD",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      snapshot: {},
      syncedAt: new Date(),
    })
    .returning({ id: subscriptions.id });
  if (!row) throw new Error("seed failed");
  return row.id;
}

async function seedSession(
  tx: Tx,
  merchantId: string,
  subscriptionId: string,
  outcome: "saved_pause" | "saved_discount" | "cancelled" | "abandoned" | null,
  closedAt: string,
): Promise<string> {
  const [row] = await tx
    .insert(sessions)
    .values({
      merchantId,
      subscriptionId,
      channel: "widget",
      policyVersion: 1,
      outcome,
      closedAt: new Date(closedAt),
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error("seed failed");
  return row.id;
}

export function describeQueries(open: () => Promise<OpenedDb>): void {
  describe("insight SQL", () => {
    let opened: OpenedDb;
    let db: Db;
    const sub = { a: "", b: "", annual: "" };

    beforeAll(async () => {
      opened = await open();
      db = opened.db;
      await db.forMerchant(A, async (tx) => {
        await tx.insert(merchants).values({ id: A, slug: "a", name: "A" });
        sub.a = await seedSubscription(tx, A, "A1", { planName: "Standard" });
        sub.annual = await seedSubscription(tx, A, "A2", {
          planName: "Annual",
          value: "120.00",
          unit: "YEAR",
        });
        const basic = await seedSubscription(tx, A, "A3", { planName: "Basic", value: "4.00" });
        await seedSubscription(tx, A, "A4", { planName: "Standard", status: "CANCELLED" });

        // Sessions: boundaries are 2026-10-19T00:00Z (inclusive) and 2026-11-02T00:00Z (exclusive).
        const saved1 = await seedSession(tx, A, sub.a, "saved_pause", "2026-10-19T00:00:00Z");
        const saved2 = await seedSession(tx, A, sub.a, "saved_discount", "2026-11-01T23:59:59Z");
        const cancelled = await seedSession(tx, A, basic, "cancelled", "2026-10-27T10:00:00Z");
        await seedSession(tx, A, sub.a, "saved_pause", "2026-10-18T23:59:59Z"); // before
        await seedSession(tx, A, sub.a, "saved_pause", "2026-11-02T00:00:00Z"); // after
        await seedSession(tx, A, sub.a, "abandoned", "2026-10-28T10:00:00Z"); // neither save nor cancel
        await seedSession(tx, A, sub.a, null, "2026-10-28T10:00:00Z");

        await tx.insert(dunningCases).values([
          {
            merchantId: A,
            subscriptionId: sub.a,
            reasonCode: "x",
            failedCount: 1,
            playbook: "p",
            state: "open",
          },
          {
            merchantId: A,
            subscriptionId: sub.annual,
            reasonCode: "x",
            failedCount: 1,
            playbook: "p",
            state: "open",
          },
          {
            merchantId: A,
            subscriptionId: basic,
            reasonCode: "x",
            failedCount: 1,
            playbook: "p",
            state: "lost",
          },
          {
            merchantId: A,
            subscriptionId: sub.a,
            reasonCode: "x",
            failedCount: 2,
            playbook: "p",
            state: "recovered",
            recoveredValue: "10.00",
            recoveredCurrency: "USD",
            closedAt: new Date("2026-10-20T00:00:00Z"),
          },
          {
            merchantId: A,
            subscriptionId: sub.a,
            reasonCode: "x",
            failedCount: 3,
            playbook: "p",
            state: "recovered",
            recoveredValue: "5.50",
            recoveredCurrency: "USD",
            closedAt: new Date("2026-11-01T12:00:00Z"),
          },
          {
            merchantId: A,
            subscriptionId: sub.a,
            reasonCode: "x",
            failedCount: 4,
            playbook: "p",
            state: "recovered",
            recoveredValue: "9.00",
            recoveredCurrency: "EUR",
            closedAt: new Date("2026-10-25T12:00:00Z"),
          },
          {
            merchantId: A,
            subscriptionId: sub.a,
            reasonCode: "x",
            failedCount: 5,
            playbook: "p",
            state: "recovered",
            recoveredValue: "99.00",
            recoveredCurrency: "USD",
            closedAt: new Date("2026-09-01T12:00:00Z"),
          },
        ]);

        const base = { merchantId: A, sentiment: "negative" as const };
        await tx.insert(insights).values([
          // Sunday 25 Oct and Monday 26 Oct are different ISO weeks (19 Oct and 26 Oct).
          {
            ...base,
            sessionId: saved1,
            reason: "price",
            quote: "too pricey",
            createdAt: new Date("2026-10-25T23:59:59Z"),
          },
          {
            ...base,
            sessionId: saved2,
            reason: "price",
            quote: "still pricey",
            createdAt: new Date("2026-10-26T00:00:00Z"),
          },
          {
            ...base,
            sessionId: cancelled,
            reason: "low_usage",
            quote: "tie one",
            createdAt: new Date("2026-10-27T10:00:00Z"),
          },
          {
            ...base,
            replyId: uuidv7(),
            source: "winback_reply",
            reason: "low_usage",
            quote: "tie two",
            createdAt: new Date("2026-10-27T10:00:00Z"),
          },
          {
            ...base,
            replyId: uuidv7(),
            source: "winback_reply",
            reason: "other",
            quote: null,
            createdAt: new Date("2026-10-28T10:00:00Z"),
          },
          // Out of range.
          {
            ...base,
            replyId: uuidv7(),
            source: "winback_reply",
            reason: "other",
            quote: "old",
            createdAt: new Date("2026-09-01T10:00:00Z"),
          },
        ]);
      });
      await db.forMerchant(B, async (tx) => {
        await tx.insert(merchants).values({ id: B, slug: "b", name: "B" });
        const s = await seedSubscription(tx, B, "B1", { value: "50.00" });
        const closed = await seedSession(tx, B, s, "cancelled", "2026-10-27T10:00:00Z");
        await tx.insert(dunningCases).values({
          merchantId: B,
          subscriptionId: s,
          reasonCode: "x",
          failedCount: 1,
          playbook: "p",
          state: "open",
        });
        await tx.insert(insights).values({
          merchantId: B,
          sessionId: closed,
          reason: "price",
          quote: "B only",
          createdAt: new Date("2026-10-27T10:00:00Z"),
        });
      });
    });

    afterAll(async () => {
      await opened.close();
    });

    describe("overviewKpis", () => {
      it("counts saves and cancels inside the inclusive day range only", async () => {
        const kpis = await overviewKpis(db, A, range);
        expect(kpis).toMatchObject({ saves: 2, cancels: 1 });
        expect(kpis.saveRate).toBeCloseTo(0.6667, 4);
      });

      it("sums recovered revenue per currency as decimal strings within the range", async () => {
        const kpis = await overviewKpis(db, A, range);
        expect(kpis.recoveredRevenue).toEqual([
          { value: "9.00", currency: "EUR" },
          { value: "15.50", currency: "USD" },
        ]);
      });

      it("normalises MRR at risk to months for subscriptions with an open dunning case", async () => {
        const kpis = await overviewKpis(db, A, range);
        // 12.00 monthly + 120.00 yearly = 22.00; the lost case and the cancelled sub are excluded.
        expect(kpis.mrrAtRisk).toEqual([{ value: "22.00", currency: "USD" }]);
      });

      it("returns zeros, a null rate and no money for an empty range", async () => {
        expect(await overviewKpis(db, A, { from: "2025-01-01", to: "2025-01-07" })).toEqual({
          range: { from: "2025-01-01", to: "2025-01-07" },
          saves: 0,
          cancels: 0,
          saveRate: null,
          recoveredRevenue: [],
          mrrAtRisk: [{ value: "22.00", currency: "USD" }],
        });
      });

      it("never mixes in another merchant's rows", async () => {
        const kpis = await overviewKpis(db, B, range);
        expect(kpis).toMatchObject({ saves: 0, cancels: 1, saveRate: 0, recoveredRevenue: [] });
        expect(kpis.mrrAtRisk).toEqual([{ value: "50.00", currency: "USD" }]);
      });

      it("rejects a backwards range", () => {
        expect(() => overviewKpis(db, A, { from: "2026-11-01", to: "2026-10-01" })).toThrow();
      });
    });

    describe("insightsOverview", () => {
      it("shows nothing in the aggregates until the view is refreshed, but quotes are live", async () => {
        const before = await insightsOverview(db, A, range);
        expect(before.total).toBe(0);
        expect(before.topQuotes.length).toBeGreaterThan(0);
      });

      it("aggregates by week, plan, reason and outcome after a refresh, with stable tie order", async () => {
        await handleRefreshViewsJob(db, log);
        const r = await insightsOverview(db, A, range);
        expect(r.total).toBe(5);
        expect(r.byWeek).toEqual([
          { week: "2026-10-19", count: 1 }, // Sunday 25 Oct 23:59:59 stays in the week of Monday 19 Oct
          { week: "2026-10-26", count: 4 }, // Monday 26 Oct 00:00:00 starts the next
        ]);
        // price 2, low_usage 2 (tie → key order), other 1
        expect(r.byReason).toEqual([
          { reason: "low_usage", count: 2 },
          { reason: "price", count: 2 },
          { reason: "other", count: 1 },
        ]);
        expect(r.byPlan).toEqual([
          { plan: "(unknown)", count: 2 }, // the two win-back replies carry no session
          { plan: "Standard", count: 2 },
          { plan: "Basic", count: 1 },
        ]);
        expect(r.byOutcome).toEqual([
          { outcome: "none", count: 2 },
          { outcome: "cancelled", count: 1 },
          { outcome: "saved_discount", count: 1 },
          { outcome: "saved_pause", count: 1 },
        ]);
      });

      it("lists the newest quotes first and breaks timestamp ties on id", async () => {
        const r = await insightsOverview(db, A, range);
        // "tie two" was inserted after "tie one" with the same timestamp, so it has the larger id.
        expect(r.topQuotes.map((q) => q.quote)).toEqual(["tie two", "tie one", "still pricey", "too pricey"]);
        expect((await insightsOverview(db, A, range, 2)).topQuotes).toHaveLength(2);
      });

      it("is idempotent under repeated refreshes", async () => {
        const first = await insightsOverview(db, A, range);
        await handleRefreshViewsJob(db, log);
        await handleRefreshViewsJob(db, log);
        expect(await insightsOverview(db, A, range)).toEqual(first);
      });

      it("returns empty lists for an empty range and keeps merchants apart", async () => {
        const empty = await insightsOverview(db, A, { from: "2025-01-01", to: "2025-01-07" });
        expect(empty).toMatchObject({
          total: 0,
          byWeek: [],
          byPlan: [],
          byReason: [],
          byOutcome: [],
          topQuotes: [],
        });
        const b = await insightsOverview(db, B, range);
        expect(b.total).toBe(1);
        expect(b.topQuotes.map((q) => q.quote)).toEqual(["B only"]);
      });
    });
  });
}
