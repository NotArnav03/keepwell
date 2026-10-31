import { DunningCase } from "@keepwell/contracts";
import { uuidv7 } from "@keepwell/contracts/fakes";
import type { DunningCasePatch, DunningStore, NewDunningCase } from "./ports.js";

/**
 * In-memory DunningStore for tests. Like the real one it scopes every read and write by merchant.
 * The Postgres store is a follow-up: the `dunning_cases` table must first match the DunningCase
 * contract (state values and the outstanding/notification/capture columns).
 */
export class InMemoryDunningStore implements DunningStore {
  readonly cases: DunningCase[] = [];

  findActive(_tx: unknown, merchantId: string, subscriptionId: string): Promise<DunningCase | null> {
    const found = this.cases.findLast(
      (c) =>
        c.merchantId === merchantId &&
        c.subscriptionId === subscriptionId &&
        (c.state === "open" || c.state === "suspended"),
    );
    return Promise.resolve(found ? structuredClone(found) : null);
  }

  insert(_tx: unknown, c: NewDunningCase): Promise<DunningCase> {
    const created = DunningCase.parse({ ...c, id: uuidv7() });
    this.cases.push(created);
    return Promise.resolve(structuredClone(created));
  }

  update(_tx: unknown, merchantId: string, id: string, patch: DunningCasePatch): Promise<DunningCase> {
    const found = this.cases.find((c) => c.id === id && c.merchantId === merchantId);
    if (!found) return Promise.reject(new Error(`No dunning case ${id} for merchant ${merchantId}`));
    Object.assign(found, patch);
    DunningCase.parse(found);
    return Promise.resolve(structuredClone(found));
  }

  listUnnotified(): Promise<DunningCase[]> {
    return Promise.resolve(
      this.cases
        .filter((c) => c.state === "open" && c.playbook !== "wait_for_retry" && c.notificationId === null)
        .map((c) => structuredClone(c)),
    );
  }
}
