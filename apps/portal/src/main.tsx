import { render } from "preact";
import { httpTransport, mount } from "@keepwell/widget";
import { App } from "./app.js";
import { portalApi } from "./api.js";

// The hosted portal: magic-link sign-in, the same widget as the merchant's own page but in place,
// and assistant access tokens. Configuration comes from data attributes on #root, so one build
// serves any merchant:
//   <div id="root" data-api="https://api.keepwell…" data-merchant="pantry-plan"
//        data-merchant-name="Pantry Plan"></div>

const SANDBOX_AUTOPAY = "https://www.sandbox.paypal.com/myaccount/autopay/";

const root = document.getElementById("root");
if (!root) throw new Error("Keepwell portal: #root is missing");
const { api: apiBase, merchant, merchantName, support, autopayUrl } = root.dataset;
if (!apiBase || !merchant) throw new Error("Keepwell portal: data-api and data-merchant are required");

const api = portalApi({ apiBase, merchantSlug: merchant });
const locale = navigator.language;
const autopay = autopayUrl ?? SANDBOX_AUTOPAY;

// The verify redirect says `?error=link_expired`; show it once and keep it out of the address bar.
const url = new URL(location.href);
const initialError = url.searchParams.get("error");
if (initialError !== null) {
  url.searchParams.delete("error");
  history.replaceState(null, "", url);
}

render(
  <App
    api={api}
    merchantName={merchantName ?? merchant}
    locale={locale}
    initialError={initialError}
    autopayUrl={autopay}
    openWidget={(subscriptionId, container, onClosed) =>
      mount(
        {
          transport: httpTransport({ apiBase, channel: "portal", token: () => api.token(subscriptionId) }),
          autopayUrl: autopay,
          supportContact: support ?? null,
          locale,
          apiOrigin: new URL(apiBase).origin,
          fullPage: true,
        },
        onClosed,
        container,
      )
    }
  />,
  root,
);
