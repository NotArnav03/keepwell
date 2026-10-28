# Keepwell: rules for Claude Code

Keepwell is a five-person entry for the PayPal AI Hackathon: an honest AI retention agent for businesses that bill through PayPal Subscriptions. Every teammate works with Claude Code, so these rules apply to every session in this repo.

**Read before writing code:**
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the system and the ten design laws
- [docs/CONTRACTS.md](docs/CONTRACTS.md): the shared types and APIs
- [docs/TEAM-PLAN.md](docs/TEAM-PLAN.md): who owns what, and the dates

## 0. Know whose work you're doing

| Member | Workstream | Branch prefix | Owns (details in ARCHITECTURE.md §5) |
|---|---|---|---|
| Arnav | M1 Rails | `arnav/` | PayPal gateway, webhooks, actions, reconciler, audit, jobs, db, paypal-mock, pool, infra/CI |
| Ishan | M2 Brain | `ishan/` | `packages/policy`, agent runtime, claims checker, LLM budget, `packages/evals` |
| Aditya | M3 Surfaces | `aditya/` | `packages/widget`, sessions API, portal, demo store, Judge Mode, MCP servers |
| Ayush | M4 Cockpit | `ayush/` | `apps/dashboard`, `packages/ui`, merchant APIs, onboarding, Bryntum timeline |
| Om | M5 Growth | `om/` | recovery, win-back, notifications, insights, copilot, insight-to-action |

- Work out whose session this is from the branch prefix. If you can't tell (for example on a fresh clone), ask the user which member they are before editing.
- Stay inside that workstream's packages and modules (ownership is listed in ARCHITECTURE.md §5).
- If a change is needed in another member's package, stop and tell the user. Don't make it quietly.

## 1. Hard rules (never break these)

1. **Never commit, merge or push to `main`** (or `master`). Push only your own feature branch (`<your-name>/<topic>`).
2. **Never force-push.** The one exception: `--force-with-lease` on your own feature branch after a rebase, and only after telling the user.
3. **Never skip hooks or checks**: no `--no-verify`, no disabling CI steps, no `.skip`/`.only` left in tests.
4. **Never merge pull requests** (`gh pr merge`). A human merges after review.
5. **Never commit or print secrets.** `.env` files are never committed and never read into the conversation. Credentials never go into code, tests, fixtures, logs, docs, commit messages or PR text. Use `.env.example` to learn the variable names.
6. **Sandbox only.** Only `api-m.sandbox.paypal.com` and sandbox credentials. Never live PayPal (`api-m.paypal.com`).
7. **No infrastructure changes.** Don't deploy, and don't change Render, Neon, DNS, GitHub repo settings, branch protection or the `prod-demo` environment. That's M1's job, done by hand.
8. **Ask before anything destructive**: `git reset --hard`, `git clean`, `git branch -D`, `git stash drop/clear`, `git checkout -- .`, `git restore .`, deleting files you didn't create, dropping database tables. Never rewrite history that has been pushed.
9. **`packages/contracts` changes** need a PR labelled `contract-change` and two owners' approval (CONTRACTS.md). Never change a contract silently to make your code compile.
10. **Freeze dates (IST):**
    - **Feature freeze 8 Nov 23:59.** After it, only bug fixes and polish.
    - **Submission 12 Nov 20:00.** After it, **no code changes** to the submitted project. Ops only: restarts and pool refills.

The hook in `.claude/hooks/guard-git.mjs` enforces the git rules, and `.claude/settings.json` adds deny and ask rules. If one of them blocks you, tell the user. Never try to get around it with other commands, env vars or scripts.

## 2. Git workflow

```bash
git fetch origin
git switch -c aditya/widget-sse origin/main  # branch: <your-name>/<kebab-topic>
# ...work, small commits...
git pull --rebase origin main               # stay current; resolve conflicts; re-run checks
git push -u origin aditya/widget-sse         # only ever your own branch
gh pr create --base main --fill             # then complete the PR template
```

- **Branch names:** `<your-name>/<topic>`, e.g. `arnav/action-engine`, `om/fix-dunning-timing`. One topic per branch, short-lived (aim to merge within 1–2 days).
- **Commits:** Conventional Commits, scoped by package or module: `feat(widget): stream agent replies over SSE`, `fix(actions): read-before-retry on suspend timeout`. Types: `feat fix refactor test docs chore perf ci`. One logical change per commit. The message explains *why* when it isn't obvious.
- **PRs:** under about 400 changed lines; draft PRs early are welcome. The description has:
  - **What:** the change
  - **Why:** the reason for it
  - **How it was tested:** commands and results
  - **Screenshots:** for UI changes
  - **Contract changes:** yes/no
  - **Risk and rollback**
