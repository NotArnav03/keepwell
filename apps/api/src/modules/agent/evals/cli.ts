import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { allPersonas, EvalMode, prSubset, resultsUrl } from "@keepwell/evals";
import { AnthropicLlmClient } from "../anthropic.js";
import { InMemoryLlmUsageStore, LlmBudget } from "../budget.js";
import { GROQ_MODEL_FOR, GroqLlmClient } from "../groq.js";
import { MODEL_FOR, type AgentLogger, type LlmClient, type LlmPurpose } from "../llm.js";
import { PacedLlmClient } from "./paced.js";
import { runEvals } from "./run.js";

// pnpm --filter @keepwell/api eval -- --mode adversarial          (free; all 404 personas)
// pnpm --filter @keepwell/api eval -- --mode real --subset        (costs money; 51 personas)
// pnpm --filter @keepwell/api eval -- --mode real                 (costs money; all 404)
// pnpm --filter @keepwell/api eval -- --mode real --subset --provider groq   (free plan; ADR 0002)
//
// Writes packages/evals/results/<mode>.json unless --out says otherwise. A real run reads
// ANTHROPIC_API_KEY (or GROQ_API_KEY with --provider groq, which defaults to LLM_PROVIDER) from
// the environment or the repo's .env, and stops spending at EVAL_BUDGET_USD (default 1.00):
// sessions after that fall to L1, as they would in production. On Groq, calls are spaced
// --pace-ms apart (default 2500) to stay under the free plan's per-minute limits.

const Provider = z.enum(["anthropic", "groq"]);

const write = (line: string) => process.stderr.write(`${line}\n`);
const log: AgentLogger = {
  info: () => {},
  warn: (obj: unknown, msg?: string) => write(`warn: ${msg ?? ""} ${JSON.stringify(obj)}`),
  error: (obj: unknown, msg?: string) => write(`error: ${msg ?? ""} ${JSON.stringify(obj)}`),
} as AgentLogger;

// One small call before the run. Without it a bad key or an exhausted quota turns every session
// into an L1 fallback and every judgement into "unjudged", and the run still reports the gates as
// passed (L1 never breaks policy), which reads like a result when it is none.
async function preflight(llm: LlmClient, provider: string): Promise<void> {
  try {
    await llm.structured({
      purpose: "classify", // not retried by PacedLlmClient, so a bad key fails at once
      sessionId: null,
      system: 'Answer with JSON: {"ok": true}.',
      input: "ping",
      schema: z.object({ ok: z.boolean() }),
      maxTokens: 64,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`${provider} preflight call failed; check the API key and quota before a real run`, {
      cause: err,
    });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    // `pnpm eval -- --mode real` passes the "--" through.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      mode: { type: "string", default: "adversarial" },
      subset: { type: "boolean", default: false },
      out: { type: "string" },
      provider: { type: "string" },
      "pace-ms": { type: "string" },
    },
  });
  const mode = EvalMode.parse(values.mode);
  const personas = values.subset ? prSubset() : allPersonas();

  let real: { llm: LlmClient; usage: InMemoryLlmUsageStore; models: Record<LlmPurpose, string> } | undefined;
  if (mode === "real") {
    const provider = Provider.parse(values.provider ?? process.env.LLM_PROVIDER ?? "anthropic");
    const dailyBudgetUsd = Number(process.env.EVAL_BUDGET_USD ?? "1.00");
    if (!(dailyBudgetUsd > 0)) throw new Error("EVAL_BUDGET_USD must be a positive number");
    const usage = new InMemoryLlmUsageStore();
    const budget = new LlmBudget({ store: usage, dailyBudgetUsd });
    if (provider === "groq") {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error("GROQ_API_KEY is not set");
      const minIntervalMs = Number(values["pace-ms"] ?? "2500");
      if (!(minIntervalMs >= 0)) throw new Error("--pace-ms must be a number of milliseconds");
      const llm = new PacedLlmClient(new GroqLlmClient({ apiKey, log, budget }), {
        minIntervalMs,
        retryPurposes: new Set<LlmPurpose>(["simulate", "judge"]),
        retryWaitsMs: [20_000, 40_000, 60_000],
        retryDeadlineMs: 20_000,
      });
      real = { llm, usage, models: { ...GROQ_MODEL_FOR } };
    } else {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
      real = {
        llm: new AnthropicLlmClient({ client: new Anthropic({ apiKey }), log, budget }),
        usage,
        models: { ...MODEL_FOR },
      };
    }
    await preflight(real.llm, provider);
    write(`real run on ${provider}: ${personas.length} personas, budget ${dailyBudgetUsd.toFixed(2)}`);
  }

  const results = await runEvals({
    mode,
    personas,
    now: new Date(),
    real,
    log,
    onSession: (done, total) => {
      if (done % 25 === 0 || done === total) write(`${done}/${total}`);
    },
  });
  const out = values.out ?? resultsUrl(mode);
  await writeFile(out, `${JSON.stringify(results, null, 2)}\n`);
  if (real) {
    const spent = real.usage.entries.reduce((sum, e) => sum + e.costNanoUsd, 0) / 1e9;
    write(`spent $${spent.toFixed(4)}`);
  }
  write(`gates ${results.gates.passed ? "PASSED" : "FAILED"}: ${JSON.stringify(results.gates)}`);
  write(`wrote ${typeof out === "string" ? out : out.pathname}`);
  if (!results.gates.passed) process.exitCode = 1;
}

await main();
