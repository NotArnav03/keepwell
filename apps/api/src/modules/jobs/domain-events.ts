import { eq } from "drizzle-orm";
import {
  parseDomainEventPayload,
  type DomainEvent,
  type DomainEventPayload,
  type DomainEventType,
  type DomainEvents,
} from "@keepwell/contracts";
import { domainEvents, type Db, type Tx } from "@keepwell/db";
import type { Jobs } from "./jobs.js";

// Domain events on Postgres (CONTRACTS.md §2). emit() writes the event row and one domain.dispatch
// job per registered handler in the caller's transaction, so an event exists, and is delivered,
// exactly when the change it describes commits. Each handler runs as its own job: one failing
// handler is retried without re-running the others, and the job's idempotency key
// (`eventId:handler`) stops a handler from receiving the same event twice.

type Handler = (event: DomainEvent) => Promise<void>;

export interface DomainEventsLogger {
  warn(obj: object, msg: string): void;
}

export class DbDomainEvents implements DomainEvents<Tx> {
  private readonly handlers = new Map<DomainEventType, Map<string, Handler>>();

  constructor(
    private readonly db: Db,
    private readonly jobs: Jobs,
    private readonly log: DomainEventsLogger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async emit<T extends DomainEventType>(
    event: { type: T; merchantId: string; payload: DomainEventPayload<T>; simulated?: boolean },
    tx?: Tx,
  ): Promise<void> {
    if (!tx) return this.db.forMerchant(event.merchantId, (t) => this.emit(event, t));
    const payload = parseDomainEventPayload(event.type, event.payload);
    const [row] = await tx
      .insert(domainEvents)
      .values({
        merchantId: event.merchantId,
        type: event.type,
        payload,
        simulated: event.simulated ?? false,
        occurredAt: this.clock(),
      })
      .returning({ id: domainEvents.id });
    if (!row) throw new Error("domain_events insert returned nothing");
    for (const handler of this.handlers.get(event.type)?.keys() ?? []) {
      await this.jobs.send("domain.dispatch", { domainEventId: row.id, handler }, { tx });
    }
  }

  /** Register at startup, before anything emits: an event is only dispatched to handlers known then. */
  on<T extends DomainEventType>(
    type: T,
    handlerName: string,
    fn: (event: DomainEvent<T>) => Promise<void>,
  ): void {
    const forType = this.handlers.get(type) ?? new Map<string, Handler>();
    if (forType.has(handlerName))
      throw new Error(`Handler "${handlerName}" is already registered for ${type}`);
    // Safe: dispatch() only passes events whose type matches the key this handler is stored under.
    forType.set(handlerName, fn as Handler);
    this.handlers.set(type, forType);
  }

  /** Starts the domain.dispatch worker. */
  async startWorker(): Promise<void> {
    await this.jobs.work("domain.dispatch", ({ domainEventId, handler }) =>
      this.dispatch(domainEventId, handler),
    );
  }

  async dispatch(domainEventId: string, handlerName: string): Promise<void> {
    // The job carries only the event id; the row says which merchant it belongs to.
    const [row] = await this.db.acrossMerchants((tx) =>
      tx.select().from(domainEvents).where(eq(domainEvents.id, domainEventId)),
    );
    if (!row) throw new Error(`Domain event ${domainEventId} not found`);
    const type = row.type as DomainEventType;
    const handler = this.handlers.get(type)?.get(handlerName);
    if (!handler) {
      // Renamed or removed since the event was emitted: nothing to deliver to.
      this.log.warn({ domainEventId, type, handler: handlerName }, "no handler for domain event");
      return;
    }
    await handler({
      id: row.id,
      type,
      merchantId: row.merchantId,
      occurredAt: row.occurredAt.toISOString(),
      simulated: row.simulated,
      payload: parseDomainEventPayload(type, row.payload),
    });
  }
}
