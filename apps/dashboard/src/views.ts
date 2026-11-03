import type {
  Action,
  AuditEntry,
  MerchantFeedEvent,
  MerchantSubscriptionDetailResponse,
  MerchantSubscriptionListResponse,
  MerchantTimelineResponse,
} from "@keepwell/contracts";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });

function simulatedBadge(simulated: boolean): string {
  return simulated ? '<span class="badge badge-warning">SIMULATED</span>' : "";
}

function money(value: { value: string; currency: string }): string {
  return `${value.value} ${value.currency}`;
}

/** Render a subscriber list from the merchant API response; no inferred/demo data is added. */
export function renderSubscribers(response: MerchantSubscriptionListResponse): string {
  const rows = response.subscriptions
    .map(
      ({ subscription, risk }) => `<tr>
<td><a href="#subscribers/${encodeURIComponent(subscription.id)}">${escapeHtml(subscription.subscriberFirstName ?? "Subscriber")}</a></td>
<td>${escapeHtml(subscription.planName)}</td>
<td>${escapeHtml(subscription.status)}</td>
<td>${risk ? `${escapeHtml(risk.band)} (${risk.score}/100)` : "Not scored"}</td>
<td>${escapeHtml(money(subscription.priceOverride ?? subscription.price))}</td>
<td><code>${escapeHtml(subscription.paypalSubscriptionId)}</code></td>
</tr>`,
    )
    .join("");
  const empty = response.subscriptions.length === 0;

  return `<section aria-labelledby="subscribers-heading"><h2 id="subscribers-heading">Subscribers</h2>
<table><caption>PayPal subscriptions managed by Keepwell</caption><thead><tr><th scope="col">Subscriber</th><th scope="col">Plan</th><th scope="col">Status</th><th scope="col">Risk</th><th scope="col">Price</th><th scope="col">PayPal subscription</th></tr></thead>
<tbody>${empty ? '<tr><td colspan="6">No subscribers match these filters.</td></tr>' : rows}</tbody></table>
${response.nextCursor ? `<a href="#subscribers?cursor=${encodeURIComponent(response.nextCursor)}">Next page</a>` : ""}</section>`;
}

/** Render subscription, session, and action details with audit and PayPal trace links. */
export function renderSubscriberDetail(detail: MerchantSubscriptionDetailResponse): string {
  const { subscription } = detail;
  const actions = detail.actions
    .map(
      (
        action,
      ) => `<li>${escapeHtml(action.type)} · ${escapeHtml(action.state)} ${simulatedBadge(action.simulated)}
<a href="#audit?subject=${encodeURIComponent(action.id)}">Audit entry</a>
<a href="#paypal/${encodeURIComponent(subscription.paypalSubscriptionId)}">PayPal ${escapeHtml(subscription.paypalSubscriptionId)}</a></li>`,
    )
    .join("");
  const sessions = detail.sessions
    .map(
      (session) =>
        `<li>${escapeHtml(session.channel)} · ${escapeHtml(session.state)} · ${escapeHtml(session.outcome ?? "in progress")} ${simulatedBadge(session.simulated)}</li>`,
    )
    .join("");

  return `<article aria-labelledby="subscriber-heading"><h2 id="subscriber-heading">${escapeHtml(subscription.subscriberFirstName ?? "Subscriber")}</h2>
<dl><dt>Plan</dt><dd>${escapeHtml(subscription.planName)}</dd><dt>Status</dt><dd>${escapeHtml(subscription.status)}</dd><dt>Price</dt><dd>${escapeHtml(money(subscription.priceOverride ?? subscription.price))}</dd><dt>PayPal subscription ID</dt><dd><code>${escapeHtml(subscription.paypalSubscriptionId)}</code></dd></dl>
<section><h3>Actions</h3><ul>${actions || "<li>No actions recorded.</li>"}</ul></section>
<section><h3>Retention sessions</h3><ul>${sessions || "<li>No sessions recorded.</li>"}</ul></section></article>`;
}

const auditExplanations: Record<string, string> = {
  "offer.presented": "A policy-approved retention offer was shown to the subscriber.",
  "session.offer_accepted": "The subscriber explicitly accepted the displayed offer.",
  "session.offer_declined": "The subscriber declined the displayed offer.",
  "session.closed": "The retention session ended.",
  "action.state_changed": "A PayPal action changed state; check its linked action and PayPal subscription.",
  "action.confirmed": "PayPal state confirmed that the requested action took effect.",
  "policy.published": "A merchant policy version was published.",
};

