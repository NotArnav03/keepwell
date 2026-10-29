# Keepwell

An honest AI retention agent for businesses that bill through **PayPal Subscriptions**. Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com).

When a subscriber goes to cancel, Keepwell has one short, honest conversation. If there's a fair fix (pause, cheaper plan, partial refund) that the merchant's policy allows, it applies it **to the real PayPal subscription**. Cancelling is always one click and never depends on the AI. The same platform recovers failed payments, wins back subscribers who cancelled inside PayPal, and turns exit conversations into actions the merchant can take.

> **Status: pre-build (28 Oct 2026).** This README is for the team. Om replaces it with the judge-facing version before submission.

## Team

| Member | GitHub | Workstream | Owns |
|---|---|---|---|
| Arnav | @NotArnav03 | M1 Rails | PayPal gateway, webhooks, action engine, reconciler, audit log, infra, judge pool |
| Ishan | @IshanGite | M2 Brain | Policy engine, agent runtime, claims checker, eval harness |
| Aditya | @inslot2525-ctrl | M3 Surfaces | Widget, sessions API, portal, Pantry Plan demo store, Judge Mode, MCP servers |
| Ayush | @Ayush32-creator | M4 Cockpit | Merchant dashboard, Bryntum timeline, policy editor, onboarding, video |
| Om | @OMEExZORO | M5 Growth | Failed-payment recovery, win-back, notifications, insights + copilot, write-up |

Work items are GitHub Issues labelled `owner:<name>`, grouped into milestones.

## Read first

1. [CLAUDE.md](CLAUDE.md): rules for everyone and every Claude Code session
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the system
3. [docs/CONTRACTS.md](docs/CONTRACTS.md): the shared types and APIs
4. [docs/TEAM-PLAN.md](docs/TEAM-PLAN.md): split, milestones, cut list, submission checklist

## Getting started

Needs Node 22.12+ (24 recommended, see `.node-version`).

```bash
git clone https://github.com/NotArnav03/keepwell.git
cd keepwell
git config core.hooksPath .githooks          # blocks pushes to main
corepack enable pnpm                         # pnpm version comes from package.json
pnpm install
cp .env.example .env                         # fill in yourself; PAYPAL_USE_MOCK=true works offline
git switch -c <your-name>/<topic> origin/main
```

If `corepack enable` fails with EPERM on Windows, run `corepack enable pnpm --install-directory "$HOME/.local/bin"` (any folder on your PATH works) or `npm i -g pnpm@10.34.7`.

| Command | What it does |
|---|---|
| `pnpm dev:api` | API on http://localhost:3000 with reload (`/healthz`, `/readyz`) |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Every package, through Turborepo (cached) |
| `pnpm check` | All three plus the Prettier check: what CI runs |
| `pnpm format` | Fix formatting |
| `pnpm --filter @keepwell/<pkg> <script>` | One package only |

Nothing gets pushed to `main` directly: branch → PR → checks pass → merge (squash).

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
