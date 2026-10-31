import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";

export interface EmailMessage {
  /** The notification id. Sent as the provider's idempotency key, so a retry after a crash can't double-send. */
  id: string;
  to: string;
  subject: string;
  text: string;
  unsubscribeUrl: string;
}

export interface EmailProvider {
  /** Resolves with the provider's message id; throws EmailProviderError on failure. */
  send(message: EmailMessage): Promise<{ providerId: string }>;
}

export class EmailProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Worth retrying later (outage, rate limit) as opposed to a permanent rejection. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailProviderError";
  }
}

const ResendSendResponse = z.object({ id: z.string().min(1) });
const REQUEST_TIMEOUT_MS = 10_000;

export interface ResendProviderOptions {
  apiKey: string;
  baseUrl: string;
  from: string;
  fetch?: typeof fetch;
}

/** Resend's HTTP API over plain fetch (no SDK dependency). */
export class ResendProvider implements EmailProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ResendProviderOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async send(message: EmailMessage): Promise<{ providerId: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": message.id,
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          headers: { "List-Unsubscribe": `<${message.unsubscribeUrl}>` },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure or timeout: the provider is unreachable, which is the "email provider down" case.
      throw new EmailProviderError("network", err instanceof Error ? err.message : "request failed", true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmailProviderError(
        `http_${String(response.status)}`,
        `Resend answered ${String(response.status)}`,
        retryable,
      );
    }
    const body = ResendSendResponse.safeParse(await response.json().catch(() => null));
    if (!body.success) throw new EmailProviderError("bad_response", "Resend sent an unreadable answer", true);
    return { providerId: body.data.id };
  }
}

/** Local development without a Resend key: the message is logged (no body, no address) and "sent". */
export class ConsoleFreeProvider implements EmailProvider {
  constructor(private readonly log: Pick<FastifyBaseLogger, "info">) {}

  send(message: EmailMessage): Promise<{ providerId: string }> {
    this.log.info(
      { notificationId: message.id, subject: message.subject },
      "console email provider: message not sent",
    );
    return Promise.resolve({ providerId: `console:${message.id}` });
  }
}

/** In-memory provider for tests: records what it was asked to send and can be told to fail. */
export class FakeEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  /** Every call, including failed ones. */
  calls = 0;
  private failures: EmailProviderError[] = [];

  /** The next `times` sends fail with this error. */
  failNext(error: EmailProviderError, times = 1): void {
    this.failures = Array.from({ length: times }, () => error);
  }

  send(message: EmailMessage): Promise<{ providerId: string }> {
    this.calls += 1;
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    this.sent.push(message);
    return Promise.resolve({ providerId: `fake:${message.id}` });
  }
}
