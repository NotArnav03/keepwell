# tools/seed

The seed lives in the API, because it uses the API's gateway, action engine and reconciler: `apps/api/src/seed.ts`, run with:

```bash
pnpm seed      # uses .env: the mock locally (PAYPAL_USE_MOCK=true), the sandbox on staging and prod-demo
```

It sets up the Pantry Plan demo merchant and is safe to re-run. See the PR for #15 and `apps/api/src/seed.ts` for what it creates. This package is kept for the judge-pool tooling.
