# Keepwell

An honest AI retention agent for businesses that bill through **PayPal Subscriptions**. Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com).

When a subscriber goes to cancel, Keepwell has one short, honest conversation. If there's a fair fix (pause, cheaper plan, partial refund) that the merchant's policy allows, it applies it **to the real PayPal subscription**. Cancelling is always one click and never depends on the AI. The same platform recovers failed payments, wins back subscribers who cancelled inside PayPal, and turns exit conversations into actions the merchant can take.

> **Status: pre-build (28 Oct 2026).** This README is for the team. Om replaces it with the judge-facing version before submission.

## Team

| Member | Workstream | Owns |
|---|---|---|
| Arnav | M1 Rails | PayPal gateway, webhooks, action engine, reconciler, audit log, infra, judge pool |
| Ishan | M2 Brain | Policy engine, agent runtime, claims checker, eval harness |
| Aditya | M3 Surfaces | Widget, sessions API, portal, Pantry Plan demo store, Judge Mode, MCP servers |
| Ayush | M4 Cockpit | Merchant dashboard, Bryntum timeline, policy editor, onboarding, video |
| Om | M5 Growth | Failed-payment recovery, win-back, notifications, insights + copilot, write-up |

Work items are GitHub Issues labelled `owner:<name>`, grouped into milestones.

## Read first

1. [CLAUDE.md](CLAUDE.md): rules for everyone and every Claude Code session
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the system
3. [docs/CONTRACTS.md](docs/CONTRACTS.md): the shared types and APIs
4. [docs/TEAM-PLAN.md](docs/TEAM-PLAN.md): split, milestones, cut list, submission checklist

## Getting started

```bash
git clone https://github.com/NotArnav03/keepwell.git
cd keepwell
git config core.hooksPath .githooks          # blocks pushes to main
git switch -c <your-name>/<topic> origin/main
```

Nothing gets pushed to `main` directly: branch → PR → checks pass → merge (squash). Arnav scaffolds the toolchain (pnpm, Turborepo, CI) in the first issue of the "Contracts frozen" milestone.

## Key dates (IST)

| Date | Milestone |
|---|---|
| 29 Oct | Contracts v1 frozen |
| 2 Nov | Walking skeleton on staging |
| 5 Nov | All three moments end to end |
| 8 Nov, 23:59 | Feature freeze |
| 12 Nov, 20:00 | **Submitted** (real deadline 13 Nov, 01:30) |

## License

MIT
