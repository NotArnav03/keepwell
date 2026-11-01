// Records real sandbox calls as paypal-mock fixtures (#6): wrap the gateway's fetch, and each call
// comes back as a request/response pair in spike Q1's fixture shape. Scrubbed before anything is
// kept (packages/paypal-mock/CLAUDE.md): no tokens, emails, payer or merchant ids, addresses or
// buyer names. OAuth calls are never recorded at all.

export interface Exchange {
  request: { method: string; path: string; headers: Record<string, string>; body: unknown };
  response: { status: number; debugId: string | null; body: unknown };
}

const REDACTED = "REDACTED";
const EMAIL = "redacted@example.com";

/** Keys whose values identify a person or an account, and what replaces them. */
const REPLACE: Record<string, unknown> = {
  email_address: EMAIL,
  payer_email: EMAIL,
  email: EMAIL,
  payer_id: REDACTED,
  merchant_id: REDACTED,
  account_id: REDACTED,
  given_name: "Sandbox",
  surname: "Buyer",
  full_name: "Sandbox Buyer",
  phone: REDACTED,
  phone_number: REDACTED,
  shipping_address: REDACTED,
  address: REDACTED,
  access_token: REDACTED,
  refresh_token: REDACTED,
  client_secret: REDACTED,
};
/** One-time approval tokens in links: harmless once used, but they are tokens. */
const TOKEN_QUERY = /([?&](?:ba_token|token)=)[^&"]+/g;

/** A deep copy with every identifying value replaced. */
export function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(TOKEN_QUERY, `$1${REDACTED}`);
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, key in REPLACE ? REPLACE[key] : scrub(v)]),
  );
}

/**
 * A fetch that hands every non-OAuth exchange, scrubbed, to `record`. The response is read from a
 * clone, so the gateway sees it untouched.
 */
export function recordingFetch(
  record: (exchange: Exchange) => void,
  inner: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const res = await inner(input, init);
    if (url.pathname === "/v1/oauth2/token") return res;
    const requestId = new Headers(init?.headers).get("paypal-request-id");
    const text = await res.clone().text();
    record({
      request: {
        method: init?.method ?? "GET",
        path: scrub(`${url.pathname}${url.search}`) as string,
        headers: requestId ? { "paypal-request-id": requestId } : {},
        body: scrub(typeof init?.body === "string" ? json(init.body) : null),
      },
      response: { status: res.status, debugId: res.headers.get("paypal-debug-id"), body: scrub(json(text)) },
    });
    return res;
  };
}

function json(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON (an HTML error page, say): keep it as text, it is still evidence.
    return text;
  }
}
