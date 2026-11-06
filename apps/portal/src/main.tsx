import { render } from "preact";
import { httpTransport, mount } from "@keepwell/widget";
import { App } from "./app.js";
import { portalApi } from "./api.js";

// The hosted portal: magic-link sign-in, the same widget as the merchant's own page but in place,
// and assistant access tokens. Configuration comes from data attributes on #root, so one build
// serves any merchant:
//   <div id="root" data-merchant="pantry-plan" data-merchant-name="Pantry Plan"
//        data-api-origin="https://api.keepwell…"></div>
//
// The portal calls its own origin's /v1, which the host rewrites to the API (Render, like the
// dashboard). That keeps the PORTAL cookie first-party: two *.onrender.com hosts are different
// sites, and a SameSite=Lax cookie is never sent on a cross-site fetch. `data-api` may still name
// an absolute API base for local experiments; empty (the default) means same origin.

const SANDBOX_AUTOPAY = "https://www.sandbox.paypal.com/myaccount/autopay/";

const root = document.getElementById("root");
if (!root) throw new Error("Keepwell portal: #root is missing");
const { api: apiBase = "", apiOrigin, merchant, merchantName, support, autopayUrl } = root.dataset;
if (!merchant) throw new Error("Keepwell portal: data-merchant is required");

const api = portalApi({ apiBase, merchantSlug: merchant });
const locale = navigator.language;
const autopay = autopayUrl ?? SANDBOX_AUTOPAY;
// Who may post the "keepwell.revise" message after PayPal's approval page: the API's own origin
// (its /v1/revise/return page), which behind the rewrite is not this page's.
const trustedOrigin = apiOrigin || (apiBase === "" ? location.origin : new URL(apiBase).origin);

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
          apiOrigin: trustedOrigin,
          fullPage: true,
        },
        onClosed,
        container,
      )
    }
  />,
  root,
);
