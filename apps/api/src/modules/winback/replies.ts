import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { growthJobs, type Audit } from "@keepwell/contracts";
import type { JobQueue, WinbackStore } from "./ports.js";
import { verifyReplyToken } from "./tokens.js";

export const REPLY_MAX_CHARS = 1000;

export const ReplyRequest = z.strictObject({
  token: z.string().min(1).max(1024),
  text: z.string().trim().min(1).max(REPLY_MAX_CHARS),
});
export type ReplyRequest = z.infer<typeof ReplyRequest>;

export type ReplyErrorCode = "invalid_token" | "expired_token" | "token_used";

export class ReplyError extends Error {
  override readonly name = "ReplyError";
  constructor(
    readonly code: ReplyErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
}

export interface ReplyDeps {
  store: WinbackStore;
  audit: Audit;
  jobs: JobQueue;
  log: FastifyBaseLogger;
  tokenSecret: string;
  clock?: () => Date;
}

/**
 * Stores the reply, flips the case to `replied` (this is what makes the token single-use), queues
 * insights.extract and audits, all in one transaction. Wrong-merchant or unknown cases look the
 * same as a bad token, so the endpoint reveals nothing about other tenants.
 */
export async function recordReply(deps: ReplyDeps, request: ReplyRequest): Promise<{ replyId: string }> {
  const now = (deps.clock ?? (() => new Date()))();
  const checked = verifyReplyToken(deps.tokenSecret, request.token, now);
  if (!checked.ok) {
    throw new ReplyError(checked.reason === "expired" ? "expired_token" : "invalid_token", 401);
  }
  const { merchantId, caseId } = checked.claims;

  return deps.store.withMerchant(merchantId, async (repo, tx) => {
    const winback = await repo.getCase(caseId);
    if (!winback) throw new ReplyError("invalid_token", 401);
    if (winback.state === "replied") throw new ReplyError("token_used", 409);
    if (winback.state !== "sent") throw new ReplyError("invalid_token", 401);
    if (!(await repo.transition(caseId, "sent", { state: "replied" }))) {
      throw new ReplyError("token_used", 409);
    }
    const reply = await repo.insertReply({
      merchantId,
      caseId,
      subscriptionId: winback.subscriptionId,
      text: request.text,
    });
    await deps.jobs.send(
      "insights.extract",
      { replyId: reply.id },
      { singletonKey: growthJobs["insights.extract"].idempotencyKey({ replyId: reply.id }) },
      tx,
    );
    await deps.audit.append(
      {
        merchantId,
        actor: "subscriber",
        kind: "winback.reply_received",
        subjectIds: { subscriptionId: winback.subscriptionId, winbackCaseId: caseId, replyId: reply.id },
        // Length only: the text itself may carry personal details and stays in winback_replies.
        payload: { length: request.text.length, ...(winback.simulated && { simulated: true }) },
        simulated: winback.simulated,
      },
      tx,
    );
    deps.log.info(
      { merchantId, subscriptionId: winback.subscriptionId, replyId: reply.id },
      "winback reply stored",
    );
    return { replyId: reply.id };
  });
}
