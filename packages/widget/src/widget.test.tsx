// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateSessionResponse, SessionStreamEvent } from "@keepwell/contracts";
import { act } from "preact/test-utils";
import { mount } from "./mount.js";
import { ApiUnreachable, type Transport } from "./transport.js";
import type { PopupHandle } from "./widget.js";

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
const AUTOPAY = "https://www.sandbox.paypal.com/myaccount/autopay/";
const HASH = "a".repeat(64);

/** A transport whose calls are spies, plus a way for the test to push stream events. */
function fakeTransport(create: () => Promise<CreateSessionResponse> = () => Promise.resolve(session)) {
  let push: (event: SessionStreamEvent) => void = () => undefined;
  let seq = 0;
  const calls = {
    createSession: vi.fn(create),
    message: vi.fn((_id: string, _text: string) => Promise.resolve()),
    reason: vi.fn((_id: string, _reason: string) => Promise.resolve()),
    accept: vi.fn((_id: string, _offerId: string, _hash: string) =>
      Promise.resolve({ actionIds: ["a1"], approveUrl: null }),
    ),
    decline: vi.fn(() => Promise.resolve()),
    keep: vi.fn(() => Promise.resolve()),
    cancel: vi.fn((_id: string) => Promise.resolve({ actionId: "c1" })),
    stream: vi.fn((_url: string, _after: number, onEvent: (seq: number, e: SessionStreamEvent) => void) => {
      push = (event) => onEvent(++seq, event);
      return () => undefined;
    }),
  };
  const transport: Transport = calls;
  return { transport, calls, emit: (event: SessionStreamEvent) => act(() => push(event)) };
}

/** Lets pending promises settle, then flushes Preact's renders and effects. */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const root = () => {
  const host = document.querySelector("[data-keepwell-widget]");
  if (!host?.shadowRoot) throw new Error("Widget not mounted");
  return host.shadowRoot;
};
const button = (text: string) => {
  const found = [...root().querySelectorAll("button, a")].find((el) => el.textContent?.trim() === text);
  if (!(found instanceof HTMLElement)) throw new Error(`No "${text}" control`);
  return found;
};
const text = () => root().querySelector('[role="dialog"]')?.textContent ?? "";
const click = (label: string) => act(() => button(label).click());

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

const API_ORIGIN = "http://localhost:3000";

async function open(transport: Transport, openPopup?: (url: string) => PopupHandle | null) {
  await act(() => {
    unmount = mount({
      transport,
      autopayUrl: AUTOPAY,
      supportContact: "help@pantryplan.example",
      locale: "en-US",
      openPopup,
      apiOrigin: API_ORIGIN,
    });
  });
  await flush();
}

