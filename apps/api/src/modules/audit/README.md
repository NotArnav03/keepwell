# modules/audit (owner: Arnav, M1)

The tamper-evident audit log (ARCHITECTURE.md §6.16). `DbAudit` implements the `Audit` contract: every side effect appends one entry, in the caller's transaction, so the entry commits or rolls back with the change it records.

```ts
await db.forMerchant(merchantId, async (tx) => {
  // …the side effect…
  await audit.append({ merchantId, actor: "subscriber", kind: "offer.accepted", subjectIds, payload }, tx);
});
```

- **Hash chain per merchant:** `hash = sha256(prevHash ‖ canonicalJson(entry without hash))`, starting from `GENESIS_HASH`. It's the same rule as `FakeAudit`, and a test checks the two agree.
- **Linear:** appends for one merchant take a transaction-scoped advisory lock, so `seq` is 1, 2, 3… with no forks, even when many appends race. Other merchants aren't blocked.
- **Append-only, three layers deep:**
  1. the app role (`keepwell_app`) has no UPDATE or DELETE grant;
  2. a trigger refuses UPDATE, DELETE and TRUNCATE for every role, the owner included;
  3. the chain itself, so an edit that somehow gets past both still shows up in `verify()`.
- **`verify(merchantId)`** recomputes the chain in batches of 1,000 and returns `{ ok, checked, brokenAtSeq }`, where `brokenAtSeq` is the first edited, deleted or out-of-place entry.
- **`GET /v1/m/audit/verify`** (`routes.ts`) serves it to the dashboard (#51). It isn't registered yet, because merchant auth (#48) plugs in through `authenticate`.

The tests run against a real Postgres. For each column, they edit an entry the only way still possible (as the owner, with the trigger switched off) and check that `verify()` names that entry.
