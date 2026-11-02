import { StoreApiError, widgetToken } from "./api.js";
import { config } from "./config.js";
import { forgetShopper, loadShopper } from "./shopper.js";

// The account page: shows the verified subscription and installs the Keepwell widget, exactly as
// a real merchant would (one script tag), with tokens from Pantry Plan's backend.

declare global {
  interface Window {
    /** Read by the Keepwell widget when it needs a token (packages/widget/src/index.ts). */
    keepwellGetToken?: () => Promise<string>;
  }
}

const shopper = loadShopper();
const signedIn = document.querySelector<HTMLElement>("#signed-in");
const signedOut = document.querySelector<HTMLElement>("#signed-out");

if (shopper === null) {
  signedOut?.removeAttribute("hidden");
} else {
  signedIn?.removeAttribute("hidden");
  const set = (selector: string, text: string) => {
    const el = document.querySelector(selector);
    if (el) el.textContent = text;
  };
  set("#plan-name", shopper.planName);
  set("#plan-status", shopper.status);
  set("#subscription-id", shopper.paypalSubscriptionId);

  window.keepwellGetToken = async () => {
    try {
      return (await widgetToken(config.apiBase, shopper.shopperToken)).token;
    } catch (err) {
      // The shopper token expired or is no longer valid: sign out rather than loop.
      if (err instanceof StoreApiError && err.status === 401) forgetShopper();
      throw err;
    }
  };

  const widget = document.createElement("script");
  widget.src = `${config.widgetBase}/v1.js`;
  widget.dataset.api = config.apiBase;
  widget.dataset.support = config.supportContact;
  widget.dataset.autopayUrl = config.autopayUrl;
  document.body.append(widget);

  document.querySelector("#sign-out")?.addEventListener("click", () => {
    forgetShopper();
    location.assign("index.html");
  });
}
