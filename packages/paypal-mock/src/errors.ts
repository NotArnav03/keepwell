// PayPal's REST error body: `name`, `message`, `debug_id` and `details[].issue`. The gateway (#8)
// maps these to PayPalGatewayError, so the shapes and status codes follow PayPal's docs.

const MESSAGES: Record<string, string> = {
  INVALID_REQUEST: "Request is not well-formed, syntactically incorrect, or violates schema.",
  AUTHENTICATION_FAILURE:
    "Authentication failed due to invalid authentication credentials or a missing Authorization header.",
  RESOURCE_NOT_FOUND: "The specified resource does not exist.",
  UNPROCESSABLE_ENTITY:
    "The requested action could not be performed, semantically incorrect, or failed business validation.",
  RATE_LIMIT_REACHED: "Too many requests. Blocked due to rate limiting.",
  INTERNAL_SERVER_ERROR: "An internal server error has occurred.",
  SERVICE_UNAVAILABLE: "Service Unavailable.",
};

const NAME_FOR_STATUS: Record<number, string> = {
  400: "INVALID_REQUEST",
  401: "AUTHENTICATION_FAILURE",
  404: "RESOURCE_NOT_FOUND",
  422: "UNPROCESSABLE_ENTITY",
  429: "RATE_LIMIT_REACHED",
  500: "INTERNAL_SERVER_ERROR",
  503: "SERVICE_UNAVAILABLE",
};

export class PayPalApiError extends Error {
  override readonly name = "PayPalApiError";

  constructor(
    readonly status: number,
    readonly issue: string | null = null,
    readonly description: string | null = null,
  ) {
    super(description ?? `PayPal mock error ${status}`);
  }

  get errorName(): string {
    return NAME_FOR_STATUS[this.status] ?? "INTERNAL_SERVER_ERROR";
  }

  body(debugId: string): Record<string, unknown> {
    return {
      name: this.errorName,
      message: MESSAGES[this.errorName] ?? this.message,
      debug_id: debugId,
      ...(this.issue && { details: [{ issue: this.issue, description: this.description ?? "" }] }),
    };
  }
}

export const notFound = (what: string) =>
  new PayPalApiError(404, "INVALID_RESOURCE_ID", `${what} was not found.`);

export const unprocessable = (issue: string, description: string) =>
  new PayPalApiError(422, issue, description);

export const invalidRequest = (issue: string, description: string) =>
  new PayPalApiError(400, issue, description);
