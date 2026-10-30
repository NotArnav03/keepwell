import {
  PolicyError,
  ReasonCategory,
  type Audit,
  type DomainEvents,
  type ListPoliciesResponse,
  type PlanInfo,
  type PolicyContext,
  type PolicyDocument,
  type PolicyDryRunRequest,
  type PolicyDryRunResponse,
  type PolicyStore,
  type PolicyVersionResponse,
  type PublishPolicyRequest,
  type StoredPolicy,
  type SubscriberHistory,
  type SubscriptionSnapshot,
} from "@keepwell/contracts";
import { computeMenu, validatePolicy } from "@keepwell/policy";

// Policy versions for the merchant dashboard (#27). Publishing is validated by packages/policy,
// append-only, announced as policy.published and audited.

/** Who is calling. Merchant auth (#48) resolves it from the session cookie. */
export interface MerchantPrincipal {
  merchantId: string;
  /** Shown as `publishedBy`: the merchant user's email or name. */
  userLabel: string;
}

/** Read access to the merchant's catalogue and subscribers. M1 backs it with the database. */
export interface MerchantCatalog {
  plans(merchantId: string): Promise<PlanInfo[]>;
  /** Fresh snapshot + history for each id that is this merchant's; other ids are left out. */
  samples(
    merchantId: string,
    subscriptionIds: string[],
  ): Promise<{ subscription: SubscriptionSnapshot; history: SubscriberHistory }[]>;
}

export interface PolicyServiceOptions {
  store: PolicyStore;
  catalog: MerchantCatalog;
  events: DomainEvents;
  audit: Audit;
  clock?: () => Date;
}

export class PolicyService {
  private readonly store: PolicyStore;
  private readonly catalog: MerchantCatalog;
  private readonly events: DomainEvents;
  private readonly audit: Audit;
  private readonly clock: () => Date;

  constructor(options: PolicyServiceOptions) {
    this.store = options.store;
    this.catalog = options.catalog;
    this.events = options.events;
    this.audit = options.audit;
    this.clock = options.clock ?? (() => new Date());
  }

  async list(principal: MerchantPrincipal): Promise<ListPoliciesResponse> {
    const versions = await this.store.list(principal.merchantId);
    return { currentVersion: versions[0]?.version ?? null, versions };
  }

  async get(principal: MerchantPrincipal, version: number): Promise<PolicyVersionResponse> {
    const stored = await this.store.get(principal.merchantId, version);
    if (!stored) throw new PolicyError("not_found", `There is no policy v${version}`);
    return response(stored);
  }

  async publish(principal: MerchantPrincipal, body: PublishPolicyRequest): Promise<PolicyVersionResponse> {
    const { merchantId } = principal;
    const problems = validatePolicy(body.document, await this.catalog.plans(merchantId));
    if (problems.length > 0) {
      throw new PolicyError("invalid_policy", "The policy doesn't match your plans", problems);
    }
    const stored = await this.store.publish({
      merchantId,
      baseVersion: body.baseVersion,
      document: body.document,
      changeNote: body.changeNote ?? null,
      publishedBy: principal.userLabel,
    });
    await this.events.emit({ type: "policy.published", merchantId, payload: { version: stored.version } });
    await this.audit.append({
      merchantId,
      actor: "merchant",
      kind: "policy.published",
      subjectIds: { policyVersion: String(stored.version) },
      payload: {
        version: stored.version,
        baseVersion: body.baseVersion,
        publishedBy: stored.publishedBy,
        changeNote: stored.changeNote,
        document: stored.document,
      },
    });
    return response(stored);
  }

  /** What a draft would offer the sample subscribers right now. Stores nothing. */
  async dryRun(principal: MerchantPrincipal, body: PolicyDryRunRequest): Promise<PolicyDryRunResponse> {
    const { merchantId } = principal;
    const ids = [...new Set(body.sampleSubscriptionIds)];
    const [current, plans, samples] = await Promise.all([
      this.store.current(merchantId),
      this.catalog.plans(merchantId),
      this.catalog.samples(merchantId, ids),
    ]);
    // The menu is labelled with the version the draft would get if published now.
    const document: PolicyDocument = { ...body.document, version: (current?.version ?? 0) + 1 };
    const now = this.clock().toISOString();
    const found = new Set(samples.map((s) => s.subscription.id));
    return {
      computedAt: now,
      problems: validatePolicy(body.document, plans),
      missingSubscriptionIds: ids.filter((id) => !found.has(id)),
      samples: samples.map(({ subscription, history }) => {
        const context: PolicyContext = {
          now,
          channel: "widget",
          reason: "unknown",
          cancelIntent: false,
          offersPresentedThisSession: 0,
          subscription,
          history,
          plans,
        };
        const offerIdsByReason = Object.fromEntries(
          ReasonCategory.options.map((reason) => [
            reason,
            computeMenu(document, { ...context, reason }).offers.map((o) => o.id),
          ]),
        ) as Record<ReasonCategory, string[]>;
        return {
          subscriptionId: subscription.id,
          subscriberFirstName: subscription.subscriberFirstName,
          planName: subscription.planName,
          context,
          menu: computeMenu(document, context),
          offerIdsByReason,
        };
      }),
    };
  }
}

function response({
  version,
  publishedAt,
  publishedBy,
  changeNote,
  document,
}: StoredPolicy): PolicyVersionResponse {
  return { version, publishedAt, publishedBy, changeNote, document };
}
