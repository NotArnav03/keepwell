# apps/dashboard

**Owner: Ayush (M4 Cockpit).** Merchant dashboard: overview, live feed, subscribers, Bryntum timeline, audit log, policy editor, onboarding, Demo Inbox. Om builds the insights panels inside it.

Root `CLAUDE.md` rules apply. Rules specific to this package:

- Use `packages/ui` tokens and components; no one-off colours or spacing.
- All numbers shown come from the API (which gets them from SQL), never from model text.
- The policy editor's dry-run imports `packages/policy` directly. Never re-implement policy logic in the UI.
- Every agent action shown links to its audit entry and PayPal ID. Simulated items show a `SIMULATED` badge.
- Bryntum: check the licence terms (spike Q8) before shipping, and never commit a licence key.
