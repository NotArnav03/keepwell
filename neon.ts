import { defineConfig } from "@neon/config/v1";

// Branches that must live until judging ends (21 Dec): staging and one per member. prod-demo has its
// own Neon project (docs/RUNBOOK-prod-demo.md).
const LONG_LIVED = new Set(["staging", "arnav", "ishan", "aditya", "ayush", "om"]);

export default defineConfig({
  auth: false,
  branch: (branch) => {
    if (branch.isDefault || LONG_LIVED.has(branch.name)) return {};
    if (!branch.exists) {
      // Throwaway branches (`neon checkout <name>`, e.g. to test a migration) expire on their own.
      return { ttl: "7d" };
    }
    return {};
  },
});
