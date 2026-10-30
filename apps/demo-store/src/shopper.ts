import type { DemoStoreVerifyResponse } from "@keepwell/contracts";

// The demo store's "login": what the server's verification returned, kept in this browser.
// All fictional (Pantry Plan); nothing personal is stored, only the sandbox subscription id.

const KEY = "pantry-plan.shopper";

export type Shopper = DemoStoreVerifyResponse;

export function saveShopper(shopper: Shopper, storage: Storage = localStorage): void {
  storage.setItem(KEY, JSON.stringify(shopper));
}

export function loadShopper(storage: Storage = localStorage): Shopper | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    const ok =
      typeof value === "object" &&
      value !== null &&
      typeof (value as Shopper).shopperToken === "string" &&
      typeof (value as Shopper).paypalSubscriptionId === "string";
    return ok ? (value as Shopper) : null;
  } catch {
    return null;
  }
}

export function forgetShopper(storage: Storage = localStorage): void {
  storage.removeItem(KEY);
}
