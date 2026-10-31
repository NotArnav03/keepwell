import { InsightRecord, type Audit, type AuditAppendInput, type ReasonCategory } from "@keepwell/contracts";
import type { FastifyBaseLogger } from "fastify";
import { LlmError, type LlmClient } from "../agent/index.js";
import { EXTRACT_SYSTEM, ModelInsight, extractInput } from "./prompts.js";
import { scrubQuote, scrubText } from "./scrub.js";

// insights.extract (ARCHITECTURE.md §6.12). Insights are never on the critical path (§9): a model
// that is down means this job retries later, and the session it describes is untouched.

export type SourceRef = { sessionId: string } | { replyId: string };

export interface SourceText {
  merchantId: string;
  /** Subscriber turns and agent turns, oldest first. */
  turns: { role: "subscriber" | "agent"; text: string }[];
  /** Names to remove besides pattern matches: the subscriber's first name. */
  knownNames: string[];
  /** The session's own reason, used when the model can't give one. */
  knownReason: ReasonCategory | null;
}

export interface SessionReader {
  /** null when the session doesn't exist. Looks the merchant up itself (job payloads carry no merchantId). */
  load(sessionId: string): Promise<SourceText | null>;
}

/**
 * Reads a win-back reply. The win-back module owns that table and is not on main yet, so only
 * FakeReplyReader implements this for now; the module (or a follow-up here) supplies the real one.
 */
export interface ReplyReader {
  load(replyId: string): Promise<SourceText | null>;
}

export interface InsightStore {
  exists(merchantId: string, ref: SourceRef): Promise<boolean>;
  /**
   * Inserts the record unless one exists for its source. `onStored` runs in the same transaction,
   * only when a row was inserted. Returns whether it was.
   */
  save(merchantId: string, record: InsightRecord, onStored: (tx: unknown) => Promise<void>): Promise<boolean>;
}

export type ExtractOutcome = "stored" | "fallback" | "already_extracted" | "source_missing";

/** The model is unavailable or over budget: the job should retry later with backoff. */
export class InsightsRetryLater extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InsightsRetryLater";
  }
}

export type InsightsLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

export interface InsightExtractorOptions {
  llm: LlmClient;
  sessions: SessionReader;
  replies: ReplyReader;
  store: InsightStore;
  audit: Audit;
  log: InsightsLogger;
  /** Per-call deadline. Haiku is quick; this only guards a hung connection. */
  timeoutMs?: number;
}

const MAX_ATTEMPTS = 2; // the first try plus one regeneration
const MAX_TRANSCRIPT_CHARS = 12_000;

export class InsightExtractor {
  private readonly timeoutMs: number;

  constructor(private readonly o: InsightExtractorOptions) {
    this.timeoutMs = o.timeoutMs ?? 20_000;
  }

  async extract(ref: SourceRef): Promise<ExtractOutcome> {
    const ids: Record<string, string> =
      "sessionId" in ref ? { sessionId: ref.sessionId } : { replyId: ref.replyId };
    const source =
      "sessionId" in ref ? await this.o.sessions.load(ref.sessionId) : await this.o.replies.load(ref.replyId);
    if (!source) {
      this.o.log.warn(ids, "insight source not found");
      return "source_missing";
    }
    const log = this.o.log;
    const { merchantId } = source;
    if (await this.o.store.exists(merchantId, ref)) return "already_extracted";

    const text = this.transcript(source);
    const hasSubscriberText = source.turns.some((t) => t.role === "subscriber" && t.text.trim() !== "");
    let model: ModelInsight | null = null;
    if (hasSubscriberText) model = await this.askModel(text, { merchantId, ...ids });

    const record = model
      ? this.toRecord(ref, model, source.knownNames)
      : this.fallbackRecord(ref, source.knownReason);
    const used = model ? "stored" : "fallback";

    const entry: AuditAppendInput = {
      merchantId,
      actor: "system",
      kind: used === "stored" ? "insight.stored" : "insight.fallback_used",
      subjectIds: ids,
      payload: { source: record.source, reason: record.reason },
    };
    const inserted = await this.o.store.save(merchantId, record, async (tx) => {
      await this.o.audit.append(entry, tx);
    });
    if (!inserted) return "already_extracted"; // lost a race with another worker
    if (used === "fallback") log.warn({ merchantId, ...ids }, "insight fallback used");
    return used;
  }

  /** Haiku with one regeneration on invalid output. null means "use the fallback". */
  private async askModel(text: string, ctx: object): Promise<ModelInsight | null> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.o.llm.structured({
          purpose: "classify",
          system: EXTRACT_SYSTEM,
          input: extractInput(text),
          schema: ModelInsight,
          maxTokens: 400,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
        if (err.failure === "unavailable") {
          throw new InsightsRetryLater("model unavailable", { cause: err });
        }
        // A refusal would most likely repeat, so it goes straight to the fallback.
        this.o.log.warn({ ...ctx, failure: err.failure, attempt }, "insight extraction output unusable");
        if (err.failure === "refused") return null;
      }
    }
    return null;
  }

  private transcript(source: SourceText): string {
    const lines = source.turns.map((t) => `${t.role === "subscriber" ? "Subscriber" : "Agent"}: ${t.text}`);
    return scrubText(lines.join("\n"), source.knownNames).slice(-MAX_TRANSCRIPT_CHARS);
  }

  private toRecord(ref: SourceRef, m: ModelInsight, names: string[]): InsightRecord {
    return InsightRecord.parse({
      ...this.idFields(ref),
      reason: m.reason,
      subReason: m.subReason === null ? null : scrubText(m.subReason, names),
      featureRequests: m.featureRequests.map((f) => scrubText(f, names)),
      competitor: m.competitor,
      sentiment: m.sentiment,
      quote: scrubQuote(m.quote, names),
    });
  }

  private fallbackRecord(ref: SourceRef, reason: ReasonCategory | null): InsightRecord {
    return InsightRecord.parse({
      ...this.idFields(ref),
      reason: reason ?? "unknown",
      subReason: null,
      featureRequests: [],
      competitor: null,
      sentiment: "neutral",
      quote: null,
    });
  }

  private idFields(ref: SourceRef): Pick<InsightRecord, "sessionId" | "replyId" | "source"> {
    return "sessionId" in ref
      ? { sessionId: ref.sessionId, replyId: null, source: "session" }
      : { sessionId: null, replyId: ref.replyId, source: "winback_reply" };
  }
}
