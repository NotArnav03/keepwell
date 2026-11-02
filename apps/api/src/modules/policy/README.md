# modules/policy (owner: Ishan, M2)

The merchant policy API (#27, CONTRACTS.md §4). The routes are in `routes.ts`, the logic is in `PolicyService`.

| Route | What it does |
|---|---|
| `GET /v1/m/policies` | Versions, newest first, and `currentVersion` |
| `GET /v1/m/policies/:version` | One immutable version with its document |
| `POST /v1/m/policies` | Publishes `baseVersion + 1` |
| `POST /v1/m/policies/dry-run` | What a draft would offer up to 20 sample subscribers right now. Stores nothing |

Publishing a version:
1. `validatePolicy` (packages/policy) checks the draft against the plan catalogue. A problem is a 422 `invalid_policy` with `details: [{ path, message }]`.
2. `PolicyStore.publish` appends the version. A stale `baseVersion` is a 409 `version_conflict`.
3. `policy.published` is emitted.
4. A `policy.published` audit entry (actor `merchant`) records the whole document.

Dry-run returns the same `problems` without failing. For each sample it also returns the menu, `offerIdsByReason` and the `PolicyContext` it used, so the editor can re-run `computeMenu` in the browser on every edit.

## Not wired yet

The routes plugin takes these dependencies:
- **`authenticate`:** merchant auth (#48, M4).
- **`PolicyStore` and `MerchantCatalog`:** Postgres (M1).

Until they exist, nothing registers it in `server.ts`. Tests use `FakePolicyStore` and a Pantry Plan catalogue.

Once the store has a transaction helper (M1), publishing, the event and the audit entry should share one transaction.
