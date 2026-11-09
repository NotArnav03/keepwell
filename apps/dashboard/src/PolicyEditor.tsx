import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PolicyDraft,
  type PolicyDraft as PolicyDraftType,
  type PolicyDryRunResponse,
  type PolicyVersionResponse,
} from "@keepwell/contracts";
import type { MerchantApi } from "./api.js";
import { OFFER_LABELS, summariseOffers } from "./fmt.js";
import { previewPolicyDraft, samePolicy, setIn } from "./policy-editor.js";
import { EmptyState, PageHeading, StatusBadge } from "./ui.js";

// The policy as a rulebook: each rule is a sentence with the limits written into it. Publishing
// makes a new immutable version; the one rule that can't be edited is that cancelling is one click.

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);

function Num({
  label,
  value,
  onChange,
  min = 0,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <input
      className="inline-field"
      type="number"
      aria-label={label}
      min={min}
      {...(max !== undefined && { max })}
      value={Number.isFinite(value) ? value : ""}
      disabled={disabled ?? false}
      style={{ width: `${Math.max(String(value).length, 2) + 2.2}ch` }}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    />
  );
}

function Clause({
  n,
  title,
  enabled,
  onToggle,
  children,
  detail,
}: {
  n: number;
  title: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <li className="clause" data-on={enabled}>
      <span className="clause-num" aria-hidden="true">
        §{n}
      </span>
      <div className="clause-body">
        <div className="clause-head">
          <h3>{title}</h3>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={enabled}
            aria-label={`${title}: ${enabled ? "offered" : "not offered"}`}
            onClick={() => onToggle(!enabled)}
          >
            <span>{enabled ? "Offered" : "Not offered"}</span>
          </button>
        </div>
        <p className="clause-text">{children}</p>
        {detail}
      </div>
    </li>
  );
}

