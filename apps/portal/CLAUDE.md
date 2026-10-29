# apps/portal

**Owner: Aditya (M3 Surfaces).** Hosted cancel portal (magic-link login) and delegation management for subscriber AI agents.

Root `CLAUDE.md` rules apply. Rules specific to this package:

- Reuse `packages/widget` for the conversation; don't fork it.
- Magic-link requests always return 202, so there's no way to discover which accounts exist.
- Delegation tokens are shown once, stored hashed, scoped and revocable.
