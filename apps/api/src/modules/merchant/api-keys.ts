import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ErrorEnvelope,
  MerchantApiKeyListResponse,
  MerchantApiKeyScope,
  MerchantApiKeySummary,
  MerchantCreateApiKeyRequest,
  MerchantCreateApiKeyResponse,
  type Audit,
} from "@keepwell/contracts";
import { merchantApiKeys, type Db, type Tx } from "@keepwell/db";
import { MerchantAuthError, type MerchantAuthenticator } from "./auth.js";

// Keys for the merchant MCP server (#45). A key is `kwk_` plus 32 random bytes; only its sha256 is
// stored, the token is shown once at creation, and a revoked key stops working at once. Creating
// and revoking are audited by id and name, never by token.

const TOKEN_PREFIX = "kwk_";
const SHOWN_PREFIX_LENGTH = 12;
/** `last_used_at` is updated at most this often per key, so a busy agent doesn't write on every call. */
const TOUCH_EVERY_MS = 60_000;

export const hashApiKey = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface ApiKeyGrant {
  merchantId: string;
  keyId: string;
  scopes: MerchantApiKeyScope[];
}

type Row = typeof merchantApiKeys.$inferSelect;

function summary(row: Row): MerchantApiKeySummary {
  return MerchantApiKeySummary.parse({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    // Written only from MerchantApiKeyScope values; parsed so a hand-edited row can't widen a key.
    scopes: row.scopes.map((scope) => MerchantApiKeyScope.parse(scope)),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  });
}

export class ApiKeyService {
  constructor(private readonly deps: { db: Db; audit: Audit<Tx>; clock?: () => Date }) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  async list(merchantId: string): Promise<MerchantApiKeyListResponse> {
    const rows = await this.deps.db.forMerchant(merchantId, (tx) =>
      tx
        .select()
        .from(merchantApiKeys)
        .where(and(eq(merchantApiKeys.merchantId, merchantId), isNull(merchantApiKeys.revokedAt)))
        .orderBy(desc(merchantApiKeys.createdAt), desc(merchantApiKeys.id)),
    );
    return { keys: rows.map(summary) };
  }

  async create(
    merchantId: string,
    userEmail: string,
    request: MerchantCreateApiKeyRequest,
  ): Promise<MerchantCreateApiKeyResponse> {
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const scopes = [...new Set(request.scopes)];
    const row = await this.deps.db.forMerchant(merchantId, async (tx) => {
      const [created] = await tx
        .insert(merchantApiKeys)
        .values({
          merchantId,
          name: request.name,
          prefix: token.slice(0, SHOWN_PREFIX_LENGTH),
          tokenHash: hashApiKey(token),
          scopes,
          createdAt: this.now(),
        })
        .returning();
      if (!created) throw new Error("api key insert returned no row");
      await this.deps.audit.append(
        {
          merchantId,
          actor: "merchant",
          kind: "api_key.created",
          subjectIds: { apiKeyId: created.id },
          payload: { name: created.name, scopes, by: userEmail },
          simulated: false,
        },
        tx,
      );
      return created;
    });
    return MerchantCreateApiKeyResponse.parse({ key: summary(row), token });
  }

  /** False when the key isn't this merchant's or was already revoked. */
  async revoke(merchantId: string, userEmail: string, id: string): Promise<boolean> {
    return this.deps.db.forMerchant(merchantId, async (tx) => {
      const [revoked] = await tx
        .update(merchantApiKeys)
        .set({ revokedAt: this.now() })
        .where(
          and(
            eq(merchantApiKeys.id, id),
            eq(merchantApiKeys.merchantId, merchantId),
            isNull(merchantApiKeys.revokedAt),
          ),
        )
        .returning({ id: merchantApiKeys.id, name: merchantApiKeys.name });
      if (!revoked) return false;
      await this.deps.audit.append(
        {
          merchantId,
          actor: "merchant",
          kind: "api_key.revoked",
          subjectIds: { apiKeyId: revoked.id },
          payload: { name: revoked.name, by: userEmail },
          simulated: false,
        },
        tx,
      );
      return true;
    });
  }

  /** The token arrives before we know the merchant, so this lookup is cross-tenant by its unique hash. */
  async authenticate(token: string): Promise<ApiKeyGrant | null> {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const hash = hashApiKey(token);
    const [row] = await this.deps.db.acrossMerchants((tx) =>
      tx
        .select()
        .from(merchantApiKeys)
        .where(and(eq(merchantApiKeys.tokenHash, hash), isNull(merchantApiKeys.revokedAt)))
        .limit(1),
    );
    if (!row) return null;
    const now = this.now();
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_EVERY_MS) {
      // Bookkeeping only: a failed write must not turn a valid key away.
      await this.deps.db
        .acrossMerchants((tx) =>
          tx
            .update(merchantApiKeys)
            .set({ lastUsedAt: now })
            .where(
              and(
                eq(merchantApiKeys.id, row.id),
                or(
                  isNull(merchantApiKeys.lastUsedAt),
                  lt(merchantApiKeys.lastUsedAt, new Date(now.getTime() - TOUCH_EVERY_MS)),
                ),
              ),
            ),
        )
        .catch(() => undefined);
    }
    return {
      merchantId: row.merchantId,
      keyId: row.id,
      scopes: summary(row).scopes,
    };
  }
}

// ---------- HTTP: /v1/m/api-keys (the dashboard, cookie + CSRF) ----------

export interface ApiKeyRoutesOptions {
  service: ApiKeyService;
  authenticator: MerchantAuthenticator;
}

const IdParams = z.object({ id: z.uuid() });

export const apiKeyRoutes: FastifyPluginCallback<ApiKeyRoutesOptions> = (app, options, done) => {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof MerchantAuthError) return fail(request, reply, error.status, error.message);
    if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number") {
      return fail(request, reply, error.statusCode, error.message);
    }
    request.log.error({ err: error }, "api key route failed");
    return fail(request, reply, 500, "Something went wrong on our side");
  });

  // Keys open the merchant's data to an outside agent, so a viewer can neither list nor change them.
  const owner = async (request: FastifyRequest, write: boolean) => {
    const principal = await options.authenticator.authenticate(request, write);
    if (principal.role === "viewer")
      throw new MerchantAuthError(403, "Only an owner or admin manages API keys.");
    return principal;
  };

  app.get("/api-keys", async (request, reply) => {
    const principal = await owner(request, false);
    return reply.send(MerchantApiKeyListResponse.parse(await options.service.list(principal.merchantId)));
  });

  app.post("/api-keys", { bodyLimit: 4096 }, async (request, reply) => {
    const principal = await owner(request, true);
    const body = MerchantCreateApiKeyRequest.safeParse(request.body);
    if (!body.success) return fail(request, reply, 400, z.prettifyError(body.error));
    const created = await options.service.create(principal.merchantId, principal.email, body.data);
    return reply.code(201).header("cache-control", "no-store").send(created);
  });

  app.delete("/api-keys/:id", async (request, reply) => {
    const principal = await owner(request, true);
    const params = IdParams.safeParse(request.params);
    if (!params.success) return fail(request, reply, 400, "Not a key id.");
    const revoked = await options.service.revoke(principal.merchantId, principal.email, params.data.id);
    if (!revoked) return fail(request, reply, 404, "No such key.");
    return reply.code(204).send();
  });

  done();
};

const CODES: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  429: "rate_limited",
};

function fail(request: FastifyRequest, reply: FastifyReply, status: number, message: string): FastifyReply {
  const code = CODES[status] ?? "internal";
  return reply.code(status).send(ErrorEnvelope.parse({ error: { code, message, requestId: request.id } }));
}