describe("widget", () => {
  it("renders inside a Shadow DOM with Cancel now on the first screen", async () => {
    const { transport } = fakeTransport();
    await open(transport);
    expect(root().querySelector('[role="dialog"]')).not.toBeNull();
    expect(text()).toContain("Pantry Plan · Manage subscription");
    expect(text()).toContain("Standard · $12.00 / month");
    expect(button("Cancel now")).toBeTruthy();
  });

  it("streams the reply, shows the offer from the Offer object, and accepts with the shown-text hash", async () => {
    const { transport, calls, emit } = fakeTransport();
    await open(transport);
    await emit({ type: "agent.delta", text: "That makes " });
    await emit({ type: "agent.delta", text: "sense." });
    await emit({
      type: "offer.presented",
      offer: { id: "offer-pause", kind: "pause", cycles: 2, resumesOn: "2027-01-15T10:00:00.000Z" },
      cardText: "Pause for 2 billing cycles.",
      shownTextHash: HASH,
    });
    await emit({ type: "agent.done", messageId: "m1" });
    await flush();
    expect(text()).toContain("That makes sense.");
    expect(text()).toContain("Pause until January 15, 2027");
    expect(button("Cancel now")).toBeTruthy();

    await click("Yes, do that");
    await flush();
    expect(calls.accept).toHaveBeenCalledWith(session.sessionId, "offer-pause", HASH);

    await emit({
      type: "action.update",
      actionId: "a1",
      actionType: "suspend",
      state: "EXECUTING",
      approveUrl: null,
      error: null,
    });
    await flush();
    expect(text()).toContain("Applying the change in PayPal");
    await emit({ type: "session.closed", outcome: "saved_pause", summary: "Your subscription is paused." });
    await flush();
    expect(text()).toContain("Your subscription is paused.");
    // Cancel stays one click away even after a save.
    expect(button("Cancel now")).toBeTruthy();
  });

  it("cancels in one click with no AI involved", async () => {
    const { transport, calls } = fakeTransport();
    await open(transport);
    await click("Cancel now");
    await flush();
    expect(calls.cancel).toHaveBeenCalledWith(session.sessionId);
    expect(calls.message).not.toHaveBeenCalled();
    expect(text()).toContain("Cancelling…");
  });

  it("offers PayPal's own cancel when our cancel fails", async () => {
    const { transport, emit } = fakeTransport();
    await open(transport);
    await click("Cancel now");
    await flush();
    await emit({
      type: "action.update",
      actionId: "c1",
      actionType: "cancel",
      state: "FAILED",
      approveUrl: null,
      error: { code: "UNPROCESSABLE", message: "No" },
    });
    await flush();
    expect(button("Cancel in PayPal").getAttribute("href")).toBe(AUTOPAY);
  });

  it("falls back to the L2 shell, with a working PayPal cancel, when the API is down", async () => {
    const { transport } = fakeTransport(() => Promise.reject(new ApiUnreachable("fetch failed")));
    await open(transport);
    expect(text()).toContain("We can't reach our servers");
    expect(text()).toContain("help@pantryplan.example");
    expect(button("Cancel now").getAttribute("href")).toBe(AUTOPAY);
  });

  const APPROVE_URL = "https://www.sandbox.paypal.com/approve?ba_token=BA-1";

  /** Accepts a downgrade, then has PayPal's approval page opened for it (popup per `openPopup`). */
  async function awaitApproval(openPopup: (url: string) => PopupHandle | null) {
    const t = fakeTransport();
    await open(t.transport, openPopup);
    await t.emit({
      type: "offer.presented",
      offer: {
        id: "offer-downgrade",
        kind: "downgrade",
        toPlanId: "P-LITE",
        toPlanName: "Lite",
        newPrice: { value: "6.00", currency: "USD" },
      },
      cardText: "Switch to Lite for 6.00 USD.",
      shownTextHash: HASH,
    });
    await flush();
    expect(text()).toContain("PayPal will ask you to approve the change.");
    await click("Yes, do that");
    await flush();
    const update = (state: "AWAITING_BUYER" | "ABANDONED") =>
      t.emit({
        type: "action.update",
        actionId: "a1",
        actionType: "revise",
        state,
        approveUrl: APPROVE_URL,
        error: null,
      });
    await update("AWAITING_BUYER");
    await flush();
    return { ...t, update };
  }

  const messageFrom = (origin: string, data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin, data }));
    });

  it("opens PayPal's approval page for a downgrade, with a link if the popup is blocked", async () => {
    const popup = vi.fn((_url: string) => null);
    await awaitApproval(popup);
    expect(popup).toHaveBeenCalledTimes(1);
    expect(popup).toHaveBeenCalledWith(APPROVE_URL);
    expect(text()).toContain("Waiting for your approval in PayPal");
    expect(button("Open PayPal").getAttribute("href")).toBe(APPROVE_URL);
  });

  it("notices the buyer closing PayPal's window without approving, and offers to open it again", async () => {
    const handle = { closed: false };
    await awaitApproval(() => handle);
    expect(root().textContent).not.toContain("Open PayPal");

    handle.closed = true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(text()).toContain("PayPal's window was closed before you approved. Nothing has changed yet.");
    expect(button("Open PayPal again").getAttribute("href")).toBe(APPROVE_URL);
    // Cancel is still one click away.
    expect(button("Cancel now")).toBeTruthy();
  });

  it("reacts to the return page at once, but only when the message comes from our API", async () => {
    const handle = { closed: false };
    await awaitApproval(() => handle);
    const revise = (outcome: string, actionId = "a1") => ({ type: "keepwell.revise", actionId, outcome });

    await messageFrom("https://evil.example", revise("abandoned"));
    await messageFrom(API_ORIGIN, revise("abandoned", "someone-elses-action"));
    await messageFrom(API_ORIGIN, "keepwell.revise");
    expect(text()).toContain("Waiting for your approval in PayPal");

    await messageFrom(API_ORIGIN, revise("confirmed"));
    expect(text()).toContain("Applying the change in PayPal");
    expect(text()).not.toContain("Open PayPal");
    await messageFrom(API_ORIGIN, revise("abandoned"));
    expect(text()).toContain("You didn't approve the change in PayPal, so nothing was changed.");
  });

  it("says nothing changed when the approval was abandoned, and offers cancel or keep", async () => {
    const t = await awaitApproval(() => ({ closed: false }));
    await t.update("ABANDONED");
    await flush();
    expect(text()).toContain("You didn't approve the change in PayPal, so nothing was changed.");
    expect(text()).not.toContain("didn't go through");
    expect(button("Cancel now")).toBeTruthy();
    expect(button("Keep my subscription")).toBeTruthy();
  });

  it("L1: reason chips instead of the text box", async () => {
    const { transport, calls, emit } = fakeTransport(() =>
      Promise.resolve({ ...session, fallbackLevel: "L1" }),
    );
    await open(transport);
    await emit({ type: "reason.chips", reasons: ["price", "temporary"] });
    await flush();
    expect(root().querySelector("textarea")).toBeNull();
    await click("It's too expensive");
    await flush();
    expect(calls.reason).toHaveBeenCalledWith(session.sessionId, "price");
  });

  it("closes on Escape", async () => {
    const { transport } = fakeTransport();
    await open(transport);
    root()
      .querySelector('[role="dialog"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(document.querySelector("[data-keepwell-widget]")).toBeNull();
    unmount = null;
  });
});

