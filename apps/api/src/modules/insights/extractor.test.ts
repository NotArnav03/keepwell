import { describe, expect, it, vi } from "vitest";
import { FakeAudit, FakeDomainEvents, uuidv7 } from "@keepwell/contracts/fakes";
import { LlmError } from "../agent/index.js";
import { FakeLlmClient } from "../agent/fake-llm.js";
import { InsightExtractor, InsightsRetryLater, type SourceText } from "./extractor.js";
import { FakeInsightStore, FakeReplyReader, FakeSessionReader } from "./fakes.js";
import type { Db } from "@keepwell/db";
import {
  EXTRACT_JOB_OPTIONS,
  REFRESH_VIEWS_CRON,
  enqueueExtract,
  handleExtractJob,
  registerInsights,
  subscribeToSessionClosed,
  type InsightsJobs,
} from "./jobs.js";

const merchantId = uuidv7();
const sessionId = uuidv7();
const replyId = uuidv7();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const source: SourceText = {
  merchantId,
  turns: [
    { role: "agent", text: "What made you want to cancel?" },
    { role: "subscriber", text: "Hi, I'm Maya, maya@example.com. It is too expensive for what I use." },
  ],
  knownNames: ["Maya"],
  knownReason: "price",
  subscriptionId: uuidv7(),
};

const good = {
  reason: "price",
  subReason: "too expensive",
  featureRequests: ["cheaper basic plan"],
  competitor: null,
  sentiment: "negative",
  quote: "Maya says it is too expensive for what I use, call 555 010 7788",
};

function setup() {
  const llm = new FakeLlmClient();
  const store = new FakeInsightStore();
  const audit = new FakeAudit();
  const sessions = new FakeSessionReader().set(sessionId, source);
  const replies = new FakeReplyReader().set(replyId, { ...source, knownReason: null });
  const extractor = new InsightExtractor({ llm, sessions, replies, store, audit, log });
  return { llm, store, audit, extractor };
}

describe("InsightExtractor", () => {
  it("stores a valid extraction with a scrubbed quote and audits it", async () => {
    const { llm, store, audit, extractor } = setup();
    llm.script("classify", { output: good });

    expect(await extractor.extract({ sessionId })).toBe("stored");

    const row = store.rows.get(`s:${sessionId}`);
    expect(row?.record).toMatchObject({ source: "session", sessionId, replyId: null, reason: "price" });
    expect(row?.record.quote).toBe("[name] says it is too expensive for what I use, call [number]");
    expect(audit.byKind("insight.stored")).toHaveLength(1);
    // The model never saw the raw name or email.
    expect(llm.calls[0]?.purpose).toBe("classify");
    expect(llm.calls[0]?.input).not.toMatch(/Maya|maya@example/);
  });

  it("caps an over-long model quote at 20 words", async () => {
    const { llm, store, extractor } = setup();
    const quote = Array.from({ length: 40 }, (_, i) => `w${String(i)}`).join(" ");
    llm.script("classify", { output: { ...good, quote } });
    await extractor.extract({ sessionId });
    expect(store.rows.get(`s:${sessionId}`)?.record.quote?.split(" ")).toHaveLength(20);
  });

  it("regenerates once on invalid output, then succeeds", async () => {
    const { llm, store, extractor } = setup();
    llm.script("classify", { output: { nonsense: true } }, { output: good });
    expect(await extractor.extract({ sessionId })).toBe("stored");
    expect(llm.calls).toHaveLength(2);
    expect(store.rows.size).toBe(1);
  });

  it("falls back after two invalid outputs: session reason, no quote, audited and logged", async () => {
    const { llm, store, audit, extractor } = setup();
    llm.script("classify", { output: { bad: 1 } }, { output: { bad: 2 } });

    expect(await extractor.extract({ sessionId })).toBe("fallback");

    expect(llm.calls).toHaveLength(2);
    expect(store.rows.get(`s:${sessionId}`)?.record).toMatchObject({
      reason: "price",
      quote: null,
      sentiment: "neutral",
      featureRequests: [],
    });
    expect(audit.byKind("insight.fallback_used")).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId }), "insight fallback used");
  });

  it("falls back to reason unknown when the source has none, and does not retry a refusal", async () => {
    const { llm, store, extractor } = setup();
    llm.script("classify", { error: new LlmError("refused", "declined") });
    expect(await extractor.extract({ replyId })).toBe("fallback");
    expect(llm.calls).toHaveLength(1);
    expect(store.rows.get(`r:${replyId}`)?.record).toMatchObject({
      source: "winback_reply",
      sessionId: null,
      replyId,
      reason: "unknown",
    });
  });

  it("skips the model when the subscriber said nothing", async () => {
    const { llm, extractor, store } = setup();
    const quiet = uuidv7();
    const sessions = new FakeSessionReader().set(quiet, {
      ...source,
      turns: [{ role: "agent", text: "hello" }],
    });
    const quietExtractor = new InsightExtractor({
      llm,
      sessions,
      replies: new FakeReplyReader(),
      store,
      audit: new FakeAudit(),
      log,
    });
    expect(await quietExtractor.extract({ sessionId: quiet })).toBe("fallback");
    expect(llm.calls).toHaveLength(0);
    void extractor;
  });

  it("asks to retry later when the model is unavailable, storing nothing", async () => {
    const { llm, store, extractor } = setup();
    llm.script("classify", { error: new LlmError("unavailable", "budget or outage") });
    await expect(extractor.extract({ sessionId })).rejects.toBeInstanceOf(InsightsRetryLater);
    expect(store.rows.size).toBe(0);
  });

  it("is idempotent: a second run does not call the model or store again", async () => {
    const { llm, store, audit, extractor } = setup();
    llm.script("classify", { output: good });
    await extractor.extract({ sessionId });
    expect(await extractor.extract({ sessionId })).toBe("already_extracted");
    expect(llm.calls).toHaveLength(1);
    expect(store.rows.size).toBe(1);
    expect(audit.entries).toHaveLength(1);
  });

  it("reports a missing source without throwing", async () => {
    const { extractor } = setup();
    expect(await extractor.extract({ sessionId: uuidv7() })).toBe("source_missing");
  });
});

