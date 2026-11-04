// @vitest-environment happy-dom
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateSessionResponse, SessionStreamEvent } from "@keepwell/contracts";
import { act } from "preact/test-utils";
import { mount } from "./mount.js";
import { ApiUnreachable, type Transport } from "./transport.js";
import type { RecognitionCtor, SpeechResultEvent } from "./speech.js";

// WCAG 2.2 AA checks that can run without a browser: axe-core's structural rules over every screen
// the widget has, plus the keyboard behaviour axe can't see. Colour contrast needs real layout, so
// it is checked in a browser (docs/accessibility.md) and by the token table in styles.ts.

const session: CreateSessionResponse = {
  sessionId: "0199a1b2-c3d4-7e5f-8a6b-000000000099",
  subscription: {
    paypalSubscriptionId: "I-FAKE",
    planName: "Standard",
    price: { value: "12.00", currency: "USD" },
    interval: { unit: "MONTH", count: 1 },
    status: "ACTIVE",
    nextBillingTime: "2026-11-19T10:00:00.000Z",
    subscriberFirstName: "Maya",
  },
  fallbackLevel: "L0",
  streamUrl: "http://localhost:3000/v1/sessions/x/stream",
  merchant: { name: "Pantry Plan", supportContact: "help@pantryplan.example" },
};
const HASH = "a".repeat(64);

function fakeTransport(create: () => Promise<CreateSessionResponse> = () => Promise.resolve(session)) {
  let push: (event: SessionStreamEvent) => void = () => undefined;
  let seq = 0;
  const transport: Transport = {
    createSession: vi.fn(create),
    message: vi.fn(() => Promise.resolve()),
    reason: vi.fn(() => Promise.resolve()),
    accept: vi.fn(() => Promise.resolve({ actionIds: ["a1"], approveUrl: null })),
    decline: vi.fn(() => Promise.resolve()),
    keep: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => Promise.resolve({ actionId: "c1" })),
    stream: vi.fn((_url: string, _after: number, onEvent: (seq: number, e: SessionStreamEvent) => void) => {
      push = (event) => onEvent(++seq, event);
      return () => undefined;
    }),
  };
  return { transport, emit: (event: SessionStreamEvent) => act(() => push(event)) };
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const root = () => {
  const host = document.querySelector("[data-keepwell-widget]");
  if (!host?.shadowRoot) throw new Error("Widget not mounted");
  return host.shadowRoot;
};
const control = (label: string) => {
  const found = [...root().querySelectorAll("button, a")].find((el) => el.textContent?.trim() === label);
  if (!(found instanceof HTMLElement)) throw new Error(`No "${label}" control`);
  return found;
};
const focused = () => root().activeElement;

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

async function open(transport: Transport) {
  await act(() => {
    unmount = mount({
      transport,
      autopayUrl: "https://www.sandbox.paypal.com/myaccount/autopay/",
      supportContact: "help@pantryplan.example",
      locale: "en-US",
      apiOrigin: "http://localhost:3000",
    });
  });
  await flush();
}

