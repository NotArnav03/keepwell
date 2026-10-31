import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { allPersonas, EvalMode, prSubset, resultsUrl } from "@keepwell/evals";
import { AnthropicLlmClient } from "../anthropic.js";
import { InMemoryLlmUsageStore, LlmBudget } from "../budget.js";
import type { AgentLogger } from "../llm.js";
import { runEvals } from "./run.js";

// pnpm --filter @keepwell/api eval -- --mode adversarial          (free; all 404 personas)
// pnpm --filter @keepwell/api eval -- --mode real --subset        (costs money; 51 personas)
// pnpm --filter @keepwell/api eval -- --mode real                 (costs money; all 404)
//
// Writes packages/evals/results/<mode>.json unless --out says otherwise. A real run reads
// ANTHROPIC_API_KEY from the environment (or the repo's .env) and stops spending at
// EVAL_BUDGET_USD (default 1.00): sessions after that fall to L1, as they would in production.

const write = (line: string) => process.stderr.write(`${line}\n`);
const log: AgentLogger = {
  info: () => {},
  warn: (obj: unknown, msg?: string) => write(`warn: ${msg ?? ""} ${JSON.stringify(obj)}`),
  error: (obj: unknown, msg?: string) => write(`error: ${msg ?? ""} ${JSON.stringify(obj)}`),
} as AgentLogger;

async function main(): Promise<void> {
  const { values } = parseArgs({
    // `pnpm eval -- --mode real` passes the "--" through.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      mode: { type: "string", default: "adversarial" },
      subset: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const mode = EvalMode.parse(values.mode);
  const personas = values.subset ? prSubset() : allPersonas();

  let real: { llm: AnthropicLlmClient; usage: InMemoryLlmUsageStore } | undefined;
  if (mode === "real") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const dailyBudgetUsd = Number(process.env.EVAL_BUDGET_USD ?? "1.00");
    if (!(dailyBudgetUsd > 0)) throw new Error("EVAL_BUDGET_USD must be a positive number");
    const usage = new InMemoryLlmUsageStore();
    const budget = new LlmBudget({ store: usage, dailyBudgetUsd });
    real = { llm: new AnthropicLlmClient({ client: new Anthropic({ apiKey }), log, budget }), usage };
    write(`real run: ${personas.length} personas, budget $${dailyBudgetUsd.toFixed(2)}`);
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