export function explainAuditEntry(entry: AuditEntry): string {
  const recorded = entry.payload.explanation;
  if (typeof recorded === "string" && recorded.trim()) return recorded;
  if (Array.isArray(recorded) && recorded.every((item): item is string => typeof item === "string")) {
    const explanation = recorded.filter((item) => item.trim()).join(" ");
    if (explanation) return explanation;
  }
  return auditExplanations[entry.kind] ?? `Recorded event: ${entry.kind}.`;
}

/** Render the hash-chain entries supplied by the merchant API. Payload is deliberately not dumped. */
export function renderAuditExplorer(entries: AuditEntry[]): string {
  if (entries.length === 0)
    return '<section aria-labelledby="audit-heading"><h2 id="audit-heading">Audit log</h2><p>No audit entries found.</p></section>';

  const rows = entries
    .map((entry) => {
      const subjectLinks = Object.entries(entry.subjectIds)
        .map(
          ([kind, id]) =>
            `<a href="#audit?subject=${encodeURIComponent(id)}">${escapeHtml(kind)} ${escapeHtml(id)}</a>`,
        )
        .join(" · ");
      return `<li><article><h3>${escapeHtml(entry.kind)} ${simulatedBadge(entry.simulated)}</h3>
<time datetime="${escapeHtml(entry.at)}">${escapeHtml(entry.at)}</time><p>${escapeHtml(explainAuditEntry(entry))}</p>
<p>${subjectLinks || "No linked subjects"}</p><details><summary>Chain proof</summary><dl><dt>Sequence</dt><dd>${entry.seq}</dd><dt>Previous hash</dt><dd><code>${escapeHtml(entry.prevHash)}</code></dd><dt>Hash</dt><dd><code>${escapeHtml(entry.hash)}</code></dd></dl></details></article></li>`;
    })
    .join("");

  return `<section aria-labelledby="audit-heading"><h2 id="audit-heading">Audit log</h2><ol>${rows}</ol></section>`;
}

/** The feed shows only typed event metadata; it never renders arbitrary event payloads. */
export function renderLiveFeed(events: MerchantFeedEvent[]): string {
  if (events.length === 0) {
    return '<section aria-labelledby="live-feed-heading"><h2 id="live-feed-heading">Live activity</h2><p>Waiting for activity.</p></section>';
  }
  const items = events
    .map(
      (event) => `<li><time datetime="${escapeHtml(event.occurredAt)}">${escapeHtml(event.occurredAt)}</time>
<strong>${escapeHtml(event.type)}</strong> ${simulatedBadge(event.simulated)}
<a href="#audit?event=${encodeURIComponent(event.id)}">View audit trail</a></li>`,
    )
    .join("");
  return `<section aria-labelledby="live-feed-heading"><h2 id="live-feed-heading">Live activity</h2><ol aria-live="polite">${items}</ol></section>`;
}

/** A vendor-neutral fallback until Bryntum licensing is confirmed. */
export function renderTimelineFallback(timeline: MerchantTimelineResponse): string {
  const resourceNames = new Map(timeline.resources.map((resource) => [resource.id, resource.name]));
  const events = [...timeline.events]
    .sort((left, right) => left.startDate.localeCompare(right.startDate))
    .map(
      (
        event,
      ) => `<li>${escapeHtml(event.startDate)} · ${escapeHtml(resourceNames.get(event.resourceId) ?? "Subscriber")} · ${escapeHtml(event.name)} (${escapeHtml(event.kind)}) ${simulatedBadge(event.simulated)}
${event.auditSeq === null ? "" : `<a href="#audit?seq=${event.auditSeq}">Audit #${event.auditSeq}</a>`}
<a href="#paypal/${encodeURIComponent(event.paypalSubscriptionId)}">PayPal ${escapeHtml(event.paypalSubscriptionId)}</a></li>`,
    )
    .join("");

  return `<section aria-labelledby="timeline-heading"><h2 id="timeline-heading">Subscriber timeline</h2><p>Event list fallback; the licensed Scheduler view is not enabled.</p><ol>${events || "<li>No events in this time range.</li>"}</ol></section>`;
}

/** Keep rendering decisions for action badges tied to the shared Action contract. */
export function actionIsSimulated(action: Action): boolean {
  return action.simulated;
}