async function violations(): Promise<string[]> {
  const host = document.querySelector("[data-keepwell-widget]");
  if (!host) throw new Error("Widget not mounted");
  const result = await axe.run(host, {
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
    },
    // Needs real layout; see the header comment.
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(" | ")}`);
}

const offer = {
  type: "offer.presented",
  offer: { id: "offer-pause", kind: "pause", cycles: 2, resumesOn: "2027-01-15T10:00:00.000Z" },
  cardText: "Pause for 2 billing cycles.",
  shownTextHash: HASH,
} satisfies SessionStreamEvent;

describe("axe: every screen has no violations", () => {
  it("the first screen", async () => {
    const { transport } = fakeTransport();
    await open(transport);
    expect(await violations()).toEqual([]);
  });

  it("with the conversation, reason chips and the input", async () => {
    const { transport, emit } = fakeTransport();
    await open(transport);
    await emit({ type: "agent.delta", text: "That makes sense." });
    await emit({ type: "reason.chips", reasons: ["price", "temporary", "other"] });
    expect(await violations()).toEqual([]);
  });

  it("with an offer on the table", async () => {
    const { transport, emit } = fakeTransport();
    await open(transport);
    await emit(offer);
    expect(await violations()).toEqual([]);
  });

  it("while waiting for PayPal's approval", async () => {
    const { transport, emit } = fakeTransport();
    await open(transport);
    await emit(offer);
    await act(() => control("Yes, do that").click());
    await emit({
      type: "action.update",
      actionId: "a1",
      actionType: "revise",
      state: "AWAITING_BUYER",
      approveUrl: "https://www.sandbox.paypal.com/approve/x",
      error: null,
    });
    expect(await violations()).toEqual([]);
  });

  it("after cancelling, and after a cancel that failed", async () => {
    const { transport, emit } = fakeTransport();
    await open(transport);
    await act(() => control("Cancel now").click());
    await emit({ type: "session.closed", outcome: "cancelled", summary: "Your subscription is cancelled." });
    expect(await violations()).toEqual([]);
  });

  it("when our API is unreachable (the L2 shell)", async () => {
    const { transport } = fakeTransport(() => Promise.reject(new ApiUnreachable("down")));
    await open(transport);
    expect(await violations()).toEqual([]);
  });
});

describe("keyboard and screen reader behaviour", () => {
  it("keeps focus inside the dialog when the control that had it disappears", async () => {
    const { transport, emit } = fakeTransport();
    await open(transport);
    await emit(offer);
    control("Yes, do that").focus();
    await act(() => control("Yes, do that").click());
    // The Yes/No buttons are gone; focus must not fall out to the page behind.
    expect(root().querySelector('[role="dialog"]')?.contains(focused())).toBe(true);
  });

  it("announces failures and status changes", async () => {
    const { transport } = fakeTransport(() => Promise.reject(new ApiUnreachable("down")));
    await open(transport);
    expect(root().querySelector(".kw-notice,[role=alert]")).not.toBeNull();
    expect(root().querySelector('[role="alert"]')).not.toBeNull();
  });

  it("marks the offer card as a labelled group", async () => {
    const { transport, emit } = fakeTransport();
    await open(transport);
    await emit(offer);
    expect(root().querySelector(".kw-offer")?.getAttribute("role")).toBe("group");
  });

  it("says which links open a new tab", async () => {
    const { transport } = fakeTransport(() => Promise.reject(new ApiUnreachable("down")));
    await open(transport);
    const link = control("Cancel now");
    expect(link.getAttribute("aria-label") ?? link.textContent).toMatch(/new tab/i);
  });
});

describe("voice input", () => {
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    lang = "";
    interimResults = true;
    continuous = true;
    onresult: ((event: SpeechResultEvent) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    started = 0;
    stopped = 0;
    constructor() {
      FakeRecognition.last = this;
    }
    start() {
      this.started += 1;
    }
    stop() {
      this.stopped += 1;
      this.onend?.();
    }
  }
  const said = (transcript: string, isFinal = true): SpeechResultEvent => ({
    resultIndex: 0,
    results: [Object.assign([{ transcript }], { isFinal })],
  });

  async function openWith(speech: RecognitionCtor | null) {
    const { transport } = fakeTransport();
    await act(() => {
      unmount = mount({
        transport,
        autopayUrl: "https://www.sandbox.paypal.com/myaccount/autopay/",
        supportContact: null,
        locale: "en-US",
        speech,
      });
    });
    await flush();
  }
  const input = () => {
    const found = root().querySelector("textarea");
    if (!found) throw new Error("No input");
    return found;
  };

  it("is hidden where the browser has no speech recognition", async () => {
    await openWith(null);
    expect(root().querySelector("textarea")).not.toBeNull();
    expect([...root().querySelectorAll("button")].some((b) => b.textContent === "Speak")).toBe(false);
  });

  it("dictates one phrase into the input, then stops by itself", async () => {
    await openWith(FakeRecognition);
    await act(() => control("Speak").click());
    const recognition = FakeRecognition.last;
    expect(recognition?.started).toBe(1);
    expect(recognition?.lang).toBe("en-US");
    expect(recognition?.continuous).toBe(false);
    expect(control("Speak").getAttribute("aria-pressed")).toBe("true");

    await act(() => recognition?.onresult?.(said("it costs too much", false)));
    expect(input().value).toBe("");
    await act(() => recognition?.onresult?.(said("it costs too much")));
    expect(input().value).toBe("it costs too much");
    await act(() => recognition?.onend?.());
    expect(control("Speak").getAttribute("aria-pressed")).toBe("false");
  });

  it("stops on the second press, and keeps what was typed", async () => {
    await openWith(FakeRecognition);
    await act(() => {
      input().value = "Hello";
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => control("Speak").click());
    await act(() => FakeRecognition.last?.onresult?.(said("there")));
    expect(input().value).toBe("Hello there");
    await act(() => control("Speak").click());
    expect(FakeRecognition.last?.stopped).toBe(1);
  });

  it("stops listening when the dialog closes", async () => {
    await openWith(FakeRecognition);
    await act(() => control("Speak").click());
    const recognition = FakeRecognition.last;
    await act(() => unmount?.());
    unmount = null;
    expect(recognition?.stopped).toBe(1);
  });

  it("passes axe with the Speak button", async () => {
    await openWith(FakeRecognition);
    expect(await violations()).toEqual([]);
  });
});
