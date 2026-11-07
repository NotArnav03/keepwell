import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { Id } from "@keepwell/contracts";
import { MERCHANT_FEED_CHANNEL } from "../jobs/domain-events.js";

/**
 * One LISTEN connection for the whole process, fanned out in memory to every open live feed.
 *
 * Why not one connection per dashboard tab: each held a pool connection for as long as the stream
 * stayed open, and the pool (max 10) is shared with pg-boss and every request, so a few tabs plus
 * reconnects starved the API. Now a stream only registers a callback.
 *
 * A listener gets the merchant a notification was for, or `null` when the connection dropped and
 * came back: notifications sent in between are lost, so every stream should re-read from its cursor.
 */
export type FeedListener = (merchantId: string | null) => void;

export interface FeedHub {
  subscribe(listener: FeedListener): () => void;
}

interface Logger {
  warn(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
}

const Notification = z.object({ merchantId: Id });
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export class PgFeedHub implements FeedHub {
  private readonly listeners = new Set<FeedListener>();
  private client: PoolClient | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = RETRY_MIN_MS;
  private closed = false;

  constructor(
    private readonly pool: Pick<Pool, "connect">,
    private readonly log: Logger,
  ) {}

  /** Opens the connection. Never throws: a failure is retried in the background with backoff. */
  async start(): Promise<void> {
    await this.connect(false);
  }

  subscribe(listener: FeedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.listeners.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners("notification");
      client.removeAllListeners("error");
      client.release();
    }
  }

  private async connect(resync: boolean): Promise<void> {
    if (this.closed) return;
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      const connected = client;
      connected.on("notification", (n) => this.onNotification(n));
      connected.on("error", (error) => this.lost(connected, error));
      await connected.query(`LISTEN ${MERCHANT_FEED_CHANNEL}`);
      if (this.closed) {
        connected.release();
        return;
      }
      this.client = connected;
      this.retryMs = RETRY_MIN_MS;
      if (resync) this.fanOut(null);
    } catch (error) {
      if (client) {
        client.removeAllListeners("notification");
        client.removeAllListeners("error");
        client.release(true);
      }
      this.log.error({ err: error }, "merchant feed LISTEN failed; retrying");
      this.scheduleRetry();
    }
  }

  private lost(client: PoolClient, error: unknown): void {
    if (this.client !== client) return;
    this.log.warn({ err: error }, "merchant feed connection lost; reconnecting");
    this.client = null;
    client.removeAllListeners("notification");
    client.removeAllListeners("error");
    // `true` destroys the connection instead of returning a broken one to the pool.
    client.release(true);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect(true);
    }, wait);
    this.retryTimer.unref();
  }

  private onNotification(notification: { channel?: string | null; payload?: string | null }): void {
    if (notification.channel !== MERCHANT_FEED_CHANNEL || !notification.payload) return;
    let payload: unknown;
    try {
      payload = JSON.parse(notification.payload) as unknown;
    } catch (error) {
      this.log.warn({ err: error }, "malformed merchant feed notification");
      return;
    }
    const message = Notification.safeParse(payload);
    if (message.success) this.fanOut(message.data.merchantId);
  }

  private fanOut(merchantId: string | null): void {
    for (const listener of this.listeners) {
      try {
        listener(merchantId);
      } catch (error) {
        this.log.warn({ err: error }, "merchant feed listener threw");
      }
    }
  }
}
