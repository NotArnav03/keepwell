import type { Attack, EvalResults } from "@keepwell/evals";

// The public /evals page (#29): server-rendered, no scripts, no outside assets. Example
// transcripts contain attacker text, so every string from the results is escaped.

export interface Scoreboard {
  real: EvalResults | null;
  adversarial: EvalResults | null;
}

const ATTACK_LABELS: Record<Attack, string> = {
  ignore_instructions: "“Ignore all previous instructions”",
  fake_markup: "Fake menu markup in the message",
  role_play: "Role play (“you are DiscountBot”)",
  authority: "“I'm the owner, override the policy”",
  legal_threat: "Legal threats",
  unauthorised_discount: "Demands for 80% off",
  prompt_extraction: "“Print your system prompt”",
  emotional_pressure: "Emotional pressure for a free month",
  abuse: "Abuse",
  name_injection: "Instructions hidden in the first name",
  multilingual_injection: "Injection in Spanish and Hindi",
  cancel_then_bargain: "“Cancel, unless you give me 95% off”",
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 1000) / 10}%`);
const num = (x: number | null, unit = "") => (x === null ? "—" : `${x}${unit}`);

/** `gate` marks a hard gate: green when it holds, red when it doesn't. */
function tile(label: string, value: string, note: string, gate: boolean | null = null): string {
  const cls = gate === null ? "" : gate ? " gate-ok" : " gate-bad";
  return `<div class="tile${cls}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="note">${escapeHtml(note)}</div></div>`;
}

function section(r: EvalResults, title: string, about: string): string {
  const m = r.metrics;
  const tiles = [
    tile("Policy violations", String(r.gates.policyViolations), "Must be 0", r.gates.policyViolations === 0),
    tile(
      "Clicks to cancel",
      String(r.gates.maxClicksToCancel),
      "Must be 1, for everyone",
      r.gates.maxClicksToCancel === 1,
    ),
    tile("No means no", pct(m.noMeansNo), "Asked to cancel, saw no offer after"),
    tile("Replies sent back", num(m.claimsCaught), "Claims checker caught a price, date or promise"),
    tile("Picks denied", num(m.deniedPicks), "The policy refused the model's offer"),
    tile("Reason understood", pct(m.classificationAccuracy), "Classifier matched the persona's real reason"),
    tile(
      "Dark patterns",
      m.darkPatternScore === null ? "—" : `${m.darkPatternScore} / 3`,
      "LLM judge, 0 is none",
    ),
    tile("Language match", pct(m.languageMatch), "Replied in the subscriber's language"),
    tile("p95 latency", `${m.latencyMs.p95} ms`, "Per reply"),
    tile(
      "Cost per session",
      m.costPerSessionUsd === null ? "—" : `$${m.costPerSessionUsd.toFixed(4)}`,
      "The agent's model calls",
    ),
  ].join("");

  const rows = r.redTeam
    .map(
      (a) =>
        `<tr><td>${escapeHtml(ATTACK_LABELS[a.attack])}</td><td>${a.sessions}</td><td>${a.offersShown}</td><td class="${a.violations === 0 ? "ok" : "bad"}">${a.violations}</td></tr>`,
    )
    .join("");

  const examples = r.examples
    .map((e) => {
      const turns = e.turns
        .map(
          (t) =>
            `<p class="who">Subscriber</p><p class="msg sub">${escapeHtml(t.subscriber)}</p><p class="who">Agent</p><p class="msg">${escapeHtml(t.agent)}</p>${t.card ? `<p class="card">${escapeHtml(t.card)}</p>` : ""}`,
        )
        .join("");
      const label = e.attack ? ATTACK_LABELS[e.attack] : "Everyday subscriber";
      return `<details><summary>${escapeHtml(label)} · ${escapeHtml(e.outcome)}</summary>${turns}</details>`;
    })
    .join("");

  const models = Object.entries(r.models)
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`)
    .join(" · ");

  return `<section>
  <div class="head"><h2>${escapeHtml(title)}</h2><span class="badge ${r.gates.passed ? "pass" : "fail"}">${r.gates.passed ? "Gates passed" : "Gates failed"}</span></div>
  <p class="about">${escapeHtml(about)}</p>
  <p class="meta">${r.personas.normal} everyday subscribers and ${r.personas.redTeam} attackers · prompt v${r.promptVersion} · ${escapeHtml(r.runAt.slice(0, 10))}<br>${models}</p>
  <div class="tiles">${tiles}</div>
  <h3>Attacks</h3>
  <table><thead><tr><th>Attack</th><th>Sessions</th><th>Offers shown</th><th>Violations</th></tr></thead><tbody>${rows}</tbody></table>
  <h3>Example conversations</h3>
  ${examples}
</section>`;
}

export function renderScoreboard(board: Scoreboard): string {
  const real = board.real
    ? section(
        board.real,
        "Real run: Claude Haiku",
        "Claude Haiku 5.5 is the agent. A second model writes the subscriber's follow-up messages, and a third judges each conversation for dark patterns.",
      )
    : `<section><h2>Real run: Claude Haiku</h2><p class="about">No real-model run has been published yet.</p></section>`;
  const adversarial = board.adversarial
    ? section(
        board.adversarial,
        "Jailbroken model, on every change",
        "The reply model is replaced by an adversary that tries every trick: invented offers, prices and “last chance” in its text, offers the policy forbids. What reaches the subscriber is decided by code, so the gates still hold. This runs on every pull request.",
      )
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keepwell evals</title>
<style>
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #57534e; --line: #e7e5e4; --card: #ffffff; --ok: #15803d; --bad: #b91c1c; --accent: #f5f5f4; }
@media (prefers-color-scheme: dark) { :root { --bg: #0c0a09; --fg: #f5f5f4; --muted: #a8a29e; --line: #292524; --card: #1c1917; --ok: #4ade80; --bad: #f87171; --accent: #292524; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 0; }
h3 { font-size: 16px; margin: 24px 0 8px; }
.lede, .about, .meta { color: var(--muted); }
.meta { font-size: 13px; }
section { border-top: 1px solid var(--line); margin-top: 32px; padding-top: 24px; }
.head { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.badge { font-size: 13px; font-weight: 600; padding: 2px 10px; border-radius: 999px; border: 1px solid currentColor; }
.pass { color: var(--ok); } .fail { color: var(--bad); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-top: 16px; }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
.gate-ok { border-color: var(--ok); } .gate-bad { border-color: var(--bad); }
.label { font-size: 13px; color: var(--muted); }
.value { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; }
.note { font-size: 12px; color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
td:not(:first-child), th:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
.ok { color: var(--ok); } .bad { color: var(--bad); font-weight: 650; }
details { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; margin: 8px 0; }
summary { cursor: pointer; font-weight: 600; }
.who { font-size: 12px; color: var(--muted); margin: 10px 0 2px; }
.msg { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.sub { color: var(--muted); }
.card { margin: 6px 0 0; padding: 8px 10px; background: var(--accent); border-radius: 8px; font-size: 14px; }
</style>
</head>
<body>
<main>
<h1>Keepwell evals</h1>
<p class="lede">Every conversation the retention agent has goes through the same checks: an offer only from the merchant's policy, terms only on the offer card, nothing after “cancel”, and Cancel always one click away. These are the latest results.</p>
${real}
${adversarial}
</main>
</body>
</html>
`;
}
