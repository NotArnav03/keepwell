import type {
  CreateDelegationResponse,
  DelegationScope,
  PortalMe,
  PortalTokenResponse,
} from "@keepwell/contracts";

// The portal's calls to the Keepwell API (CONTRACTS.md §4). Types only from contracts: the zod
// schemas would triple the bundle, and the API validates everything it sends.
//
// Deployed, the portal calls /v1 on its own origin and the host rewrites it to the API, so the PORTAL
// cookie is first-party (apiBase ""). `credentials: "include"` also covers calling the API directly
// in local development, where the API answers only origins it trusts.

/** The API answered with an error envelope (or something that wasn't one). */
export class PortalApiError extends Error {
  override readonly name = "PortalApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds to wait, when the API said so (429). */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

/** The API couldn't be reached at all. */
export class PortalUnreachable extends Error {
  override readonly name = "PortalUnreachable";
}

export interface PortalApi {
  /** The signed-in subscriber's page, or null when there is no valid session. */
  me(): Promise<PortalMe | null>;
  /** Always resolves when the API accepted the request: it says nothing about whether the email matched. */
  requestLink(email: string): Promise<void>;
  /** A short-lived token for the widget, bound to one subscription. */
  token(subscriptionId: string): Promise<string>;
  createDelegation(subscriptionId: string, scopes: DelegationScope[]): Promise<CreateDelegationResponse>;
  revokeDelegation(id: string): Promise<void>;
  logout(): Promise<void>;
}

export interface PortalApiOptions {
  /** "" for the same origin (deployed, behind the /v1 rewrite), or e.g. http://localhost:3000. No /v1. */
  apiBase: string;
  merchantSlug: string;
  fetch?: typeof fetch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function portalApi(options: PortalApiOptions): PortalApi {
  const base = `${options.apiBase.replace(/\/$/, "")}/v1`;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function call(method: string, path: string, body?: object): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, {
        method,
        credentials: "include",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new PortalUnreachable(err instanceof Error ? err.message : "Network error");
    }
  }

  async function fail(res: Response): Promise<never> {
    const data: unknown = await res.json().catch(() => null);
    const error = isRecord(data) && isRecord(data.error) ? data.error : null;
    if (error === null && res.status >= 500) throw new PortalUnreachable(`HTTP ${res.status}`);
    const retry = Number(res.headers.get("retry-after"));
    throw new PortalApiError(
      res.status,
      typeof error?.code === "string" ? error.code : "internal",
      typeof error?.message === "string" ? error.message : `HTTP ${res.status}`,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }

  const json = async <T>(res: Response, keys: string[], what: string): Promise<T> => {
    if (!res.ok) return fail(res);
    const data: unknown = await res.json().catch(() => null);
    if (!isRecord(data) || keys.some((key) => !(key in data))) {
      throw new PortalApiError(200, "internal", `Unexpected ${what} from the API`);
    }
    return data as T;
  };

  return {
    async me() {
      const res = await call("GET", "/portal/me");
      if (res.status === 401) return null;
      return json<PortalMe>(res, ["subscriptions", "delegations"], "account");
    },
    async requestLink(email) {
      const res = await call("POST", "/portal/magic-link", { merchantSlug: options.merchantSlug, email });
      if (res.status !== 202) await fail(res);
    },
    async token(subscriptionId) {
      const res = await call("POST", "/portal/token", { subscriptionId });
      return (await json<PortalTokenResponse>(res, ["token"], "token")).token;
    },
    async createDelegation(subscriptionId, scopes) {
      const res = await call("POST", "/delegations", { subscriptionId, scopes });
      return json<CreateDelegationResponse>(res, ["id", "token", "scopes", "expiresAt"], "delegation");
    },
    async revokeDelegation(id) {
      const res = await call("DELETE", `/delegations/${encodeURIComponent(id)}`);
      if (res.status !== 204) await fail(res);
    },
    async logout() {
      const res = await call("POST", "/portal/logout");
      if (res.status !== 204) await fail(res);
    },
  };
}