- Rebase on `origin/main` before asking for review. CODEOWNERS decides the reviewer. Link the GitHub Issue (`Closes #12`); every work item is an issue labelled `owner:<name>`.
- Local `main` is read-only. Only `git pull` on it, never commit.

## 3. Architecture rules that show up in code

These come from the ten design laws (ARCHITECTURE.md §2). Breaking one fails review.

- **PayPal calls go only through the gateway** (`apps/api/src/modules/paypal`). **Every PayPal mutation is an Action** through the ActionEngine, never a direct call.
- **The cancel path never touches the LLM**: no model call, no agent step, nothing that can fail because of AI.
- **LLM calls go only through the agent module's client** (budget guard, logging, fallbacks). Don't import `@anthropic-ai/sdk` anywhere else. Models: `claude-sonnet-5-5` (conversation, copilot) and `claude-haiku-5-5` (classify, tag, check).
- **Offer terms render from `Offer` objects.** Model text never contains prices, dates or durations that the claims checker hasn't verified.
- **The AI picks from the policy's menu, and the policy re-checks the pick.** Subscriber consent is a button click, never parsed from text.
- **Webhooks are hints.** Re-GET the subscription and diff it. Never trust the event body as state.
- **Every side effect writes an audit entry.** Every database query is scoped by `merchant_id` through the scoped helper.
- **Simulated anything** (simulated events, time-machine shifts) is flagged `simulated: true` and shown as `SIMULATED` in the UI.
- **Money:** `{ value: "12.00", currency: "USD" }` decimal strings, never floats. Times are ISO-8601 UTC. Our IDs are UUIDv7.
- **zod at every boundary** (HTTP, jobs, webhooks, LLM output, env). Import types from `packages/contracts`; never redefine them locally.

## 4. Code conventions

- TypeScript `strict`. No `any` (use `unknown` + zod). No `@ts-ignore`. A non-null `!` needs a comment saying why it's safe.
- Logging with pino and the context ids (`requestId`, `merchantId`, `subscriptionId`, `actionId`, `paypalDebugId`). No `console.log` in committed code.
- Never swallow errors. Every `catch` handles the error deliberately or rethrows. API errors use the shared error envelope.
- Match the surrounding code's style, naming and comment density. Comments explain *why*, not *what*.
- **Cross-platform:** the team uses Windows, macOS and Linux.
  - `package.json` scripts must run on all three, so write Node scripts rather than bash-only ones.
  - Use LF line endings.
  - Don't hard-code paths.
- **Dependencies:** ask the user before adding one. Prefer the libraries already chosen in ARCHITECTURE.md §5. Pin exact versions. Avoid unknown packages with install scripts.
- Keep new modules close to the shapes in CONTRACTS.md §5 (interfaces first, so others can fake them).

## 5. Tests and "done"

- New behaviour comes with tests. A bug fix starts with a failing regression test.
- **Never delete, skip or weaken a test to get CI green.** Never lower `packages/policy` coverage or remove its property tests.
- Unit tests **never call real PayPal or the Anthropic API**: use `packages/paypal-mock` and the fake LLM. Real calls belong only in sandbox end-to-end tests and evals, run on purpose.
- Before saying something is done:
  1. Run `pnpm typecheck`, `pnpm lint` and `pnpm test` for the packages you touched, and report the actual results. If something fails, say so and show the output.
  2. If the change touches PayPal behaviour, its paypal-mock tests must pass. Say whether it was also checked on sandbox.
  3. Failure behaviour must match the failure-mode matrix (ARCHITECTURE.md §9).
  4. If the change alters architecture or a contract, update the doc in the same PR (ADRs go in `docs/adr/`).
- End each task with a short summary: what changed, how it was verified, and what's left or uncertain.

## 6. Cost and outside services

- **The Anthropic API costs real money.** Don't run the full eval suite or long LLM loops unless the user asks; the PR-sized eval subset is fine.
- Don't hammer the PayPal sandbox: no loops creating plans, products or subscriptions. Only `tools/pool-refill` (run by M1) creates subscriptions in bulk.
- Don't sign up for services, create accounts, or enter credentials anywhere on anyone's behalf.

## 7. Data and privacy

- Only sandbox and fictional data: Pantry Plan, Maya, Raj and so on. No real people's names, emails or payment details anywhere, including teammates'.
- Don't send repo contents, logs or data to outside services beyond the ones the architecture uses.

## 8. When in doubt

- Ask the user rather than guess when a task is ambiguous, touches another workstream, or would change a contract or a design law.
- If you find a problem outside your task, mention it. Don't fix it on the side.

## One-time setup per clone

```bash
git config core.hooksPath .githooks   # installs the pre-push guard for humans and tools alike
```

Copy `.env.example` to `.env` and fill it in yourself. Claude never sees the values.
