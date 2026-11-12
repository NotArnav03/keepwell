import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmError, type LlmClient, type LlmPurpose, type StructuredCall } from "../llm.js";
import { PacedLlmClient } from "./paced.js";

const Schema = z.object({ ok: z.boolean() });

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

function innerFailing(times: number, failure: "unavailable" | "invalid_output" = "unavailable") {
  const calls: StructuredCall<z.ZodType>[] = [];
  const llm: LlmClient = {
    structured: <S extends z.ZodType>(call: StructuredCall<S>) => {
      calls.push(call);
      if (calls.length <= times) return Promise.reject(new LlmError(failure, "429"));
      return Promise.resolve({ ok: true } as z.infer<S>);
    },
  };
  return { llm, calls };
}

const call = (purpose: LlmPurpose) => ({
  purpose,
  sessionId: null,
  system: "s",
  input: "i",
  schema: Schema,
  maxTokens: 10,
  signal: new AbortController().signal,
});

const options = (clock: ReturnType<typeof fakeClock>) => ({
  minIntervalMs: 2000,
  retryPurposes: new Set<LlmPurpose>(["simulate", "judge"]),
  retryWaitsMs: [20_000, 40_000],
  retryDeadlineMs: 20_000,
  sleep: clock.sleep,
  now: clock.now,
});

describe("PacedLlmClient", () => {
  it("holds the eval's own calls back until minIntervalMs after the last call, and never the agent's", async () => {
    const clock = fakeClock();
    const { llm } = innerFailing(0);
    const paced = new PacedLlmClient(llm, options(clock));
    await paced.structured(call("simulate")); // first call: no wait
    await paced.structured(call("classify")); // agent: no wait, but it counts as the last call
    await paced.structured(call("converse"));
    expect(clock.sleeps).toEqual([]);
    clock.sleeps.length = 0;
    await clock.sleep(500); // the agent's reply took 500 ms
    await paced.structured(call("judge"));
    expect(clock.sleeps).toEqual([500, 1500]);
  });

  it("lets the eval's own roles wait out a rate limit, with a fresh deadline", async () => {
    const clock = fakeClock();
    const { llm, calls } = innerFailing(2);
    const paced = new PacedLlmClient(llm, options(clock));
    await expect(paced.structured(call("judge"))).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(clock.sleeps).toEqual([20_000, 40_000]);
    expect(calls[1]?.signal).not.toBe(calls[0]?.signal);
  });

  it("gives up once the waits run out", async () => {
    const clock = fakeClock();
    const { llm } = innerFailing(3);
    const paced = new PacedLlmClient(llm, options(clock));
    await expect(paced.structured(call("simulate"))).rejects.toMatchObject({ failure: "unavailable" });
  });

  it("never retries the agent's own calls, so a rate limit still counts as an L1 fallback", async () => {
    const clock = fakeClock();
    const { llm, calls } = innerFailing(1);
    const paced = new PacedLlmClient(llm, options(clock));
    await expect(paced.structured(call("converse"))).rejects.toMatchObject({ failure: "unavailable" });
    expect(calls).toHaveLength(1);
    expect(
      () => new PacedLlmClient(llm, { ...options(clock), retryPurposes: new Set<LlmPurpose>(["classify"]) }),
    ).toThrow(/must not be retried/);
  });

  it("doesn't retry anything but unavailable", async () => {
    const clock = fakeClock();
    const { llm, calls } = innerFailing(1, "invalid_output");
    const paced = new PacedLlmClient(llm, options(clock));
    await expect(paced.structured(call("judge"))).rejects.toMatchObject({ failure: "invalid_output" });
    expect(calls).toHaveLength(1);
  });
});
