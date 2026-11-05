import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, merchants, subscriptions, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { FakeAudit } from "@keepwell/contracts/fakes";
import { DelegationService } from "./delegations.js";
import { MagicLinkService } from "./magic-link.js";
import { RecordingMailer } from "./memory.js";
import { PgDelegationStore, PgMagicLinkStore, PgPortalDirectory } from "./pg.js";
import { hashEmail, hashToken } from "./tokens.js";

// The portal's Postgres stores against a real database: links are single use even when two
// redeems race, delegations survive as rows, and the directory only matches the right merchant.

const A = "0199c100-0000-7000-8000-0000000000aa";
const B = "0199c100-0000-7000-8000-0000000000bb";
const MAYA = hashEmail("maya@example.com");

let testDb: TestDatabase;
let db: Db;
const subs: Record<string, string> = {};

async function addSubscription(merchantId: string, key: string, emailHash: string | null): Promise<void> {
  const [row] = await db.forMerchant(merchantId, (tx) =>
    tx
      .insert(subscriptions)
      .values({
        merchantId,
        paypalSubscriptionId: `I-${key.toUpperCase()}`,
        paypalPlanId: "P-STANDARD",
        planName: "Standard",
        status: "ACTIVE",
        intervalUnit: "MONTH",
        intervalCount: 1,
        priceValue: "12.00",
        priceCurrency: "USD",
        startedAt: new Date("2026-03-01T00:00:00Z"),
        subscriberEmailHash: emailHash,
        snapshot: {},
        syncedAt: new Date(),
      })
      .returning({ id: subscriptions.id }),
  );
  if (!row) throw new Error("seed failed");
  subs[key] = row.id;
}

