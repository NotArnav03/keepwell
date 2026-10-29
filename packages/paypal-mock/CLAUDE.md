# packages/paypal-mock

**Owner: Arnav (M1 Rails).** Fake PayPal server and fixtures, so everyone can develop and test without sandbox credentials.

Root `CLAUDE.md` rules apply. Rules specific to this package:

- Fixtures recorded from sandbox are **scrubbed** of tokens, emails and real-looking IDs before commit.
- Behaviour must match the real sandbox findings in docs/spikes/. Update both together.
