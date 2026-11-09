import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ErrorEnvelope, MerchantApiKeyListResponse, MerchantCreateApiKeyResponse } from "@keepwell/contracts";
import { auditLog, createDb, merchantApiKeys, merchants, type Db } from "@keepwell/db";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "@keepwell/db/testing";
import { loadEnv } from "../../env.js";
import { buildServer } from "../../server.js";
import { DbAudit } from "../audit/log.js";
import { ApiKeyService, apiKeyRoutes, hashApiKey } from "./api-keys.js";
import { MerchantAuthError, type MerchantAuthenticator, type MerchantPrincipal } from "./auth.js";

const A = "0199d000-0000-7000-8000-00000000000a";
const B = "0199d000-0000-7000-8000-00000000000b";
const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });

let testDb: TestDatabase;
let db: Db;
let now = new Date("2026-11-09T10:00:00.000Z");
let service: ApiKeyService;

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "merchant API keys against Postgres",
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      testDb = await createTestDatabase(TEST_DATABASE_URL ?? "");
      db = createDb(testDb.appPool);
      for (const [id, slug] of [
        [A, "alpha"],
        [B, "bravo"],
      ] as const) {
        await db.forMerchant(id, (tx) => tx.insert(merchants).values({ id, slug, name: slug }));
      }
      service = new ApiKeyService({ db, audit: new DbAudit(db, () => now), clock: () => now });
    }, 120_000);

    afterAll(async () => {
      await testDb.drop();
    }, 60_000);

    it("creates a key whose token is shown once and stored only as a hash", async () => {
      const { key, token } = await service.create(A, "owner@alpha.example", {
        name: "Claude Desktop",
        scopes: ["query_metric", "propose_action", "query_metric"],
      });
      expect(token).toMatch(/^kwk_[A-Za-z0-9_-]{43}$/);
      expect(key).toMatchObject({ name: "Claude Desktop", prefix: token.slice(0, 12), lastUsedAt: null });
      expect(key.scopes).toEqual(["query_metric", "propose_action"]);
      const [stored] = await testDb.ownerPool
        .query<{ token_hash: string }>("SELECT token_hash FROM merchant_api_keys WHERE id = $1", [key.id])
        .then((r) => r.rows);
      expect(stored?.token_hash).toBe(hashApiKey(token));
      expect(JSON.stringify(stored)).not.toContain(token);
      // The listing never carries the token.
      const listed = await service.list(A);
      expect(JSON.stringify(listed)).not.toContain(token);
      expect(listed.keys.map((k) => k.id)).toContain(key.id);
    });

    it("authenticates a key to its own merchant and scopes, and records when it was used", async () => {
      const { key, token } = await service.create(A, "o@a.example", {
        name: "reader",
        scopes: ["list_plans"],
      });
      now = new Date("2026-11-09T10:05:00.000Z");
      expect(await service.authenticate(token)).toEqual({
        merchantId: A,
        keyId: key.id,
        scopes: ["list_plans"],
      });
      expect((await service.list(A)).keys.find((k) => k.id === key.id)?.lastUsedAt).toBe(now.toISOString());
      // Used again straight away: the timestamp isn't rewritten on every call.
      now = new Date("2026-11-09T10:05:10.000Z");
      await service.authenticate(token);
      expect((await service.list(A)).keys.find((k) => k.id === key.id)?.lastUsedAt).toBe(
        "2026-11-09T10:05:00.000Z",
      );
    });

    it.each(["", "kwk_", "kwk_not-a-key", "kwd_something", `kwk_${"x".repeat(300)}`])(
      "refuses %j",
      async (token) => {
        expect(await service.authenticate(token)).toBeNull();
      },
    );

    it("stops a revoked key at once, and revoking twice or revoking another merchant's key does nothing", async () => {
      const { key, token } = await service.create(A, "o@a.example", { name: "temp", scopes: ["list_plans"] });
      expect(await service.revoke(B, "o@b.example", key.id)).toBe(false);
      expect(await service.authenticate(token)).not.toBeNull();
      expect(await service.revoke(A, "o@a.example", key.id)).toBe(true);
      expect(await service.authenticate(token)).toBeNull();
      expect(await service.revoke(A, "o@a.example", key.id)).toBe(false);
      expect((await service.list(A)).keys.map((k) => k.id)).not.toContain(key.id);
    });

    it("keeps merchants apart", async () => {
      const mine = await service.create(A, "o@a.example", { name: "a-key", scopes: ["list_plans"] });
      const theirs = await service.create(B, "o@b.example", { name: "b-key", scopes: ["list_plans"] });
      expect((await service.list(A)).keys.map((k) => k.id)).not.toContain(theirs.key.id);
      expect((await service.list(B)).keys.map((k) => k.id)).not.toContain(mine.key.id);
      expect((await service.authenticate(theirs.token))?.merchantId).toBe(B);
      // Row-level security: merchant A's session can't read B's key even by asking for it.
      const rows = await db.forMerchant(A, (tx) =>
        tx.select().from(merchantApiKeys).where(eq(merchantApiKeys.id, theirs.key.id)),
      );
      expect(rows).toEqual([]);
    });

    it("audits creation and revocation by id and name, never the token", async () => {
      const { key, token } = await service.create(B, "o@b.example", {
        name: "audited",
        scopes: ["list_plans"],
      });
      await service.revoke(B, "o@b.example", key.id);
      const entries = await db.forMerchant(B, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.merchantId, B)),
      );
      const mine = entries.filter((e) => (e.subjectIds as Record<string, string>).apiKeyId === key.id);
      expect(mine.map((e) => e.kind)).toEqual(["api_key.created", "api_key.revoked"]);
      expect(mine.every((e) => e.actor === "merchant")).toBe(true);
      expect(JSON.stringify(entries)).not.toContain(token);
    });

    describe("HTTP", () => {
      let app: FastifyInstance;
      let role: MerchantPrincipal["role"] = "owner";
      let signedIn = true;
      let csrf = true;

      const principal = (): MerchantPrincipal => ({
        merchantId: A,
        userId: "u1",
        role,
        csrfToken: "csrf",
        email: "owner@alpha.example",
        merchantSlug: "alpha",
        merchantName: "alpha",
      });
      const authenticator = {
        authenticate: (_request: unknown, checkCsrf = false) => {
          if (!signedIn) return Promise.reject(new MerchantAuthError(401, "Sign in."));
          if (checkCsrf && !csrf) return Promise.reject(new MerchantAuthError(403, "CSRF check failed."));
          return Promise.resolve(principal());
        },
      } as unknown as MerchantAuthenticator;

      beforeAll(async () => {
        app = buildServer(env);
        await app.register(apiKeyRoutes, { prefix: "/v1/m", service, authenticator });
      });
      afterAll(async () => {
        await app.close();
      });

      it("creates (201, no-store), lists and revokes", async () => {
        const created = await app.inject({
          method: "POST",
          url: "/v1/m/api-keys",
          payload: { name: "http key", scopes: ["list_plans"] },
        });
        expect(created.statusCode).toBe(201);
        expect(created.headers["cache-control"]).toBe("no-store");
        const body = MerchantCreateApiKeyResponse.parse(created.json());
        const listed = MerchantApiKeyListResponse.parse(
          (await app.inject({ method: "GET", url: "/v1/m/api-keys" })).json(),
        );
        expect(listed.keys.map((k) => k.id)).toContain(body.key.id);
        expect(JSON.stringify(listed)).not.toContain(body.token);
        expect(
          (await app.inject({ method: "DELETE", url: `/v1/m/api-keys/${body.key.id}` })).statusCode,
        ).toBe(204);
        const again = await app.inject({ method: "DELETE", url: `/v1/m/api-keys/${body.key.id}` });
        expect(again.statusCode).toBe(404);
        expect(ErrorEnvelope.parse(again.json()).error.code).toBe("not_found");
      });

      it.each([
        [{ name: "", scopes: ["list_plans"] }],
        [{ name: "x", scopes: [] }],
        [{ name: "x", scopes: ["root"] }],
        [{ name: "x", scopes: ["list_plans"], admin: true }],
      ])("rejects a bad body %j", async (payload) => {
        const res = await app.inject({ method: "POST", url: "/v1/m/api-keys", payload });
        expect(res.statusCode).toBe(400);
        expect(ErrorEnvelope.parse(res.json()).error.code).toBe("invalid_request");
      });

      it("needs a session, a CSRF token for changes, and not a viewer", async () => {
        signedIn = false;
        expect((await app.inject({ method: "GET", url: "/v1/m/api-keys" })).statusCode).toBe(401);
        signedIn = true;
        csrf = false;
        const noCsrf = await app.inject({
          method: "POST",
          url: "/v1/m/api-keys",
          payload: { name: "x", scopes: ["list_plans"] },
        });
        expect(noCsrf.statusCode).toBe(403);
        csrf = true;
        role = "viewer";
        expect((await app.inject({ method: "GET", url: "/v1/m/api-keys" })).statusCode).toBe(403);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/v1/m/api-keys",
              payload: { name: "x", scopes: ["list_plans"] },
            })
          ).statusCode,
        ).toBe(403);
        role = "owner";
      });

      it("refuses a key id that isn't a uuid", async () => {
        expect((await app.inject({ method: "DELETE", url: "/v1/m/api-keys/nope" })).statusCode).toBe(400);
      });
    });
  },
);
