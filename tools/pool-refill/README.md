# tools/pool-refill

The refill lives in the API, because it uses the API's gateway and the judge pool (`apps/api/src/modules/pool`): `apps/api/src/cli/pool-refill.ts`, run with:

```bash
pnpm pool:refill 30              # create 30 subscriptions, list their approval links, enrol each once approved
pnpm pool:refill                 # create none: carry on watching the ones from earlier runs
pnpm pool:refill 30 --wait 120   # watch for up to two hours (default 60 minutes)
```

It needs `.env` pointing at the merchant's database and PayPal sandbox app, and `pnpm seed` run first (the pool uses the Standard plan). At most 50 a run; bulk creation only when Arnav or the user asks (tools/CLAUDE.md).

**Approving (spike Q10, the manual path):** each link must be approved in a browser by a **US** sandbox **personal** account. India accounts fail (spike Q1). The links are in `.pool-refill/links.txt` (gitignored), so split them across the team; at about 2 minutes each, 30 per person is an hour. Subscriptions not yet approved are kept in `.pool-refill/<merchantId>.json`, so stopping and re-running loses nothing.

The pool's health job alerts when fewer than 40 are available. Target: 50+ by the feature freeze, 150+ by 1 December.
