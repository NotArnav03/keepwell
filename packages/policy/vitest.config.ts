import { defineConfig } from "vitest/config";

// The policy engine is the one place the AI can't argue past, so every branch is tested (CLAUDE.md).
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-fixtures.ts"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