function fakeJobs() {
  const sent: { name: string; payload: object; options: object | undefined }[] = [];
  const workers: string[] = [];
  const scheduled: { name: string; cron: string }[] = [];
  const jobs: InsightsJobs = {
    send: (name, payload, options) => {
      sent.push({ name, payload, options });
      return Promise.resolve("job-id");
    },
    work: (name) => {
      workers.push(name);
      return Promise.resolve();
    },
    schedule: (name, cron) => {
      scheduled.push({ name, cron });
      return Promise.resolve();
    },
  };
  return { jobs, sent, workers, scheduled };
}

describe("jobs", () => {
  it("session.closed enqueues one extract job with the retry policy", async () => {
    const events = new FakeDomainEvents();
    const { jobs, sent } = fakeJobs();
    subscribeToSessionClosed(events, jobs, log);
    await events.emit({
      type: "session.closed",
      merchantId,
      payload: { sessionId, subscriptionId: uuidv7(), outcome: "cancelled", reason: "price" },
    });
    expect(sent).toEqual([
      { name: "insights.extract", payload: { sessionId }, options: EXTRACT_JOB_OPTIONS },
    ]);
  });

  it("enqueueExtract sends win-back replies and rejects ambiguous payloads", async () => {
    const { jobs, sent } = fakeJobs();
    await enqueueExtract(jobs, { replyId });
    expect(sent[0]?.payload).toEqual({ replyId });
    await expect(handleExtractJob(setup().extractor, { sessionId, replyId })).rejects.toThrow();
  });

  it("registerInsights subscribes, registers both workers and schedules the hourly refresh", async () => {
    const events = new FakeDomainEvents();
    const { jobs, workers, scheduled } = fakeJobs();
    const { extractor } = setup();
    await registerInsights({ db: {} as Db, jobs, events, extractor, log });
    expect(workers).toEqual(["insights.extract", "insights.refresh_views"]);
    expect(scheduled).toEqual([{ name: "insights.refresh_views", cron: REFRESH_VIEWS_CRON }]);
    // The handler is registered: a second registration under the same name would throw.
    expect(() => events.on("session.closed", "insights.enqueue_extract", () => Promise.resolve())).toThrow();
  });

  it("handleExtractJob propagates retry-later so pg-boss backs off", async () => {
    const { llm, extractor } = setup();
    llm.script("classify", { error: new LlmError("unavailable", "down") });
    await expect(handleExtractJob(extractor, { sessionId })).rejects.toBeInstanceOf(InsightsRetryLater);
  });
});

describe("without an API key", () => {
  it("stores the fallback record and never needs a model", async () => {
    const store = new FakeInsightStore();
    const extractor = new InsightExtractor({
      llm: null,
      sessions: new FakeSessionReader().set(sessionId, source),
      replies: new FakeReplyReader(),
      store,
      audit: new FakeAudit(),
      log,
    });
    expect(await extractor.extract({ sessionId })).toBe("fallback");
    expect(store.rows.get(`s:${sessionId}`)?.record.reason).toBe("price");
  });
});