describe.skipIf(TEST_DATABASE_URL === undefined)("portal Postgres stores", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
    db = createDb(testDb.appPool);
    for (const [id, slug] of [
      [A, "pantry-plan"],
      [B, "other-shop"],
    ] as const) {
      await db.forMerchant(id, (tx) => tx.insert(merchants).values({ id, slug, name: slug }));
    }
    await addSubscription(A, "maya1", MAYA);
    await addSubscription(A, "maya2", MAYA);
    await addSubscription(A, "raj", hashEmail("raj@example.com"));
    // The same email at another merchant must never show up under A.
    await addSubscription(B, "mayaAtB", MAYA);
  }, 120_000);

  afterAll(async () => {
    await testDb.drop();
  }, 60_000);

  describe("PgPortalDirectory", () => {
    it("finds a merchant by slug, and nothing for an unknown one", async () => {
      const directory = new PgPortalDirectory(db);
      expect(await directory.merchantBySlug("pantry-plan")).toBe(A);
      expect(await directory.merchantBySlug("nope")).toBeNull();
    });

    it("lists only that merchant's subscriptions for the email, oldest first", async () => {
      const directory = new PgPortalDirectory(db);
      expect(await directory.subscriptionsFor(A, MAYA)).toEqual([subs.maya1, subs.maya2]);
      expect(await directory.subscriptionsFor(B, MAYA)).toEqual([subs.mayaAtB]);
      expect(await directory.subscriptionsFor(A, hashEmail("nobody@example.com"))).toEqual([]);
    });

    it("summarises one of that merchant's subscriptions for the portal, and nothing across merchants", async () => {
      const directory = new PgPortalDirectory(db);
      expect(await directory.summary(A, subs.maya1 ?? "")).toEqual({
        id: subs.maya1,
        planName: "Standard",
        price: { value: "12.00", currency: "USD" },
        interval: { unit: "MONTH", count: 1 },
        status: "ACTIVE",
        nextBillingTime: null,
      });
      expect(await directory.summary(B, subs.maya1 ?? "")).toBeNull();
      expect(await directory.summary(A, "0199c100-0000-7000-8000-00000000ffff")).toBeNull();
    });
  });

  describe("PgMagicLinkStore", () => {
    const now = new Date("2026-11-05T10:00:00Z");
    const later = new Date(now.getTime() + 15 * 60_000);

    it("a link works once, and a racing second redeem gets nothing", async () => {
      const store = new PgMagicLinkStore(db);
      await store.put({ tokenHash: hashToken("race"), merchantId: A, emailHash: MAYA, expiresAt: later });
      const results = await Promise.all([
        store.consume(hashToken("race"), now),
        store.consume(hashToken("race"), now),
      ]);
      expect(results.filter((r) => r !== null)).toEqual([
        { tokenHash: hashToken("race"), merchantId: A, emailHash: MAYA, expiresAt: later },
      ]);
      expect(await store.consume(hashToken("race"), now)).toBeNull();
    });

    it("an expired link is refused, and stays spent", async () => {
      const store = new PgMagicLinkStore(db);
      await store.put({ tokenHash: hashToken("old"), merchantId: A, emailHash: MAYA, expiresAt: now });
      expect(await store.consume(hashToken("old"), now)).toBeNull();
      expect(await store.consume(hashToken("old"), new Date(now.getTime() - 60_000))).toBeNull();
    });

    it("an unknown token is refused", async () => {
      expect(await new PgMagicLinkStore(db).consume(hashToken("never-issued"), now)).toBeNull();
    });

    it("stores only the token's hash", async () => {
      const store = new PgMagicLinkStore(db);
      await store.put({
        tokenHash: hashToken("secret-token"),
        merchantId: A,
        emailHash: MAYA,
        expiresAt: later,
      });
      const { rows } = await testDb.ownerPool.query<{ n: string }>(
        "SELECT count(*) AS n FROM magic_links WHERE token_hash = $1 OR token_hash = $2",
        ["secret-token", hashToken("secret-token")],
      );
      expect(rows[0]?.n).toBe("1");
    });

    it("works end to end with MagicLinkService: mailed once, redeemed once", async () => {
      const mailer = new RecordingMailer();
      const service = new MagicLinkService({
        directory: new PgPortalDirectory(db),
        audit: new FakeAudit(),
        store: new PgMagicLinkStore(db),
        mailer,
        verifyUrl: (token) => `https://portal.example/v1/portal/verify?token=${token}`,
        clock: () => now,
      });
      await service.request({ merchantSlug: "pantry-plan", email: " Maya@Example.com " });
      await service.request({ merchantSlug: "pantry-plan", email: "stranger@example.com" });
      expect(mailer.sent).toHaveLength(1);
      const token = new URL(mailer.sent[0]?.url ?? "").searchParams.get("token") ?? "";
      expect(await service.redeem(token)).toEqual({ merchantId: A, emailHash: MAYA });
      expect(await service.redeem(token)).toBeNull();
    });
  });

  describe("PgDelegationStore", () => {
    const now = new Date("2026-11-05T10:00:00Z");

    it("creates, authenticates and revokes through DelegationService", async () => {
      const service = new DelegationService({
        store: new PgDelegationStore(db),
        directory: new PgPortalDirectory(db),
        audit: new FakeAudit(),
        clock: () => now,
      });
      const maya = { merchantId: A, emailHash: MAYA };
      const subscriptionId = subs.maya1 ?? "";
      const created = await service.create(maya, { subscriptionId, scopes: ["read", "cancel"] });

      expect(await service.authenticate(created.token, "cancel")).toEqual({
        merchantId: A,
        subscriptionId,
        scopes: ["read", "cancel"],
      });
      expect(await service.authenticate(created.token, "accept_offer")).toBeNull();

      await service.revoke(maya, created.id);
      await service.revoke(maya, created.id);
      expect(await service.authenticate(created.token, "read")).toBeNull();
      const { rows } = await testDb.ownerPool.query<{ revoked_at: Date }>(
        "SELECT revoked_at FROM delegations WHERE id = $1",
        [created.id],
      );
      expect(rows[0]?.revoked_at).toEqual(now);
    });

    it("can't mint for, or revoke, another subscriber's subscription", async () => {
      const service = new DelegationService({
        store: new PgDelegationStore(db),
        directory: new PgPortalDirectory(db),
        audit: new FakeAudit(),
        clock: () => now,
      });
      const raj = { merchantId: A, emailHash: hashEmail("raj@example.com") };
      await expect(
        service.create(raj, { subscriptionId: subs.maya1 ?? "", scopes: ["read"] }),
      ).rejects.toMatchObject({
        status: 403,
      });
      const mayas = await service.create(
        { merchantId: A, emailHash: MAYA },
        { subscriptionId: subs.maya2 ?? "", scopes: ["read"] },
      );
      await expect(service.revoke(raj, mayas.id)).rejects.toMatchObject({ status: 404 });
      // Same email, other merchant: their session doesn't reach A's delegation either.
      await expect(service.revoke({ merchantId: B, emailHash: MAYA }, mayas.id)).rejects.toMatchObject({
        status: 404,
      });
    });

    it("lists a merchant's delegations on the given subscriptions, newest first", async () => {
      const store = new PgDelegationStore(db);
      const at = (minutes: number) =>
        new DelegationService({
          store,
          directory: new PgPortalDirectory(db),
          audit: new FakeAudit(),
          clock: () => new Date(now.getTime() + minutes * 60_000),
        });
      const maya = { merchantId: A, emailHash: MAYA };
      const older = await at(1).create(maya, { subscriptionId: subs.maya2 ?? "", scopes: ["read"] });
      const newer = await at(2).create(maya, { subscriptionId: subs.maya2 ?? "", scopes: ["cancel"] });

      const listed = await store.listFor(A, [subs.maya2 ?? ""]);
      const ids = listed.map((row) => row.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
      expect(ids.indexOf(older.id)).toBeGreaterThanOrEqual(0);
      expect(listed.every((row) => row.subscriptionId === subs.maya2)).toBe(true);
      // Another merchant's view of the same ids is empty, and no ids means no rows.
      expect(await store.listFor(B, [subs.maya2 ?? ""])).toEqual([]);
      expect(await store.listFor(A, [])).toEqual([]);
    });

    it("an expired delegation doesn't authenticate", async () => {
      const store = new PgDelegationStore(db);
      const minted = new DelegationService({
        store,
        directory: new PgPortalDirectory(db),
        audit: new FakeAudit(),
        clock: () => now,
      });
      const created = await minted.create(
        { merchantId: A, emailHash: MAYA },
        { subscriptionId: subs.maya1 ?? "", scopes: ["read"] },
      );
      const weekLater = new DelegationService({
        store,
        directory: new PgPortalDirectory(db),
        audit: new FakeAudit(),
        clock: () => new Date(now.getTime() + 7 * 24 * 3600_000),
      });
      expect(await weekLater.authenticate(created.token, "read")).toBeNull();
    });
  });
});