export function PolicyEditor({ api: client }: { api: MerchantApi }) {
  const [stored, setStored] = useState<PolicyVersionResponse | null>(null);
  const [draft, setDraft] = useState<PolicyDraftType | null>(null);
  const [subscribers, setSubscribers] = useState<{ id: string; name: string; plan: string }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [changeNote, setChangeNote] = useState("");
  const [dryRun, setDryRun] = useState<PolicyDryRunResponse | null>(null);
  const [preview, setPreview] = useState<ReturnType<typeof previewPolicyDraft>>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    client
      .policies()
      .then(async (list) => {
        if (list.currentVersion === null) return;
        const version = await client.policy(list.currentVersion);
        if (!active) return;
        setStored(version);
        const { version: _version, ...policyDraft } = version.document;
        setDraft(PolicyDraft.parse(policyDraft));
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Policy unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    client
      .listSubscriptions({})
      .then((page) => {
        if (!active) return;
        const rows = page.subscriptions.map(({ subscription }) => ({
          id: subscription.id,
          name: subscription.subscriberFirstName ?? "Subscriber",
          plan: subscription.planName,
        }));
        setSubscribers(rows);
        setPicked(rows.slice(0, 3).map((row) => row.id));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client]);

  const live = useMemo(() => {
    if (!stored) return null;
    const { version: _version, ...rest } = stored.document;
    return rest;
  }, [stored]);
  const changed = draft !== null && live !== null && !samePolicy(draft, live);

  function edit(path: (string | number)[], value: unknown) {
    if (!draft) return;
    const parsed = PolicyDraft.safeParse(setIn(draft, path, value));
    if (!parsed.success) {
      setError("That value isn't allowed by the policy schema.");
      return;
    }
    setDraft(parsed.data);
    setDryRun(null);
    setPreview([]);
    setError("");
  }

  function editJson(path: (string | number)[], text: string) {
    try {
      edit(path, JSON.parse(text) as unknown);
    } catch {
      setError("That isn't valid JSON.");
    }
  }

  async function runDryRun() {
    setError("");
    setMessage("");
    try {
      if (!draft) throw new Error("A policy document is not loaded.");
      const result = await client.dryRun({ document: draft, sampleSubscriptionIds: picked });
      setDryRun(result);
      setPreview(
        previewPolicyDraft(
          draft,
          result.samples.map((sample) => sample.context),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Policy dry-run failed.");
    }
  }

  async function publish() {
    setError("");
    setMessage("");
    try {
      if (!draft) throw new Error("A policy document is not loaded.");
      const result = await client.publishPolicy({
        baseVersion: stored?.version ?? null,
        document: draft,
        ...(changeNote && { changeNote }),
      });
      setStored(result);
      setChangeNote("");
      setMessage(`Published as version ${result.version}. Earlier versions are unchanged.`);
      setDryRun(null);
      setPreview([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Policy could not be published.");
    }
  }

  if (loading) {
    return (
      <>
        <PageHeading title="Policies" />
        <p role="status">Loading the rulebook…</p>
      </>
    );
  }

  const d = draft;
  return (
    <>
      <PageHeading
        title="Policies"
        subtitle="The limits the assistant must obey, written as rules. It can offer less than this, never more."
        actions={stored && <StatusBadge tone="good">Live · version {stored.version}</StatusBadge>}
      />
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice notice-ok">
          {message}
        </p>
      )}
      {!d ? (
        <EmptyState title="No policy is published yet">Publish an initial policy before editing.</EmptyState>
      ) : (
        <div className="rulebook-layout">
          <section className="rulebook-wrap">
            <p className="clause clause-fixed">
              <span className="clause-num" aria-hidden="true">
                §0
              </span>
              <span className="clause-body">
                <span className="clause-head">
                  <span className="clause-title">Cancelling is always one click</span>
                  <StatusBadge tone="info">Fixed</StatusBadge>
                </span>
                <span className="clause-text">
                  Whatever is written below, a subscriber can always cancel in one click, with no questions
                  and no offer to refuse first. This rule is not editable.
                </span>
              </span>
            </p>
            <ol className="rulebook">
              <Clause
                n={1}
                title={OFFER_LABELS.pause ?? "Pause"}
                enabled={d.offers.pause.enabled}
                onToggle={(on) => edit(["offers", "pause", "enabled"], on)}
              >
                Offer a pause of up to{" "}
                <Num
                  label="Maximum pause, in billing cycles"
                  min={1}
                  max={12}
                  value={d.offers.pause.maxCycles}
                  disabled={!d.offers.pause.enabled}
                  onChange={(v) => edit(["offers", "pause", "maxCycles"], v)}
                />{" "}
                billing {plural(d.offers.pause.maxCycles, "cycle")}. The same subscriber isn&apos;t offered
                another for{" "}
                <Num
                  label="Days before another pause"
                  value={d.offers.pause.cooldownDays}
                  disabled={!d.offers.pause.enabled}
                  onChange={(v) => edit(["offers", "pause", "cooldownDays"], v)}
                />{" "}
                days.
              </Clause>
              <Clause
                n={2}
                title={OFFER_LABELS.discount ?? "Discount"}
                enabled={d.offers.discount.enabled}
                onToggle={(on) => edit(["offers", "discount", "enabled"], on)}
              >
                Offer up to{" "}
                <Num
                  label="Maximum discount, percent"
                  min={1}
                  max={100}
                  value={d.offers.discount.maxPercent}
                  disabled={!d.offers.discount.enabled}
                  onChange={(v) => edit(["offers", "discount", "maxPercent"], v)}
                />
                % off for up to{" "}
                <Num
                  label="Maximum discount, billing cycles"
                  min={1}
                  value={d.offers.discount.maxCycles}
                  disabled={!d.offers.discount.enabled}
                  onChange={(v) => edit(["offers", "discount", "maxCycles"], v)}
                />{" "}
                {plural(d.offers.discount.maxCycles, "cycle")}, and only to subscribers of at least{" "}
                <Num
                  label="Minimum subscriber tenure, days"
                  value={d.eligibility.minTenureDaysForDiscount}
                  disabled={!d.offers.discount.enabled}
                  onChange={(v) => edit(["eligibility", "minTenureDaysForDiscount"], v)}
                />{" "}
                days.
              </Clause>
              <Clause
                n={3}
                title={OFFER_LABELS.downgrade ?? "Cheaper plan"}
                enabled={d.offers.downgrade.enabled}
                onToggle={(on) => edit(["offers", "downgrade", "enabled"], on)}
                detail={
                  <details className="clause-detail">
                    <summary>Which plan leads to which (advanced)</summary>
                    <textarea
                      rows={5}
                      spellCheck={false}
                      aria-label="Downgrade targets as JSON"
                      value={JSON.stringify(d.offers.downgrade.targets, null, 2)}
                      onChange={(event) =>
                        editJson(["offers", "downgrade", "targets"], event.currentTarget.value)
                      }
                    />
                  </details>
                }
              >
                Offer a cheaper plan to subscribers on a plan that has one set below. Plan changes need the
                subscriber&apos;s own approval in PayPal.
              </Clause>
              <Clause
                n={4}
                title={OFFER_LABELS.switch_annual ?? "Annual billing"}
                enabled={d.offers.switch_annual.enabled}
                onToggle={(on) => edit(["offers", "switch_annual", "enabled"], on)}
                detail={
                  <details className="clause-detail">
                    <summary>Which monthly plan maps to which annual plan (advanced)</summary>
                    <textarea
                      rows={5}
                      spellCheck={false}
                      aria-label="Annual plan targets as JSON"
                      value={JSON.stringify(d.offers.switch_annual.targets, null, 2)}
                      onChange={(event) =>
                        editJson(["offers", "switch_annual", "targets"], event.currentTarget.value)
                      }
                    />
                  </details>
                }
              >
                Offer to move a monthly subscriber to annual billing, where an annual plan is set below.
              </Clause>
              <Clause
                n={5}
                title={OFFER_LABELS.refund_partial ?? "Partial refund"}
                enabled={d.offers.refund_partial.enabled}
                onToggle={(on) => edit(["offers", "refund_partial", "enabled"], on)}
              >
                Refund up to{" "}
                <Num
                  label="Maximum refund, percent of the last payment"
                  min={1}
                  max={100}
                  value={d.offers.refund_partial.maxPercentOfLastPayment}
                  disabled={!d.offers.refund_partial.enabled}
                  onChange={(v) => edit(["offers", "refund_partial", "maxPercentOfLastPayment"], v)}
                />
                % of the last payment, and no more than{" "}
                <input
                  className="inline-field"
                  aria-label="Monthly refund cap"
                  value={d.offers.refund_partial.maxPerMonth.value}
                  disabled={!d.offers.refund_partial.enabled}
                  style={{
                    width: `${Math.max(d.offers.refund_partial.maxPerMonth.value.length, 3) + 2.2}ch`,
                  }}
                  onChange={(event) =>
                    edit(["offers", "refund_partial", "maxPerMonth", "value"], event.currentTarget.value)
                  }
                />{" "}
                {d.offers.refund_partial.maxPerMonth.currency} in a month in total.
              </Clause>
              <li className="clause" data-on="true">
                <span className="clause-num" aria-hidden="true">
                  §6
                </span>
                <div className="clause-body">
                  <div className="clause-head">
                    <h3>How it speaks</h3>
                  </div>
                  <p className="clause-text">
                    Never offer the same subscriber more than{" "}
                    <Num
                      label="Maximum saves per subscriber in 365 days"
                      value={d.eligibility.maxSavesPerSubscriberPer365d}
                      onChange={(v) => edit(["eligibility", "maxSavesPerSubscriberPer365d"], v)}
                    />{" "}
                    {plural(d.eligibility.maxSavesPerSubscriberPer365d, "save")} in 365 days. Write in a{" "}
                    <select
                      className="inline-field"
                      aria-label="Tone"
                      value={d.tone}
                      onChange={(event) => edit(["tone"], event.currentTarget.value)}
                    >
                      <option value="warm">warm</option>
                      <option value="neutral">neutral</option>
                      <option value="brief">brief</option>
                    </select>{" "}
                    tone, and point subscribers to{" "}
                    <input
                      className="inline-field inline-wide"
                      aria-label="Support contact"
                      value={d.supportContact}
                      onChange={(event) => edit(["supportContact"], event.currentTarget.value)}
                    />
                    .
                  </p>
                  <details className="clause-detail">
                    <summary>Which offer to lead with for each reason (advanced)</summary>
                    <textarea
                      rows={7}
                      spellCheck={false}
                      aria-label="Reason preferences as JSON"
                      value={JSON.stringify(d.reasonPreferences, null, 2)}
                      onChange={(event) => editJson(["reasonPreferences"], event.currentTarget.value)}
                    />
                  </details>
                </div>
              </li>
            </ol>
          </section>

          <aside className="rulebook-side">
            <section className="panel">
              <h2>Try the rules</h2>
              <p className="muted">
                Pick subscribers and see, with the real policy engine running in your browser, what each would
                be offered under your draft.
              </p>
              <div className="toggles" role="group" aria-label="Subscribers to try the rules on">
                {subscribers.slice(0, 12).map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="toggle"
                    aria-pressed={picked.includes(row.id)}
                    onClick={() =>
                      setPicked((current) =>
                        current.includes(row.id)
                          ? current.filter((id) => id !== row.id)
                          : [...current, row.id],
                      )
                    }
                  >
                    {row.name}
                  </button>
                ))}
              </div>
              <div className="button-row">
                <button type="button" onClick={() => void runDryRun()} disabled={picked.length === 0}>
                  Run the rules
                </button>
              </div>
              {dryRun && (
                <div className="tryout">
                  {dryRun.problems.length > 0 && (
                    <p className="notice notice-error" role="alert">
                      {dryRun.problems.map((problem) => `${problem.path}: ${problem.message}`).join(" · ")}
                    </p>
                  )}
                  {preview.map((menu, index) => {
                    const sample = dryRun.samples[index];
                    return (
                      <article key={sample?.subscriptionId} className="tryout-row">
                        <h3>
                          {sample?.subscriberFirstName ?? "Subscriber"}{" "}
                          <span className="muted">· {sample?.planName}</span>
                        </h3>
                        <p>
                          {menu.offers.length
                            ? summariseOffers(menu.offers.map((offer) => offer.kind))
                            : "No offer. Cancel stays one click."}
                        </p>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="panel publish">
              <h2>Publish</h2>
              <p className="muted">
                {changed
                  ? "You have unpublished changes. Publishing makes a new version; the live one is never edited."
                  : "Nothing to publish: the draft matches the live version."}
              </p>
              <label>
                What changed, and why
                <input
                  value={changeNote}
                  onChange={(event) => setChangeNote(event.currentTarget.value)}
                  maxLength={280}
                  placeholder="Raised the discount cap for Black Friday"
                />
              </label>
              <button type="button" onClick={() => void publish()} disabled={!changed}>
                Publish as version {(stored?.version ?? 0) + 1}
              </button>
            </section>
          </aside>
        </div>
      )}
    </>
  );
}
