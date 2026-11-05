import type { InsightActionView } from "./schemas.js";
import { intervalLabel, moneyFromUnknown, moneyLabel, reasonLabel, stringParam } from "./format.js";

/** Proposed rows stay at the top. Everything else keeps the order the API sent. */
export function orderActions<T extends { state: string }>(items: readonly T[]): T[] {
  const proposed: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    if (item.state === "proposed") proposed.push(item);
    else rest.push(item);
  }
  return [...proposed, ...rest];
}

/** Swap in the server's row. Callers must pass the response, not a locally guessed state. */
export function replaceAction<T extends { id: string; state: string }>(items: readonly T[], next: T): T[] {
  let found = false;
  const replaced = items.map((item) => {
    if (item.id !== next.id) return item;
    found = true;
    return next;
  });
  return orderActions(found ? replaced : [next, ...replaced]);
}

export function needsApprovalConfirm(kind: string): boolean {
  return kind === "create_plan" || kind === "send_winback_batch";
}

export function executionErrorText(error: InsightActionView["execution"]["error"]): string | null {
  if (error == null || error === "") return null;
  if (typeof error === "string") return error;
  return error.message;
}

export function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item) ids.push(item);
  }
  return ids;
}

/**
 * Restate the proposal with the API's own words: rationale, and the plan fields or estimate
 * it already computed. Win-back ids are not counted here.
 */
export function confirmationCopy(
  action: Pick<InsightActionView, "kind" | "rationale" | "params" | "estimate">,
): string {
  const parts = [action.rationale.trim()];
  if (action.kind === "create_plan") {
    const detail = [
      stringParam(action.params, "name"),
      moneyFromUnknown(action.params.price),
      intervalLabel(action.params.interval),
    ].filter((part): part is string => part !== null);
    if (detail.length > 0) parts.push(detail.join(" · "));
  }
  if (action.kind === "send_winback_batch") {
    const reason = stringParam(action.params, "reason");
    if (reason) parts.push(reasonLabel(reason));
  }
  if (action.estimate) {
    const money = moneyLabel(action.estimate.monthlyRevenueImpact);
    if (money) parts.push(`${money}. ${action.estimate.basis}`);
  }
  return parts.filter((part) => part.length > 0).join(" ");
}
