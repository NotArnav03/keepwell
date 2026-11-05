// @vitest-environment happy-dom
import axe from "axe-core";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalMe } from "@keepwell/contracts";
import { PortalApiError, PortalUnreachable, type PortalApi } from "./api.js";
import { App, type AppProps } from "./app.js";

const SUB = "0199a1b2-0000-7000-8000-000000000001";
const ME: PortalMe = {
  subscriptions: [
    {
      id: SUB,
      planName: "Standard",
      price: { value: "12.00", currency: "USD" },
      interval: { unit: "MONTH", count: 1 },
      status: "ACTIVE",
      nextBillingTime: "2026-11-19T10:00:00.000Z",
    },
  ],
  delegations: [
    {
      id: "0199a1b2-0000-7000-8000-0000000000d1",
      subscriptionId: SUB,
      scopes: ["read", "cancel"],
      createdAt: "2026-11-02T10:00:00.000Z",
      expiresAt: "2026-11-09T10:00:00.000Z",
    },
  ],
};

function fakeApi(me: PortalMe | null | Error, overrides: Partial<PortalApi> = {}) {
  let current = me;
  const mocks = {
    me: vi.fn(() => (current instanceof Error ? Promise.reject(current) : Promise.resolve(current))),
    requestLink: vi.fn(() => Promise.resolve()),
    token: vi.fn(() => Promise.resolve("jwt")),
    createDelegation: vi.fn((_sub: string, scopes: string[]) =>
      Promise.resolve({
        id: "0199a1b2-0000-7000-8000-0000000000d2",
        token: "kwd_secret-token",
        scopes: scopes as never,
        expiresAt: "2026-11-09T10:00:00.000Z",
      }),
    ),
    revokeDelegation: vi.fn(() => Promise.resolve()),
    logout: vi.fn(() => Promise.resolve()),
  };
  const api: PortalApi = { ...mocks, ...overrides };
  return { api, mocks, set: (next: PortalMe | null) => (current = next) };
}

let container: HTMLElement | null = null;
afterEach(() => {
  if (container) render(null, container);
  container?.remove();
  container = null;
});

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function show(api: PortalApi, extra: Partial<AppProps> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  const openWidget = vi.fn<AppProps["openWidget"]>(() => () => undefined);
  await act(() => {
    render(
      <App
        api={api}
        merchantName="Pantry Plan"
        locale="en-US"
        initialError={null}
        autopayUrl="https://www.sandbox.paypal.com/myaccount/autopay/"
        openWidget={openWidget}
        {...extra}
      />,
      container as HTMLElement,
    );
  });
  await flush();
  return { openWidget };
}

