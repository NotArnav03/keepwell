import type { MerchantApiKeyScope } from "@keepwell/contracts";

// What the API keys screen says about each scope, and the line that connects a client to the
// merchant MCP server (§6.14). Kept apart from the component so it can be tested.

export const SCOPE_INFO: Record<MerchantApiKeyScope, { label: string; detail: string; reads: boolean }> = {
  query_metric: {
    label: "Query metrics",
    detail: "Saves, cancels, save rate, recovered revenue and MRR at risk over a date range.",
    reads: true,
  },
  search_quotes: {
    label: "Search subscriber quotes",
    detail: "Short, scrubbed quotes from subscribers who left, by reason.",
    reads: true,
  },
  compare_cohorts: {
    label: "Compare two periods",
    detail: "Two date ranges side by side, with the differences.",
    reads: true,
  },
  list_plans: { label: "List plans", detail: "Your plans with price, interval and status.", reads: true },
  list_at_risk: {
    label: "List subscriptions at risk",
    detail: "Open failed-payment cases. No names or emails.",
    reads: true,
  },
  propose_action: {
    label: "Propose actions",
    detail: "Adds a proposal to your Action queue. Nothing happens until you approve it here.",
    reads: false,
  },
};

export const SCOPE_ORDER: MerchantApiKeyScope[] = [
  "query_metric",
  "search_quotes",
  "compare_cohorts",
  "list_plans",
  "list_at_risk",
  "propose_action",
];

/** The scopes ticked on a new key: everything that only reads. Proposing is opt-in. */
export const DEFAULT_SCOPES: MerchantApiKeyScope[] = SCOPE_ORDER.filter((scope) => SCOPE_INFO[scope].reads);

/** The MCP endpoint, when the dashboard knows the API's own address (VITE_API_BASE_URL is absolute). */
export function mcpUrl(apiBase: string | undefined): string | null {
  if (!apiBase || !/^https?:\/\//.test(apiBase)) return null;
  return new URL("/mcp/merchant", apiBase).href;
}

/** The Claude Code command that adds the server; the token is shown once, so it goes in the line. */
export function claudeAddCommand(url: string, token: string): string {
  return `claude mcp add --transport http keepwell-merchant ${url} --header "Authorization: Bearer ${token}"`;
}

/** Toggles one scope in a selection, keeping the canonical order. */
export function toggleScope(
  selected: MerchantApiKeyScope[],
  scope: MerchantApiKeyScope,
): MerchantApiKeyScope[] {
  const next = selected.includes(scope) ? selected.filter((s) => s !== scope) : [...selected, scope];
  return SCOPE_ORDER.filter((s) => next.includes(s));
}
