// Build-time config, injected by scripts/build.mjs as __PANTRY_PLAN_CONFIG__. Only public values:
// the PayPal client id is public by design; no secret ever reaches this site.

export interface StorePlan {
  key: "lite" | "standard" | "annual";
  name: string;
  /** Shown on the card; PayPal's plan holds the real price. */
  priceLabel: string;
  paypalPlanId: string;
}

export interface StoreConfig {
  /** Keepwell API origin: Pantry Plan's "backend" routes live there. */
  apiBase: string;
  /** Where the widget's v1.js is served. */
  widgetBase: string;
  /** Sandbox client id; null = fake mode (no PayPal at all, badged FAKE PAYPAL). */
  paypalClientId: string | null;
  plans: StorePlan[];
  supportContact: string;
  autopayUrl: string;
}

declare const __PANTRY_PLAN_CONFIG__: StoreConfig;

export const config: StoreConfig = __PANTRY_PLAN_CONFIG__;