const by = (selector: string) => container?.querySelector(selector) ?? null;
const control = (label: string) => {
  const found = [...(container?.querySelectorAll("button, a") ?? [])].find((el) =>
    el.textContent?.trim().startsWith(label),
  );
  if (!(found instanceof HTMLElement)) throw new Error(`No "${label}" control`);
  return found;
};
const type = (selector: string, value: string) =>
  act(() => {
    const input = by(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = (selector: string) =>
  act(() => {
    by(selector)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
const pageText = () => container?.textContent ?? "";

async function violations(): Promise<string[]> {
  const result = await axe.run(container as HTMLElement, {
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
    },
    // Needs real layout; the palette is in style.css and was checked in a browser.
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(" | ")}`);
}

describe("signed out", () => {
  it("asks for the email PayPal holds, and says the same thing whatever happens next", async () => {
    const { api, mocks } = fakeApi(null);
    await show(api);
    expect(pageText()).toContain("Pantry Plan · Manage your subscription");
    await type("#email", " maya@example.com ");
    await submit("form");
    await flush();
    expect(mocks.requestLink).toHaveBeenCalledWith("maya@example.com");
    expect(by("[role=status]")?.textContent).toContain("If that address has a subscription here");
  });

  it("shows nothing about the address when the request is refused for being too frequent", async () => {
    const { api } = fakeApi(null, {
      requestLink: vi.fn(() => Promise.reject(new PortalApiError(429, "rate_limited", "Slow", 60))),
    });
    await show(api);
    await type("#email", "maya@example.com");
    await submit("form");
    await flush();
    expect(by("[role=alert]")?.textContent).toContain("Too many requests");
    expect(by("[role=status]")).toBeNull();
  });

  it("explains an expired link", async () => {
    const { api } = fakeApi(null);
    await show(api, { initialError: "link_expired" });
    expect(by("[role=alert]")?.textContent).toContain("expired or was already used");
  });

  it("still points at PayPal's own cancel when the API can't be reached", async () => {
    const { api } = fakeApi(new PortalUnreachable("down"));
    await show(api);
    const link = control("Cancel in PayPal") as HTMLAnchorElement;
    expect(link.href).toBe("https://www.sandbox.paypal.com/myaccount/autopay/");
    expect(link.target).toBe("_blank");
  });

  it("has no axe violations", async () => {
    const { api } = fakeApi(null);
    await show(api, { initialError: "link_expired" });
    expect(await violations()).toEqual([]);
  });
});

describe("signed in", () => {
  it("lists the subscription and its active tokens", async () => {
    const { api } = fakeApi(ME);
    await show(api);
    expect(pageText()).toContain("Standard");
    expect(pageText()).toContain("$12.00 / month");
    expect(pageText()).toContain("Next payment Nov 19, 2026");
    expect(pageText()).toContain("see my plan and billing dates, cancel my subscription");
  });

  it("opens the widget in place for one subscription, and refreshes when it closes", async () => {
    const { api, mocks } = fakeApi(ME);
    let closed: () => void = () => undefined;
    const openWidget = vi.fn<AppProps["openWidget"]>((_id, _box, onClosed) => {
      closed = onClosed;
      return () => undefined;
    });
    container = document.createElement("div");
    document.body.append(container);
    await act(() => {
      render(
        <App
          api={api}
          merchantName="Pantry Plan"
          locale="en-US"
          initialError={null}
          autopayUrl="https://p.example/"
          openWidget={openWidget}
        />,
        container as HTMLElement,
      );
    });
    await flush();
    await act(() => control("Manage or cancel").click());
    expect(openWidget).toHaveBeenCalledTimes(1);
    expect(openWidget.mock.calls[0]?.[0]).toBe(SUB);
    expect(openWidget.mock.calls[0]?.[1]).toBe(by(".widget-box"));
    expect((control("Managing this subscription below") as HTMLButtonElement).disabled).toBe(true);

    const loads = mocks.me.mock.calls.length;
    await act(() => closed());
    await flush();
    expect(by(".widget-box")).toBeNull();
    expect(mocks.me.mock.calls.length).toBe(loads + 1);
  });

  it("creates a token with the chosen scopes, shows it once, then forgets it", async () => {
    const { api, mocks } = fakeApi(ME);
    await show(api);
    // Only "read" is ticked to start with; tick "cancel" too.
    await act(() => (by("input[type=checkbox]:not(:checked)") as HTMLInputElement).click());
    await submit(".assistant form");
    await flush();
    expect(mocks.createDelegation).toHaveBeenCalledWith(SUB, ["read", "cancel"]);
  });

  it("shows the new token only until it is dismissed", async () => {
    const { api } = fakeApi(ME);
    await show(api);
    await submit(".assistant form");
    await flush();
    expect((by("input[readonly]") as HTMLInputElement).value).toBe("kwd_secret-token");
    expect(pageText()).toContain("only time it's shown");
    await act(() => control("I've saved it").click());
    expect(by("input[readonly]")).toBeNull();
    expect(container?.innerHTML).not.toContain("kwd_secret-token");
  });

  it("revokes a token", async () => {
    const { api, mocks, set } = fakeApi(ME);
    await show(api);
    set({ ...ME, delegations: [] });
    await act(() => control("Revoke").click());
    await flush();
    expect(mocks.revokeDelegation).toHaveBeenCalledWith("0199a1b2-0000-7000-8000-0000000000d1");
    expect(by("[role=status]")?.textContent).toContain("revoked");
    expect(pageText()).toContain("No active access tokens.");
  });

  it("signs out", async () => {
    const { api, mocks } = fakeApi(ME);
    await show(api);
    await act(() => control("Sign out").click());
    await flush();
    expect(mocks.logout).toHaveBeenCalled();
    expect(pageText()).toContain("Email me a sign-in link");
  });

  it("has no axe violations, with a token on screen too", async () => {
    const { api } = fakeApi(ME);
    await show(api);
    expect(await violations()).toEqual([]);
    await submit(".assistant form");
    await flush();
    expect(await violations()).toEqual([]);
  });
});
