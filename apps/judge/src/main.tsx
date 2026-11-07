import { render } from "preact";
import { httpTransport, mount } from "@keepwell/widget";
import { judgeApi } from "./api.js";
import { App } from "./app.js";

// Judge Mode's page. Configuration comes from data attributes on #root (scripts/build.mjs):
// where the API is (empty: this origin's /v1, behind a rewrite), the store, dashboard and eval
// links, and the sandbox buyer's test login.

const SANDBOX_AUTOPAY = "https://www.sandbox.paypal.com/myaccount/autopay/";

const root = document.getElementById("root");
if (!root) throw new Error("Judge Mode: #root is missing");
const data = root.dataset;
const apiBase = data.api ?? "";
const api = judgeApi({ apiBase });
const orNull = (value: string | undefined) => (value === undefined || value === "" ? null : value);

render(
  <App
    api={api}
    locale={navigator.language}
    config={{
      storeUrl: data.storeUrl ?? "/",
      dashboardUrl: orNull(data.dashboardUrl),
      evalsUrl: orNull(data.evalsUrl),
      buyerEmail: orNull(data.buyerEmail),
      buyerPassword: orNull(data.buyerPassword),
    }}
    openWidget={(lease, onClosed) =>
      mount(
        {
          transport: httpTransport({ apiBase, token: () => api.widgetToken(lease) }),
          autopayUrl: SANDBOX_AUTOPAY,
          supportContact: orNull(data.support),
          locale: navigator.language,
          // The return page after PayPal's approval is the API's own.
          apiOrigin: data.apiOrigin || location.origin,
        },
        onClosed,
      )
    }
  />,
  root,
);
