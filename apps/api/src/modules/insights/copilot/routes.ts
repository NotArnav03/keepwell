import { PassThrough } from "node:stream";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErrorEnvelope } from "@keepwell/contracts";
import { ChatMessage, FALLBACK_TEXT, type Copilot, type CopilotEvent } from "./runtime.js";

// POST /v1/m/copilot/messages (CONTRACTS.md §4, owner M5): SSE chat. Register with prefix /v1/m.
// The client keeps the conversation and sends it whole; nothing is stored server-side.

export interface CopilotRoutesOptions {
  copilot: Copilot;
  /** Resolves the merchant behind the cookie; rejects with an Error whose `statusCode` is 401. */
  authenticate: (request: FastifyRequest) => Promise<{ merchantId: string }>;
  /** Hard cap on one reply, tool rounds included. */
  deadlineMs?: number;
}

const Body = z.object({ messages: z.array(ChatMessage).min(1).max(20) });
const ClientError = z.object({ statusCode: z.number().int().min(400).max(499), message: z.string() });

/** One SSE frame. */
export const frame = (event: CopilotEvent): string =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export const copilotRoutes: FastifyPluginCallback<CopilotRoutesOptions> = (app, options, done) => {
  app.setErrorHandler((error: unknown, request, reply) => {
    const client = ClientError.safeParse(error);
    const status = client.success ? client.data.statusCode : 500;
    if (!client.success) request.log.error({ err: error }, "copilot route failed");
    const code = status === 401 ? "unauthorized" : status === 500 ? "internal" : "invalid_request";
    const message = client.success ? client.data.message : "Something went wrong on our side";
    return reply.code(status).send(ErrorEnvelope.parse({ error: { code, message, requestId: request.id } }));
  });

  app.post("/copilot/messages", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const { merchantId } = await options.authenticate(request);
    const parsed = Body.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        ErrorEnvelope.parse({
          error: { code: "invalid_request", message: z.prettifyError(parsed.error), requestId: request.id },
        }),
      );
    }
    // Last turn must be the merchant's.
    if (parsed.data.messages.at(-1)?.role !== "user") {
      return reply.code(400).send(
        ErrorEnvelope.parse({
          error: {
            code: "invalid_request",
            message: "the last message must be from the user",
            requestId: request.id,
          },
        }),
      );
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.deadlineMs ?? 60_000);
    const out = new PassThrough();
    out.on("close", () => {
      clearTimeout(timer);
      abort.abort();
    });
    void (async () => {
      try {
        for await (const event of options.copilot.run(merchantId, parsed.data.messages, abort.signal)) {
          if (out.destroyed) return;
          out.write(frame(event));
        }
      } catch (err) {
        // Whatever broke, the chat ends with a clean error event; nothing else is affected.
        request.log.error({ err, merchantId }, "copilot run failed");
        if (!out.destroyed) out.write(frame({ type: "error", code: "unavailable", message: FALLBACK_TEXT }));
      } finally {
        clearTimeout(timer);
        out.end();
      }
    })();

    return reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache, no-transform")
      .header("x-accel-buffering", "no")
      .send(out);
  });

  done();
};
