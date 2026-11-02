import type { z } from "zod";
import { LlmError, type LlmClient, type LlmPurpose, type StructuredCall } from "./llm.js";

/** One scripted answer: raw output (validated like the real client would) or a failure. */
export type FakeLlmStep = { output: unknown } | { error: LlmError } | { hang: true };

/**
 * Scripted LlmClient for tests and evals. Steps are queued per purpose and used in order; an
 * empty queue is a test bug, so it throws. `hang` never resolves until the call's signal aborts,
 * which is how tests reach the deadline.
 */
export class FakeLlmClient implements LlmClient {
  readonly calls: { purpose: LlmPurpose; system: string; input: string }[] = [];
  private readonly queues: Record<LlmPurpose, FakeLlmStep[]> = { classify: [], converse: [] };

  script(purpose: LlmPurpose, ...steps: FakeLlmStep[]): this {
    this.queues[purpose].push(...steps);
    return this;
  }

  structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S>> {
    this.calls.push({ purpose: call.purpose, system: call.system, input: call.input });
    const step = this.queues[call.purpose].shift();
    if (!step) throw new Error(`FakeLlmClient: nothing scripted for ${call.purpose}`);
    if ("hang" in step) {
      return new Promise((_, reject) => {
        call.signal.addEventListener("abort", () => {
          reject(new LlmError("unavailable", "aborted", { cause: call.signal.reason }));
        });
      });
    }
    if ("error" in step) return Promise.reject(step.error);
    const parsed = call.schema.safeParse(step.output);
    if (!parsed.success) {
      return Promise.reject(new LlmError("invalid_output", "scripted output failed validation"));
    }
    return Promise.resolve(parsed.data);
  }
}
