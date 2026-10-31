import { readFile } from "node:fs/promises";
import { EvalResults, type EvalMode } from "./metrics.js";

// The latest committed run of each mode (#29 serves them). The files sit next to src/ and dist/, so
// the same URL works from both.

export function resultsUrl(mode: EvalMode): URL {
  return new URL(`../results/${mode}.json`, import.meta.url);
}

/** The latest run, or null when none has been committed yet. Throws if the file is malformed. */
export async function loadResults(url: URL): Promise<EvalResults | null> {
  let raw: string;
  try {
    raw = await readFile(url, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
  return EvalResults.parse(JSON.parse(raw));
}
