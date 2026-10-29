import { Id } from "../shared.js";
import {
  parseDomainEventPayload,
  type DomainEvent,
  type DomainEventPayload,
  type DomainEventType,
} from "../platform/events.js";
import type { DomainEvents } from "../platform/interfaces.js";
import { uuidv7 } from "./uuidv7.js";

type Handler = { name: string; fn: (event: DomainEvent) => Promise<void> };

/**
 * In-memory DomainEvents. Payloads are validated against the producer's schema, and handlers run
 * immediately, in registration order. A handler error rejects emit(): in production the
 * domain.dispatch job would retry it, but in a test you want to see it.
 */
export class FakeDomainEvents implements DomainEvents {
  readonly emitted: DomainEvent[] = [];
  private readonly handlers = new Map<DomainEventType, Handler[]>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async emit<T extends DomainEventType>(event: {
    type: T;
    merchantId: string;
    payload: DomainEventPayload<T>;
    simulated?: boolean;
  }): Promise<void> {
    const now = this.clock();
    const stored: DomainEvent<T> = {
      id: uuidv7(now.getTime()),
      type: event.type,
      merchantId: Id.parse(event.merchantId),
      occurredAt: now.toISOString(),
      simulated: event.simulated ?? false,
      payload: parseDomainEventPayload(event.type, event.payload),
    };
    this.emitted.push(stored);
    for (const handler of this.handlers.get(event.type) ?? []) {
      await handler.fn(stored);
    }
  }

  on<T extends DomainEventType>(
    type: T,
    handlerName: string,
    fn: (event: DomainEvent<T>) => Promise<void>,
  ): void {
    const list = this.handlers.get(type) ?? [];
    if (list.some((h) => h.name === handlerName)) {
      throw new Error(`Handler "${handlerName}" is already registered for ${type}`);
    }
    // Safe: emit() only passes events whose type matches the key this handler is stored under.
    list.push({ name: handlerName, fn: fn as (event: DomainEvent) => Promise<void> });
    this.handlers.set(type, list);
  }

  ofType<T extends DomainEventType>(type: T): DomainEvent<T>[] {
    return this.emitted.filter((e): e is DomainEvent<T> => e.type === type);
  }

  clear(): void {
    this.emitted.length = 0;
  }
}
