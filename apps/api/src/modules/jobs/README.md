# modules/jobs (owner: Arnav, M1)

Background jobs on Postgres with pg-boss, and the Postgres-backed `DomainEvents` (ARCHITECTURE.md §6.15, CONTRACTS.md §2–3).

## Jobs

```ts
const jobs = await Jobs.start({ connectionString: ownerUrl, log });
await jobs.work("action.execute", ({ actionId }) => engine.execute(merchantId, actionId));
await jobs.send("action.execute", { actionId }, { tx });   // joins the caller's transaction
await jobs.schedule("due.sweep", "* * * * *", {});
```

- **Typed by the registries** in `@keepwell/contracts` (`platformJobs`, `brainJobs`, `growthJobs`). Payloads are validated going in and coming out.
- **One job per idempotency key:** each job's `idempotencyKey` is pg-boss's `singletonKey`. Queues use the `exclusive` policy, so a second send with the same key, while the first is queued, retrying or running, is a no-op and returns `null`. pg-boss's default policy ignores the key.
- **Transactional send:** with `{ tx }` the job is created in your transaction, through pg-boss's Drizzle adapter, so it exists exactly when your writes commit.
- **Retries:** a throwing handler is retried 5 times with exponential backoff, starting at 5 s.
- **Connection:** pg-boss gets the **owner's** connection (no `APP_ROLE_OPTIONS`), because it creates and migrates its `pgboss` schema. `Jobs.start` grants `keepwell_app` what a transactional send needs.

## Domain events

```ts
events.on("action.state_changed", "sessions.stream", async (event) => { … });  // at startup
await events.emit({ type: "action.state_changed", merchantId, payload }, tx);
await events.startWorker();
```

- **Event and delivery commit together:** `emit` writes the `domain_events` row and one `domain.dispatch` job per registered handler, all in the caller's transaction. A rolled-back change emits nothing, and a committed one is always delivered.
- **Each handler is its own job:** a failing handler is retried on its own, and the key `eventId:handler` means no handler gets an event twice.
- **Payloads are validated** against the producer's schema when emitted and again when delivered.
- **Register handlers at startup:** an event is dispatched to the handlers that existed when it was emitted.

The tests run against a real Postgres with pg-boss. They check that a rolled-back emit queues no dispatch jobs at all: the test fails if `emit` enqueues outside the transaction.
