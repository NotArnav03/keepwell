import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MERCHANT_FEED_CHANNEL } from "../jobs/domain-events.js";
import { PgFeedHub } from "./feed-hub.js";

const M1 = "01990000-0000-7000-8000-000000000001";
const M2 = "01990000-0000-7000-8000-000000000002";

class FakeClient extends EventEmitter {
  queries: string[] = [];
  released: (boolean | undefined)[] = [];
  query(sql: string): Promise<void> {
    this.queries.push(sql);
    return Promise.resolve();
  }
  release(destroy?: boolean): void {
    this.released.push(destroy);
  }
  notify(payload: string): void {
    this.emit("notification", { channel: MERCHANT_FEED_CHANNEL, payload });
  }
}

const log = { warn: vi.fn(), error: vi.fn() };

function setup(failFirst = 0) {
  const clients: FakeClient[] = [];
  let failures = failFirst;
  const pool = {
    connect: vi.fn(() => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("pool exhausted"));
      }
      const client = new FakeClient();
      clients.push(client);
      return Promise.resolve(client as unknown as PoolClient);
    }),
  };
  return { clients, pool, hub: new PgFeedHub(pool, log) };
}

describe("PgFeedHub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    log.warn.mockClear();
    log.error.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("holds one connection however many streams subscribe, and fans notifications out", async () => {
    const { hub, pool, clients } = setup();
    await hub.start();
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribe(a);
    hub.subscribe(b);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(clients[0]?.queries).toEqual([`LISTEN ${MERCHANT_FEED_CHANNEL}`]);

    clients[0]?.notify(JSON.stringify({ merchantId: M1, eventId: M2 }));
    expect(a).toHaveBeenCalledWith(M1);
    expect(b).toHaveBeenCalledWith(M1);
  });

  it("stops calling a listener after it unsubscribes, and ignores malformed notifications", async () => {
    const { hub, clients } = setup();
    await hub.start();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(listener);
    clients[0]?.notify("not json");
    clients[0]?.notify(JSON.stringify({ merchantId: "nope" }));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    clients[0]?.notify(JSON.stringify({ merchantId: M1 }));
    expect(listener).not.toHaveBeenCalled();
  });

  it("reconnects after the connection drops and tells listeners to re-read", async () => {
    const { hub, clients, pool } = setup();
    await hub.start();
    const listener = vi.fn();
    hub.subscribe(listener);

    clients[0]?.emit("error", new Error("connection terminated"));
    expect(clients[0]?.released).toEqual([true]); // destroyed, not returned to the pool
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(clients[1]?.queries).toEqual([`LISTEN ${MERCHANT_FEED_CHANNEL}`]);
    expect(listener).toHaveBeenCalledWith(null);
    clients[1]?.notify(JSON.stringify({ merchantId: M2 }));
    expect(listener).toHaveBeenLastCalledWith(M2);
  });

  it("retries with backoff when the first connection fails, without throwing", async () => {
    const { hub, pool } = setup(2);
    await expect(hub.start()).resolves.toBeUndefined();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pool.connect).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("releases its connection on close and does not reconnect afterwards", async () => {
    const { hub, clients, pool } = setup();
    await hub.start();
    hub.close();
    expect(clients[0]?.released).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });
});
