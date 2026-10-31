# modules/insights (owner: Om, M5)

Why subscribers leave (ARCHITECTURE.md §6.12). Insights are never on the critical path: if the model is down, the extraction job retries and the session is untouched.

| Piece | What it does |
|---|---|
| `extractor.ts` | `insights.extract`: loads the transcript (or win-back reply), scrubs it, asks Haiku through the agent module's `LlmClient`, stores an `InsightRecord`. Bad output is regenerated once, then a fallback record is stored. An unavailable model throws `InsightsRetryLater`. |
| `scrub.ts` | Deterministic redaction of emails, numbers and names; 20-word quote cap. |
| `jobs.ts` | `session.closed` subscription, `enqueueExtract` (for win-back replies), worker bodies, retry options, hourly cron for `insights.refresh_views`. |
| `queries.ts` | All merchant-facing numbers, as SQL: `overviewKpis` (for `GET /m/overview`) and `insightsOverview` (for `GET /m/insights`). |
| `routes.ts` | `GET /insights?from&to&quotes` (register under `/v1/m`). |

Aggregates read `insight_daily`, a tenant-filtered view over a materialized view (migration 0003) that `insights.refresh_views` rebuilds. Top quotes and the overview KPIs read live tables.

## Not wired yet

- **Job queue and worker registration:** M1's pg-boss wrapper. `InsightsJobQueue` is the slice this module needs.
- **Win-back replies:** `ReplyReader` has only a fake until the win-back module owns a replies table.
- **Merchant auth, `GET /m/overview`:** M4's merchant module calls `overviewKpis` and registers `insightsRoutes`.
