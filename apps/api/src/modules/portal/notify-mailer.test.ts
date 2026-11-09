import { describe, expect, it } from "vitest";
import type { Notifier, NotificationRequest } from "@keepwell/contracts";
import type { Db, Tx } from "@keepwell/db";
import { NotifyMagicLinkMailer } from "./notify-mailer.js";

const DEMO = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const OTHER = "0199a1b2-c3d4-7e5f-8a6b-000000000001";

function setup() {
  const sent: { request: NotificationRequest; tx: unknown }[] = [];
  const opened: string[] = [];
  const tx = { marker: "tx" } as unknown as Tx;
  const db = {
    forMerchant: (merchantId: string, fn: (tx: Tx) => Promise<unknown>) => {
      opened.push(merchantId);
      return fn(tx);
    },
  } as unknown as Db;
  const notifier: Notifier<Tx> = {
    enqueue: (request: NotificationRequest, t?: Tx) => {
      sent.push({ request, tx: t });
      return Promise.resolve("n1");
    },
    supersede: () => Promise.resolve(false),
  };
  const mailer = new NotifyMagicLinkMailer({ db, notifier, simulated: (id) => id === DEMO });
  return { mailer, sent, opened, tx };
}

const link = (merchantId: string) => ({
  merchantId,
  to: "maya@example.com",
  url: "https://portal.example/v1/portal/verify?token=abc",
  expiresAt: new Date("2026-11-09T10:15:00.000Z"),
});

describe("NotifyMagicLinkMailer", () => {
  it("queues one portal.sign_in message in the merchant's own transaction", async () => {
    const { mailer, sent, opened, tx } = setup();
    await mailer.send(link(OTHER));
    expect(opened).toEqual([OTHER]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.tx).toBe(tx);
    expect(sent[0]?.request).toMatchObject({
      merchantId: OTHER,
      subscriptionId: null,
      to: "maya@example.com",
      simulated: false,
      content: {
        template: "portal.sign_in",
        payload: { signInUrl: "https://portal.example/v1/portal/verify?token=abc", expiresInMinutes: 15 },
      },
    });
  });

  it("flags the demo merchant's mail as simulated", async () => {
    const { mailer, sent } = setup();
    await mailer.send(link(DEMO));
    expect(sent[0]?.request.simulated).toBe(true);
  });
});