describe("full page (the hosted portal)", () => {
  it("renders inside the given element as a region, without trapping focus or closing on Escape", async () => {
    const { transport } = fakeTransport();
    const container = document.createElement("div");
    document.body.append(container);
    const closed = vi.fn();
    await act(() => {
      unmount = mount(
        {
          transport,
          autopayUrl: AUTOPAY,
          supportContact: null,
          locale: "en-US",
          apiOrigin: API_ORIGIN,
          fullPage: true,
        },
        closed,
        container,
      );
    });
    await flush();
    const host = container.querySelector("[data-keepwell-widget]");
    expect(host?.shadowRoot).not.toBeNull();
    const region = host?.shadowRoot?.querySelector(".kw-dialog");
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.hasAttribute("aria-modal")).toBe(false);
    expect(host?.shadowRoot?.querySelector(".kw-backdrop")?.classList.contains("kw-page")).toBe(true);
    // It doesn't take focus on load, so the portal's own heading and controls stay first.
    expect(host?.shadowRoot?.activeElement).toBeNull();

    region?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closed).not.toHaveBeenCalled();
    container.remove();
  });
});

describe("full page focus", () => {
  it("leaves focus on the page's own controls while the conversation streams", async () => {
    const { transport, emit } = fakeTransport();
    const container = document.createElement("div");
    const sibling = document.createElement("button");
    sibling.textContent = "Create access token";
    document.body.append(container, sibling);
    await act(() => {
      unmount = mount(
        { transport, autopayUrl: AUTOPAY, supportContact: null, locale: "en-US", fullPage: true },
        undefined,
        container,
      );
    });
    await flush();
    sibling.focus();
    await emit({ type: "agent.delta", text: "Thanks for " });
    await emit({ type: "agent.delta", text: "telling me." });
    await flush();
    expect(document.activeElement).toBe(sibling);
    container.remove();
    sibling.remove();
  });
});
