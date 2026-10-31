import { describe, expect, it } from "vitest";
import type { NotificationRequest } from "../index.js";
import { FakeNotifier } from "./index.js";

const request: NotificationRequest = {
  merchantId: "019a3a2b-7c00-7000-8000-000000000001",
  subscriptionId: "019a3a2b-7c00-7000-8000-000000000002",
  to: "tom@example.com",
  content: {
    template: "winback.ask",
    payload: {
      firstName: "Tom",
      planName: "Standard",
      replyUrl: "https://keepwell.example/p/pantry/exit?t=abc",
      resubscribeUrl: null,
    },
  },
};

describe("FakeNotifier", () => {
  const now = new Date("2026-11-01T09:00:00.000Z");

  it("queues a valid notification and returns a UUIDv7 id", async () => {
    const notifier = new FakeNotifier(() => now);
    const id = await notifier.enqueue(request);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(notifier.queued).toHaveLength(1);
    expect(notifier.queued[0]).toMatchObject({
      id,
      status: "queued",
      dueAt: now.toISOString(),
      simulated: false,
    });
    expect(notifier.byTemplate("winback.ask")).toHaveLength(1);
    expect(notifier.byTemplate("dunning.generic")).toHaveLength(0);
  });

  it("keeps an explicit dueAt and the simulated flag", async () => {
    const notifier = new FakeNotifier(() => now);
    await notifier.enqueue({ ...request, dueAt: "2026-11-02T08:00:00Z", simulated: true });
    expect(notifier.queued[0]).toMatchObject({ dueAt: "2026-11-02T08:00:00Z", simulated: true });
  });

  it("rejects a request that breaks the contract", async () => {
    const notifier = new FakeNotifier(() => now);
    await expect(notifier.enqueue({ ...request, to: "not-an-email" })).rejects.toThrow();
    expect(notifier.queued).toHaveLength(0);
  });

  it("clears what it has queued", async () => {
    const notifier = new FakeNotifier(() => now);
    await notifier.enqueue(request);
    notifier.clear();
    expect(notifier.queued).toHaveLength(0);
  });
});
