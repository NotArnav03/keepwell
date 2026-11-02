import type { DemoStoreTokenResponse, DemoStoreVerifyResponse } from "@keepwell/contracts";

// Pantry Plan's calls to its "backend" (the Keepwell API's demo-store routes). Types only from
// contracts, so the store's bundle stays small; the API validates with zod.

export class StoreApiError extends Error {
  override readonly name = "StoreApiError";

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(fetcher: Fetch, url: string, body: object): Promise<unknown> {
  const res = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) return data;
  const error = (data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  throw new StoreApiError(
    typeof error?.code === "string" ? error.code : "internal",
    typeof error?.message === "string" ? error.message : `HTTP ${res.status}`,
    res.status,
  );
}

/**
 * Asks the server to check the new subscription with PayPal. Right after approval PayPal can still
 * say APPROVAL_PENDING, and the API answers 503 when PayPal is slow, so both are retried a few times.
 */
export async function verifySubscription(
  apiBase: string,
  paypalSubscriptionId: string,
  options: { fetch?: Fetch; attempts?: number; delayMs?: number } = {},
): Promise<DemoStoreVerifyResponse> {
  const fetcher = options.fetch ?? fetch;
  const attempts = options.attempts ?? 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return (await post(fetcher, `${apiBase}/v1/demo-store/subscriptions`, {
        paypalSubscriptionId,
      })) as DemoStoreVerifyResponse;
    } catch (err) {
      const retryable =
        err instanceof StoreApiError && (err.code === "not_active" || err.code === "paypal_unavailable");
      if (!retryable || attempt >= attempts) throw err;
      await sleep((options.delayMs ?? 1500) * attempt);
    }
  }
}

export async function widgetToken(
  apiBase: string,
  shopperToken: string,
  fetcher: Fetch = fetch,
): Promise<DemoStoreTokenResponse> {
  return (await post(fetcher, `${apiBase}/v1/demo-store/token`, { shopperToken })) as DemoStoreTokenResponse;
}
