// Embeddable Preact widget in Shadow DOM. Owner: Aditya (M3).
//
//   <a href="/account/cancel" data-keepwell-cancel>Cancel subscription</a>
//   <script src="https://widget.keepwell…/v1.js" data-api="https://api.keepwell…"
//           data-token-endpoint="/keepwell-token" async></script>
//
// The merchant's own link stays the fallback: until this script has loaded (or if it never does),
// the cancel button works exactly as the merchant built it.
import { mount } from "./mount.js";
import { httpTransport } from "./transport.js";

export { mount } from "./mount.js";
export { Widget, type WidgetProps } from "./widget.js";
export { httpTransport, ApiError, ApiUnreachable, type Transport } from "./transport.js";
export { reduce, initialState, type WidgetState, type WidgetEvent } from "./state.js";

const SANDBOX_AUTOPAY = "https://www.sandbox.paypal.com/myaccount/autopay/";

export interface WidgetConfig {
  apiBase: string;
  /** POST here (the merchant's own backend, same origin) returns `{ token }`. */
  tokenEndpoint: string | null;
  /** A fixed token, for local development against the fake sessions server only. */
  token: string | null;
  autopayUrl: string;
  supportContact: string | null;
  locale: string;
}

export function configFrom(script: HTMLScriptElement): WidgetConfig {
  const data = script.dataset;
  if (!data.api) throw new Error("Keepwell widget: data-api is required");
  return {
    apiBase: data.api,
    tokenEndpoint: data.tokenEndpoint ?? null,
    token: data.token ?? null,
    autopayUrl: data.autopayUrl ?? SANDBOX_AUTOPAY,
    supportContact: data.support ?? null,
    locale: data.locale ?? navigator.language,
  };
}

async function fetchToken(config: WidgetConfig): Promise<string> {
  if (config.token !== null) return config.token;
  if (config.tokenEndpoint === null) throw new Error("Keepwell widget: data-token-endpoint is required");
  const res = await fetch(config.tokenEndpoint, { method: "POST", credentials: "same-origin" });
  if (!res.ok) throw new Error(`Token endpoint answered ${res.status}`);
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== "string") throw new Error("Token endpoint returned no token");
  return body.token;
}

export function open(config: WidgetConfig, onClosed?: () => void): () => void {
  return mount(
    {
      transport: httpTransport({ apiBase: config.apiBase, token: () => fetchToken(config) }),
      autopayUrl: config.autopayUrl,
      supportContact: config.supportContact,
      locale: config.locale,
    },
    onClosed,
  );
}

/** Wires every `[data-keepwell-cancel]` on the page to the widget. One open at a time. */
export function install(config: WidgetConfig, doc: Document = document): void {
  let isOpen = false;
  const openOnce = () => {
    if (isOpen) return;
    isOpen = true;
    open(config, () => (isOpen = false));
  };
  doc.addEventListener("click", (event) => {
    const trigger = event.target instanceof Element ? event.target.closest("[data-keepwell-cancel]") : null;
    if (!trigger) return;
    event.preventDefault();
    openOnce();
  });
  window.Keepwell = { open: openOnce };
}

declare global {
  interface Window {
    Keepwell?: { open: () => void };
  }
}

// Self-install when loaded from a script tag that carries data-api.
const script = typeof document === "undefined" ? null : document.currentScript;
if (script instanceof HTMLScriptElement && script.dataset.api !== undefined) {
  install(configFrom(script));
}
