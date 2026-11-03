import { describe, expect, it } from "vitest";
import { themeStyles, tokens } from "./index.js";

describe("shared UI theme tokens", () => {
  it("defines light and dark text, surfaces, and semantic colors", () => {
    for (const theme of [tokens.color.light, tokens.color.dark]) {
      expect(theme.text).toBeTruthy();
      expect(theme.surface).toBeTruthy();
      expect(theme.primary).toBeTruthy();
      expect(theme.danger).toBeTruthy();
    }
  });

  it("generates theme-scoped CSS variables for components", () => {
    expect(themeStyles("light")).toContain("--kw-background:#f7f8fa");
    expect(themeStyles("dark")).toContain("--kw-background:#111820");
    expect(themeStyles("dark")).toContain("--kw-space-md:16px");
    expect(themeStyles("dark")).toContain("--kw-radius-md:10px");
  });
});
