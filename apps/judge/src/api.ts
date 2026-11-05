import type {
  JudgeLeaseResponse,
  JudgeResumeResponse,
  JudgeReturnResponse,
  JudgeWidgetTokenResponse,
} from "@keepwell/contracts";

// Judge Mode's calls to the Keepwell API (CONTRACTS.md §4 "Demo / Judge Mode"). Types only from
// contracts. Deployed, the page calls /v1 on its own origin behind a rewrite (apiBase ""); the lease
// token rides as a bearer header, so no cookie is involved either way.

export type Health = "operational" | "degraded" | "down" | "unknown";

export class JudgeApiError extends Error {
  override readonly name = "JudgeApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The API couldn't be reached at all: show the fallback. */
export class JudgeUnreachable extends Error {
  override readonly name = "JudgeUnreachable";
}

export interface Lease {
  leaseId: string;
  leaseToken: string;
  expiresAt: string;
  subscriptionId: string;
}

export interface JudgeApi {
  /** GET /status, as the public status page reports it. Never throws. */
  status(): Promise<Health>;
  /** A 30-minute lease, or "pool_empty" when every demo subscription is in use. */
  lease(): Promise<Lease | "pool_empty">;
  widgetToken(lease: Lease): Promise<string>;
  release(lease: Lease): Promise<JudgeReturnResponse["result"]>;
  resumeNow(lease: Lease): Promise<JudgeResumeResponse>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function judgeApi(options: { apiBase: string; fetch?: typeof fetch }): JudgeApi {
  const base = options.apiBase.replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function call(method: string, path: string, lease?: Lease): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, {
        method,
        ...(lease ? { headers: { authorization: `Bearer ${lease.leaseToken}` } } : {}),
      });
    } catch (err) {
      throw new JudgeUnreachable(err instanceof Error ? err.message : "Network error");
    }
  }

  async function body<T>(res: Response, keys: string[]): Promise<T> {
    const data: unknown = await res.json().catch(() => null);
    if (res.ok && isRecord(data) && keys.every((k) => k in data)) return data as T;
    const error = isRecord(data) && isRecord(data.error) ? data.error : null;
    if (error === null && res.status >= 500) throw new JudgeUnreachable(`HTTP ${res.status}`);
    throw new JudgeApiError(
      res.status,
      typeof error?.code === "string" ? error.code : "internal",
      typeof error?.message === "string" ? error.message : `HTTP ${res.status}`,
    );
  }

  return {
    async status() {
      try {
        const res = await doFetch(`${base}/status`);
        const data: unknown = await res.json().catch(() => null);
        const value = isRecord(data) ? data.status : null;
        return value === "operational" || value === "degraded" || value === "down" ? value : "unknown";
      } catch {
        return "down";
      }
    },
    async lease() {
      const res = await call("POST", "/v1/demo/leases");
      if (res.status === 503) {
        const data: unknown = await res
          .clone()
          .json()
          .catch(() => null);
        if (isRecord(data) && isRecord(data.error) && data.error.code === "pool_empty") return "pool_empty";
      }
      const leased = await body<JudgeLeaseResponse>(res, [
        "leaseId",
        "leaseToken",
        "expiresAt",
        "subscriptionId",
      ]);
      return leased;
    },
    async widgetToken(lease) {
      const res = await call("POST", `/v1/demo/leases/${encodeURIComponent(lease.leaseId)}/token`, lease);
      return (await body<JudgeWidgetTokenResponse>(res, ["token"])).token;
    },
    async release(lease) {
      const res = await call("DELETE", `/v1/demo/leases/${encodeURIComponent(lease.leaseId)}`, lease);
      return (await body<JudgeReturnResponse>(res, ["result"])).result;
    },
    async resumeNow(lease) {
      const res = await call(
        "POST",
        `/v1/demo/time-machine/resume/${encodeURIComponent(lease.subscriptionId)}`,
        lease,
      );
      return body<JudgeResumeResponse>(res, ["resumed", "label", "note"]);
    },
  };
}
