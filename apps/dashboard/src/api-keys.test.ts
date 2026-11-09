import { describe, expect, it } from "vitest";
import { MerchantApiKeyScope } from "@keepwell/contracts";
import {
  claudeAddCommand,
  DEFAULT_SCOPES,
  mcpUrl,
  SCOPE_INFO,
  SCOPE_ORDER,
  toggleScope,
} from "./api-keys.js";

describe("API key scopes", () => {
  it("describes every scope the contract has, once", () => {
    expect([...SCOPE_ORDER].sort()).toEqual([...MerchantApiKeyScope.options].sort());
    expect(Object.keys(SCOPE_INFO).sort()).toEqual([...MerchantApiKeyScope.options].sort());
  });

  it("ticks only read scopes by default: proposing is opt-in", () => {
    expect(DEFAULT_SCOPES).not.toContain("propose_action");
    expect(DEFAULT_SCOPES).toHaveLength(SCOPE_ORDER.length - 1);
  });

  it("toggles a scope on and off, in canonical order", () => {
    const on = toggleScope(["list_plans"], "query_metric");
    expect(on).toEqual(["query_metric", "list_plans"]);
    expect(toggleScope(on, "list_plans")).toEqual(["query_metric"]);
  });
});

describe("MCP connection line", () => {
  it("builds the endpoint from an absolute API base, and says nothing when the base is relative", () => {
    expect(mcpUrl("https://keepwell-api-demo.onrender.com/v1")).toBe(
      "https://keepwell-api-demo.onrender.com/mcp/merchant",
    );
    expect(mcpUrl("/v1")).toBeNull();
    expect(mcpUrl(undefined)).toBeNull();
    expect(mcpUrl("")).toBeNull();
  });

  it("puts the URL and the key into the Claude Code command", () => {
    expect(claudeAddCommand("https://api.example/mcp/merchant", "kwk_abc")).toBe(
      'claude mcp add --transport http keepwell-merchant https://api.example/mcp/merchant --header "Authorization: Bearer kwk_abc"',
    );
  });
});
