import { z } from "zod";
import { Id, IsoDateTime, ReasonCategory } from "../shared.js";
import { OfferId, OfferMenu } from "./offers.js";
import { PolicyContext, PolicyDocument } from "./policy.js";

// Policy versions and the merchant policy API: GET/POST /v1/m/policies, GET /v1/m/policies/:version
// and POST /v1/m/policies/dry-run (CONTRACTS.md §4, owner M2). Consumers: the dashboard's policy
// editor (M4, #53) and the sessions module, which loads the current policy (M3).

/** A policy as the merchant edits it: everything but `version`, which publishing assigns. */
export const PolicyDraft = PolicyDocument.omit({ version: true });
export type PolicyDraft = z.infer<typeof PolicyDraft>;

/** One problem with a draft that zod can't see, with the dotted path of the field to fix. */
export const PolicyProblem = z.object({ path: z.string().min(1), message: z.string().min(1) });
export type PolicyProblem = z.infer<typeof PolicyProblem>;

const Version = z.number().int().min(1);
const ChangeNote = z.string().trim().max(280);

export const PolicyVersionSummary = z.object({
  version: Version,
  publishedAt: IsoDateTime,
  /** The merchant user who published it, or "system" for the seeded first version. */
  publishedBy: z.string().min(1),
  changeNote: ChangeNote.nullable(),
});
export type PolicyVersionSummary = z.infer<typeof PolicyVersionSummary>;

/** One immutable version. `document.version` always equals `version`. */
export const StoredPolicy = PolicyVersionSummary.extend({
  merchantId: Id,
  document: PolicyDocument,
});
export type StoredPolicy = z.infer<typeof StoredPolicy>;

/** GET /m/policies: newest first. `currentVersion` is null before anything is published. */
export const ListPoliciesResponse = z.object({
  currentVersion: Version.nullable(),
  versions: z.array(PolicyVersionSummary),
});
export type ListPoliciesResponse = z.infer<typeof ListPoliciesResponse>;

/** GET /m/policies/:version, and the body POST /m/policies returns. */
export const PolicyVersionResponse = PolicyVersionSummary.extend({ document: PolicyDocument });
export type PolicyVersionResponse = z.infer<typeof PolicyVersionResponse>;

/**
 * POST /m/policies. `baseVersion` is the version the editor started from (null for the first
 * publish); if another version was published since, the request fails with `version_conflict`
 * instead of silently overwriting it.
 */
export const PublishPolicyRequest = z.strictObject({
  baseVersion: Version.nullable(),
  document: PolicyDraft,
  changeNote: ChangeNote.optional(),
});
export type PublishPolicyRequest = z.infer<typeof PublishPolicyRequest>;

export const DRY_RUN_MAX_SAMPLES = 20;

/** POST /m/policies/dry-run: what a draft would offer these subscribers. Nothing is stored. */
export const PolicyDryRunRequest = z.strictObject({
  document: PolicyDraft,
  sampleSubscriptionIds: z.array(Id).min(1).max(DRY_RUN_MAX_SAMPLES),
});
export type PolicyDryRunRequest = z.infer<typeof PolicyDryRunRequest>;

export const PolicyDryRunSample = z.object({
  subscriptionId: Id,
  subscriberFirstName: z.string().nullable(),
  planName: z.string(),
  /**
   * Fresh inputs with reason "unknown", so the editor can re-run computeMenu in the browser for
   * any reason or edit without another request.
   */
  context: PolicyContext,
  /** The draft's menu for that context. Its `policyVersion` is the version the draft would get. */
  menu: OfferMenu,
  /** Which menu offers each reason allows, in ranked order (empty: only Cancel). */
  offerIdsByReason: z.record(ReasonCategory, z.array(OfferId)),
});
export type PolicyDryRunSample = z.infer<typeof PolicyDryRunSample>;

export const PolicyDryRunResponse = z.object({
  computedAt: IsoDateTime,
  samples: z.array(PolicyDryRunSample),
  /** Requested ids that aren't this merchant's subscriptions. */
  missingSubscriptionIds: z.array(Id),
  /** What publishing this draft would reject (`invalid_policy`); empty means it can be published. */
  problems: z.array(PolicyProblem),
});
export type PolicyDryRunResponse = z.infer<typeof PolicyDryRunResponse>;

export const PolicyErrorCode = z.enum([
  "unauthorized",
  "not_found",
  "invalid_request",
  /** Valid JSON, but the policy contradicts the plan catalogue (e.g. an unknown target plan). */
  "invalid_policy",
  /** `baseVersion` isn't the latest version any more. */
  "version_conflict",
  "internal",
]);
export type PolicyErrorCode = z.infer<typeof PolicyErrorCode>;

const HTTP_STATUS: Record<PolicyErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  invalid_policy: 422,
  version_conflict: 409,
  internal: 500,
};

/** What PolicyStore and the policy routes throw; the HTTP layer turns it into an ErrorEnvelope. */
export class PolicyError extends Error {
  override readonly name = "PolicyError";

  constructor(
    readonly code: PolicyErrorCode,
    message: string,
    /** For invalid_policy: one entry per problem, each with the path into the document. */
    readonly details?: PolicyProblem[],
  ) {
    super(message);
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

export interface PublishPolicyInput {
  merchantId: string;
  baseVersion: number | null;
  document: PolicyDraft;
  changeNote: string | null;
  publishedBy: string;
}

/** Immutable, append-only policy versions per merchant. M1 backs it with Postgres. */
export interface PolicyStore<Tx = unknown> {
  current(merchantId: string): Promise<StoredPolicy | null>;
  get(merchantId: string, version: number): Promise<StoredPolicy | null>;
  /** Newest first. */
  list(merchantId: string): Promise<PolicyVersionSummary[]>;
  /**
   * Appends the next version (latest + 1, or 1). Throws PolicyError("version_conflict") when
   * `baseVersion` isn't the latest, so two editors can't overwrite each other.
   */
  publish(input: PublishPolicyInput, tx?: Tx): Promise<StoredPolicy>;
}
