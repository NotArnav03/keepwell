import {
  ErrorEnvelope,
  ListPoliciesResponse,
  MerchantAuditQuery,
  MerchantAuditResponse,
  MerchantAuditVerifyResponse,
  MerchantFeedEvent,
  MerchantFeedTicketResponse,
  MerchantLoginRequest,
  MerchantMeResponse,
  MerchantOverviewQuery,
  MerchantOverviewResponse,
  MerchantOnboardingCredentialsRequest,
  MerchantOnboardingCredentialsResponse,
  MerchantOnboardingWebhookResponse,
  MerchantOnboardingBackfillResponse,
  MerchantApiKeyListResponse,
  MerchantCreateApiKeyRequest,
  MerchantCreateApiKeyResponse,
  MerchantSubscriptionDetailResponse,
  MerchantSubscriptionListQuery,
  MerchantSubscriptionListResponse,
  MerchantTimelineQuery,
  MerchantTimelineResponse,
  PolicyDryRunRequest,
  PolicyDryRunResponse,
  PolicyVersionResponse,
  PublishPolicyRequest,
} from "@keepwell/contracts";
import type {
  MerchantFeedEvent as MerchantFeedEventType,
  MerchantLoginRequest as MerchantLoginRequestType,
  MerchantSubscriptionListQuery as MerchantSubscriptionListQueryType,
  MerchantAuditQuery as MerchantAuditQueryType,
  MerchantTimelineQuery as MerchantTimelineQueryType,
  MerchantOverviewQuery as MerchantOverviewQueryType,
  MerchantOnboardingCredentialsRequest as MerchantOnboardingCredentialsRequestType,
  MerchantCreateApiKeyRequest as MerchantCreateApiKeyRequestType,
  PolicyDryRunRequest as PolicyDryRunRequestType,
  PublishPolicyRequest as PublishPolicyRequestType,
} from "@keepwell/contracts";

interface Parser<T> {
  parse(input: unknown): T;
}

export class MerchantApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "MerchantApiError";
  }
}

type Fetcher = typeof fetch;

/** Typed same-origin client. Every network response is validated at the boundary. */
export class MerchantApi {
  private readonly base: URL;
  private csrfToken: string | null = null;

  constructor(
    baseUrl = import.meta.env.VITE_API_BASE_URL || "/v1",
    // Not `fetch` itself: called as `this.fetcher(...)` the browser's fetch would run with `this` set
    // to this client and throw "Illegal invocation".
    private readonly fetcher: Fetcher = (input, init) => globalThis.fetch(input, init),
  ) {
    this.base = new URL(baseUrl, globalThis.location?.origin ?? "http://localhost");
  }

  async login(input: MerchantLoginRequestType): Promise<MerchantMeResponse> {
    const body = MerchantLoginRequest.parse(input);
    const identity = await this.request(
      "/m/auth/login",
      { method: "POST", body: JSON.stringify(body) },
      MerchantMeResponse,
    );
    this.csrfToken = identity.csrfToken;
    return identity;
  }

  async logout(): Promise<void> {
    await this.request("/m/auth/logout", { method: "POST" });
    this.csrfToken = null;
  }

  async me(): Promise<MerchantMeResponse> {
    const identity = await this.request("/m/me", { method: "GET" }, MerchantMeResponse);
    this.csrfToken = identity.csrfToken;
    return identity;
  }

  overview(query: MerchantOverviewQueryType): Promise<MerchantOverviewResponse> {
    const parsed = MerchantOverviewQuery.parse(query);
    const params = new URLSearchParams({ from: parsed.from, to: parsed.to });
    return this.request(`/m/overview?${params}`, { method: "GET" }, MerchantOverviewResponse);
  }

  listSubscriptions(
    query: MerchantSubscriptionListQueryType = {},
  ): Promise<MerchantSubscriptionListResponse> {
    const parsed = MerchantSubscriptionListQuery.parse(query);
    const params = new URLSearchParams();
    if (parsed.query) params.set("query", parsed.query);
    if (parsed.status) params.set("status", parsed.status);
    if (parsed.risk) params.set("risk", parsed.risk);
    if (parsed.cursor) params.set("cursor", parsed.cursor);
    return this.request(
      `/m/subscriptions${params.size ? `?${params}` : ""}`,
      { method: "GET" },
      MerchantSubscriptionListResponse,
    );
  }

  subscription(id: string): Promise<MerchantSubscriptionDetailResponse> {
    return this.request(
      `/m/subscriptions/${encodeURIComponent(id)}`,
      { method: "GET" },
      MerchantSubscriptionDetailResponse,
    );
  }

  audit(query: MerchantAuditQueryType = {}): Promise<MerchantAuditResponse> {
    const parsed = MerchantAuditQuery.parse(query);
    const params = new URLSearchParams();
    if (parsed.cursor) params.set("cursor", parsed.cursor);
    if (parsed.kind) params.set("kind", parsed.kind);
    if (parsed.subject) params.set("subject", parsed.subject);
    return this.request(
      `/m/audit${params.size ? `?${params}` : ""}`,
      { method: "GET" },
      MerchantAuditResponse,
    );
  }

  verifyAudit(): Promise<MerchantAuditVerifyResponse> {
    return this.request("/m/audit/verify", { method: "GET" }, MerchantAuditVerifyResponse);
  }

  timeline(query: MerchantTimelineQueryType): Promise<MerchantTimelineResponse> {
    const parsed = MerchantTimelineQuery.parse(query);
    const params = new URLSearchParams({ from: parsed.from, to: parsed.to });
    return this.request(`/m/timeline?${params}`, { method: "GET" }, MerchantTimelineResponse);
  }

