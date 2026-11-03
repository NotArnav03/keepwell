import { eq } from "drizzle-orm";
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import {
  ErrorEnvelope,
  MerchantOnboardingBackfillResponse,
  MerchantOnboardingCredentialsRequest,
  MerchantOnboardingCredentialsResponse,
  MerchantOnboardingWebhookResponse,
} from "@keepwell/contracts";
import { merchants, plans, type Db } from "@keepwell/db";
import type { DbAudit } from "../audit/log.js";
import type { Jobs } from "../jobs/jobs.js";
import type { PayPalClient } from "../paypal/client.js";
import type { PayPalCredentials } from "../paypal/credentials.js";
import { WEBHOOK_EVENT_TYPES } from "../../seed.js";
import { encryptPayPalSecret, parseCredentialKey } from "./credentials.js";
import { MerchantAuthError, type MerchantAuthenticator } from "./auth.js";

export class MerchantOnboardingError extends Error {
  override readonly name = "MerchantOnboardingError";

  constructor(
    readonly status: 400 | 401 | 403 | 404 | 422 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MerchantOnboardingRoutesOptions {
  db: Db;
  authenticator: MerchantAuthenticator;
  paypal: Pick<
    PayPalClient,
    "listWebhooks" | "createWebhook" | "listPlans" | "getPlanDetails" | "invalidateToken"
  >;
  audit: DbAudit;
  jobs: Jobs;
  apiPublicUrl: string;
  encryptionKey: string;
  verifyCredentials: (merchantId: string, credentials: PayPalCredentials) => Promise<boolean>;
}

export const merchantOnboardingRoutes: FastifyPluginCallback<MerchantOnboardingRoutesOptions> = (
  app,
  options,
  done,
) => {
  const encryptionKey = parseCredentialKey(options.encryptionKey);
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof MerchantOnboardingError) {
      return sendError(request, reply, error.status, error.code, error.message);
    }
    if (error instanceof MerchantAuthError) {
      const code =
        error.status === 401 ? "unauthorized" : error.status === 429 ? "limit_reached" : "forbidden";
      return sendError(request, reply, error.status, code, error.message);
    }
    request.log.error({ err: error }, "merchant onboarding route failed");
    return sendError(request, reply, 500, "internal", "Something went wrong on our side");
  });

  app.post("/onboarding/credentials", async (request, reply) => {
    const principal = await options.authenticator.authenticate(request, true);
    const input = MerchantOnboardingCredentialsRequest.safeParse(request.body);
    if (!input.success)
      return sendError(request, reply, 400, "invalid_request", "PayPal credentials are invalid.");
    const credentials = { clientId: input.data.clientId, clientSecret: input.data.clientSecret };
    if (!(await options.verifyCredentials(principal.merchantId, credentials))) {
      throw new MerchantOnboardingError(
        422,
        "paypal_credentials_invalid",
        "PayPal could not verify these sandbox credentials.",
      );
    }

    const secretEnc = encryptPayPalSecret(credentials.clientSecret, encryptionKey);
    const storedAt = new Date().toISOString();
    await options.db.forMerchant(principal.merchantId, async (tx) => {
      const updated = await tx
        .update(merchants)
        .set({ paypalClientId: credentials.clientId, paypalSecretEnc: secretEnc })
        .where(eq(merchants.id, principal.merchantId))
        .returning({ id: merchants.id });
      if (updated.length === 0) throw new MerchantOnboardingError(404, "not_found", "Merchant not found.");
      await options.audit.append(
        {
          merchantId: principal.merchantId,
          actor: "merchant",
          kind: "onboarding.credentials_verified",
          subjectIds: { merchantId: principal.merchantId },
          payload: { clientIdSuffix: credentials.clientId.slice(-4) },
        },
        tx,
      );
    });
    options.paypal.invalidateToken(principal.merchantId);
    return reply.send(
      MerchantOnboardingCredentialsResponse.parse({
        verified: true,
        clientIdSuffix: credentials.clientId.slice(-4),
        storedAt,
      }),
    );
  });

  app.post("/onboarding/webhook", async (request, reply) => {
    const principal = await options.authenticator.authenticate(request, true);
    const webhookUrl = `${options.apiPublicUrl.replace(/\/$/, "")}/webhooks/paypal/${principal.merchantId}`;
    const webhooks = await options.paypal.listWebhooks(principal.merchantId);
    const webhookId =
      webhooks.find((webhook) => webhook.url === webhookUrl)?.id ??
      (
        await options.paypal.createWebhook(principal.merchantId, {
          url: webhookUrl,
          eventTypes: WEBHOOK_EVENT_TYPES,
        })
      ).id;
    await options.db.forMerchant(principal.merchantId, async (tx) => {
      await tx.update(merchants).set({ webhookId }).where(eq(merchants.id, principal.merchantId));
      await options.audit.append(
        {
          merchantId: principal.merchantId,
          actor: "merchant",
          kind: "onboarding.webhook_registered",
          subjectIds: { merchantId: principal.merchantId },
          payload: { webhookId },
        },
        tx,
      );
    });
    return reply.send(MerchantOnboardingWebhookResponse.parse({ registered: true, webhookId }));
  });

  app.post("/onboarding/backfill", async (request, reply) => {
    const principal = await options.authenticator.authenticate(request, true);
    const planSummaries = await options.paypal.listPlans(principal.merchantId);
    const planDetails: Awaited<ReturnType<PayPalClient["getPlanDetails"]>>[] = [];
    for (const summary of planSummaries) {
      planDetails.push(await options.paypal.getPlanDetails(principal.merchantId, summary.id));
    }
    const { jobId } = await options.db.forMerchant(principal.merchantId, async (tx) => {
      for (const plan of planDetails) {
        await tx
          .insert(plans)
          .values({
            merchantId: principal.merchantId,
            paypalPlanId: plan.id,
            productId: plan.productId,
            name: plan.name,
            intervalUnit: plan.intervalUnit,
            intervalCount: plan.intervalCount,
            priceValue: plan.priceValue,
            priceCurrency: plan.priceCurrency,
            status: plan.status === "ACTIVE" ? "ACTIVE" : plan.status === "INACTIVE" ? "INACTIVE" : "CREATED",
            syncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [plans.merchantId, plans.paypalPlanId],
            set: {
              productId: plan.productId,
              name: plan.name,
              intervalUnit: plan.intervalUnit,
              intervalCount: plan.intervalCount,
              priceValue: plan.priceValue,
              priceCurrency: plan.priceCurrency,
              status:
                plan.status === "ACTIVE" ? "ACTIVE" : plan.status === "INACTIVE" ? "INACTIVE" : "CREATED",
              syncedAt: new Date(),
            },
          });
      }
      const queuedJobId = await options.jobs.send(
        "reconcile.sweep",
        { merchantId: principal.merchantId },
        { tx },
      );
      await options.audit.append(
        {
          merchantId: principal.merchantId,
          actor: "merchant",
          kind: "onboarding.backfill_started",
          subjectIds: { merchantId: principal.merchantId, ...(queuedJobId ? { jobId: queuedJobId } : {}) },
          payload: { plansImported: planDetails.length, queued: queuedJobId !== null },
        },
        tx,
      );
      return { jobId: queuedJobId };
    });
    const jobIds = jobId ? [jobId] : [];
    return reply.send(MerchantOnboardingBackfillResponse.parse({ jobIds }));
  });

  done();
};

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send(ErrorEnvelope.parse({ error: { code, message, requestId: request.id } }));
}
