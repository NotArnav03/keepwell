// @vitest-environment happy-dom
import axe from "axe-core";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JudgeUnreachable, type Health, type JudgeApi, type Lease } from "./api.js";
import { App, type JudgeConfig } from "./app.js";

const lease: Lease = {
  leaseId: "0199a1b2-0000-7000-8000-0000000000a1",
  leaseToken: "lease-token",
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  subscriptionId: "0199a1b2-0000-7000-8000-000000000001",
};
const config: JudgeConfig = {
  storeUrl: "https://store.example/",
  dashboardUrl: "https://dashboard.example/",
  evalsUrl: "https://api.example/evals",
  buyerEmail: "buyer@example.com",
  buyerPassword: "sandbox-pass",
};

function fakeApi(options: { leaseResult?: Lease | "pool_empty" | Error; health?: Health } = {}) {
  const mocks = {
    status: vi.fn(() => Promise.resolve(options.health ?? "operational")),
    lease: vi.fn(() => {
      const r = options.leaseResult ?? lease;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }),
    widgetToken: vi.fn(() => Promise.resolve("widget-token")),
    release: vi.fn(() => Promise.resolve("available" as const)),
    resumeNow: vi.fn(() =>
      Promise.resolve({
        resumed: true,
        actionId: null,
        label: "TIME SHIFT" as const,
        note: "TIME SHIFT: resumed.",
      }),
    ),
  };
  const api: JudgeApi = mocks;
  return { api, mocks };
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

async function show(api: JudgeApi, extra: Partial<JudgeConfig> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  let closeIt: () => void = () => undefined;
  const openWidget = vi.fn((_lease: Lease, onClosed: () => void) => {
    closeIt = onClosed;
    return () => undefined;
  });
  await act(() => {
    render(
      <App api={api} config={{ ...config, ...extra }} openWidget={openWidget} locale="en-US" />,
      container as HTMLElement,
    );
  });
  await flush();
  return { openWidget, closeWidget: () => act(() => closeIt()) };
}

const pageText = () => container?.textContent ?? "";
const button = (start: string) => {
  const found = [...(container?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.trim().startsWith(start),
  );
  if (!found) throw new Error(`No "${start}" button`);
  return found;
};
const click = async (start: string) => {
  await act(() => button(start).click());
  await flush();
};

async function violations(): Promise<string[]> {
  const result = await axe.run(container as HTMLElement, {
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
    },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(" | ")}`);
}

describe("Judge Mode page", () => {
  it("explains itself, shows the status, the three scenarios and the test login", async () => {
    const { api } = fakeApi();
    await show(api);
    expect(pageText()).toContain("All systems operational");
    for (const title of ["Pause instead of cancelling", "Switch to a cheaper plan", "Honest cancel"]) {
      expect(pageText()).toContain(title);
    }
    expect(pageText()).toContain("buyer@example.com");
    expect(await violations()).toEqual([]);
  });

  it("leases a subscription and opens the widget on it, then offers the time machine and the return", async () => {
    const { api, mocks } = fakeApi();
    const { openWidget, closeWidget } = await show(api);
    await click("Try: Pause");
    expect(mocks.lease).toHaveBeenCalledTimes(1);
    expect(openWidget).toHaveBeenCalledWith(lease, expect.any(Function));
    await closeWidget();

    await click("Resume now");
    expect(mocks.resumeNow).toHaveBeenCalledWith(lease);
    expect(pageText()).toContain("TIME SHIFT: resumed.");
    expect(button("Resume now").textContent).toContain("TIME SHIFT");

    await click("I'm done");
    expect(mocks.release).toHaveBeenCalledWith(lease);
    expect(pageText()).toContain("back in the pool");
    expect(await violations()).toEqual([]);
  });

  it("gives each new scenario a fresh subscription, returning the last one", async () => {
    const { api, mocks } = fakeApi();
    const { closeWidget } = await show(api);
    await click("Try: Honest cancel");
    await closeWidget();
    await click("Try: Switch");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.lease).toHaveBeenCalledTimes(2);
  });

  it("shows the real path when the pool is empty, never a blank page", async () => {
    const { api } = fakeApi({ leaseResult: "pool_empty" });
    await show(api);
    await click("Try: Pause");
    const alert = container?.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("Every demo subscription is in use");
    expect(alert?.querySelector("a")?.getAttribute("href")).toBe("https://store.example/");
    expect(await violations()).toEqual([]);
  });

  it("shows the real path and an honest status when the API is down", async () => {
    const { api } = fakeApi({ leaseResult: new JudgeUnreachable("down"), health: "down" });
    await show(api);
    expect(pageText()).toContain("Having trouble right now");
    await click("Try: Pause");
    expect(container?.querySelector("[role=alert]")?.textContent).toContain("can't reach the Keepwell API");
  });

  it("says where the test login is when it isn't on the page", async () => {
    const { api } = fakeApi();
    await show(api, { buyerEmail: null, buyerPassword: null, dashboardUrl: null, evalsUrl: null });
    expect(pageText()).toContain("in the submission's testing instructions");
    expect(pageText()).not.toContain("merchant's dashboard");
  });
});