  policies(): Promise<ListPoliciesResponse> {
    return this.request("/m/policies", { method: "GET" }, ListPoliciesResponse);
  }

  policy(version: number): Promise<PolicyVersionResponse> {
    return this.request(`/m/policies/${version}`, { method: "GET" }, PolicyVersionResponse);
  }

  dryRun(input: PolicyDryRunRequestType): Promise<PolicyDryRunResponse> {
    const body = PolicyDryRunRequest.parse(input);
    return this.request(
      "/m/policies/dry-run",
      { method: "POST", body: JSON.stringify(body) },
      PolicyDryRunResponse,
    );
  }

  publishPolicy(input: PublishPolicyRequestType): Promise<PolicyVersionResponse> {
    const body = PublishPolicyRequest.parse(input);
    return this.request("/m/policies", { method: "POST", body: JSON.stringify(body) }, PolicyVersionResponse);
  }

  saveOnboardingCredentials(
    input: MerchantOnboardingCredentialsRequestType,
  ): Promise<MerchantOnboardingCredentialsResponse> {
    const body = MerchantOnboardingCredentialsRequest.parse(input);
    return this.request(
      "/m/onboarding/credentials",
      { method: "POST", body: JSON.stringify(body) },
      MerchantOnboardingCredentialsResponse,
    );
  }

  registerWebhook(): Promise<MerchantOnboardingWebhookResponse> {
    return this.request("/m/onboarding/webhook", { method: "POST" }, MerchantOnboardingWebhookResponse);
  }

  backfill(): Promise<MerchantOnboardingBackfillResponse> {
    return this.request("/m/onboarding/backfill", { method: "POST" }, MerchantOnboardingBackfillResponse);
  }

  apiKeys(): Promise<MerchantApiKeyListResponse> {
    return this.request("/m/api-keys", { method: "GET" }, MerchantApiKeyListResponse);
  }

  createApiKey(input: MerchantCreateApiKeyRequestType): Promise<MerchantCreateApiKeyResponse> {
    const body = MerchantCreateApiKeyRequest.parse(input);
    return this.request(
      "/m/api-keys",
      { method: "POST", body: JSON.stringify(body) },
      MerchantCreateApiKeyResponse,
    );
  }

  async deleteApiKey(id: string): Promise<void> {
    await this.request(`/m/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /**
   * The live feed. It opens on the API's own host with a read-only ticket, not through this site's
   * /v1 rewrite: Render's static-site rewrite buffers a stream until it ends, so nothing would show.
   * EventSource reconnects by itself after a network blip; once the stream is refused (the ticket
   * expired, or the session ended) it stops, so this asks for a new ticket and resumes after the
   * last event it saw.
   */
  subscribeToFeed(onEvent: (event: MerchantFeedEventType) => void, onError?: () => void): () => void {
    let stopped = false;
    let source: EventSource | null = null;
    let lastEventId: string | null = null;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => {
      if (stopped) return;
      failures++;
      retryTimer = setTimeout(() => void open(), Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
    };
    const open = async () => {
      let streamUrl: string;
      try {
        ({ streamUrl } = await this.request(
          "/m/feed/ticket",
          { method: "POST" },
          MerchantFeedTicketResponse,
        ));
      } catch {
        onError?.();
        retry();
        return;
      }
      if (stopped) return;
      const url = new URL(streamUrl);
      if (lastEventId) url.searchParams.set("after", lastEventId);
      const current = new EventSource(url);
      source = current;
      current.onopen = () => {
        failures = 0;
      };
      current.onmessage = (message) => {
        if (message.lastEventId) lastEventId = message.lastEventId;
        try {
          const data: unknown = message.data;
          if (typeof data !== "string") throw new TypeError("SSE data was not text");
          const payload: unknown = JSON.parse(data);
          onEvent(MerchantFeedEvent.parse(payload));
        } catch {
          // Keep the stream open for later frames, but let the view know a frame could not be read.
          onError?.();
        }
      };
      current.onerror = () => {
        onError?.();
        if (current.readyState === EventSource.CLOSED) {
          current.close();
          retry();
        }
      };
    };
    void open();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }

  /**
   * Same URL, cookie and CSRF header as the typed methods, without reading the body.
   * Insights streams a POST response and must not go through `request`, which always parses JSON.
   */
  fetchRaw(path: string, init: RequestInit): Promise<Response> {
    return this.fetcher(new URL(path.replace(/^\//, ""), `${this.base.href.replace(/\/$/, "")}/`), {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase()) && this.csrfToken
          ? { "x-keepwell-csrf": this.csrfToken }
          : {}),
        ...init.headers,
      },
    });
  }

  private async request<T = undefined>(path: string, init: RequestInit, schema?: Parser<T>): Promise<T> {
    const response = await this.fetchRaw(path, init);
    if (!response.ok) {
      let code = "http_error";
      let message = `Request failed (${response.status})`;
      try {
        const body: unknown = await response.json();
        const parsed = ErrorEnvelope.safeParse(body);
        if (parsed.success) {
          code = parsed.data.error.code;
          message = parsed.data.error.message;
        }
      } catch {
        // Keep the status-based error if the server has no valid error envelope.
      }
      throw new MerchantApiError(message, response.status, code);
    }
    if (!schema) return undefined as T;
    const body: unknown = await response.json();
    return schema.parse(body);
  }
}
