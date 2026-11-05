export interface PanelFailure {
  kind: "unauthorized" | "unavailable" | "error";
  message: string;
}

export class InsightsError extends Error {
  override readonly name = "InsightsError";

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

/** 404 means the route is not mounted on this API yet. 401 keeps the envelope message. */
export function panelFailure(cause: unknown): PanelFailure {
  const status = statusOf(cause);
  const message = cause instanceof Error && cause.message ? cause.message : "Request failed.";
  if (status === 401) return { kind: "unauthorized", message };
  if (status === 404) return { kind: "unavailable", message };
  return { kind: "error", message };
}

function statusOf(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null || !("status" in cause)) return null;
  return typeof cause.status === "number" ? cause.status : null;
}
