import {
  PolicyError,
  StoredPolicy,
  type PolicyStore,
  type PolicyVersionSummary,
  type PublishPolicyInput,
} from "../brain/policy-api.js";

/** In-memory PolicyStore with the same rules as the real one: append-only, conflict on a stale base. */
export class FakePolicyStore implements PolicyStore {
  private readonly versions = new Map<string, StoredPolicy[]>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  current(merchantId: string): Promise<StoredPolicy | null> {
    return Promise.resolve(this.of(merchantId).at(-1) ?? null);
  }

  get(merchantId: string, version: number): Promise<StoredPolicy | null> {
    return Promise.resolve(this.of(merchantId).find((p) => p.version === version) ?? null);
  }

  list(merchantId: string): Promise<PolicyVersionSummary[]> {
    const summaries = this.of(merchantId).map(({ version, publishedAt, publishedBy, changeNote }) => ({
      version,
      publishedAt,
      publishedBy,
      changeNote,
    }));
    return Promise.resolve(summaries.reverse());
  }

  publish(input: PublishPolicyInput): Promise<StoredPolicy> {
    return new Promise((resolve) => {
      const versions = this.of(input.merchantId);
      const latest = versions.at(-1)?.version ?? null;
      if (input.baseVersion !== latest) {
        throw new PolicyError(
          "version_conflict",
          `Started from v${input.baseVersion ?? "none"}, but v${latest ?? "none"} is the latest`,
        );
      }
      const version = (latest ?? 0) + 1;
      const stored = StoredPolicy.parse({
        merchantId: input.merchantId,
        version,
        publishedAt: this.clock().toISOString(),
        publishedBy: input.publishedBy,
        changeNote: input.changeNote,
        document: { ...input.document, version },
      });
      this.versions.set(input.merchantId, [...versions, stored]);
      resolve(structuredClone(stored));
    });
  }

  private of(merchantId: string): StoredPolicy[] {
    return structuredClone(this.versions.get(merchantId) ?? []);
  }
}
