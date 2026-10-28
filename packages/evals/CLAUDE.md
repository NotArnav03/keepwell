# packages/evals

**Owner: Ishan (M2 Brain).** Red-team and quality eval harness, plus the data for the public scoreboard.

Root `CLAUDE.md` rules apply. Rules specific to this package:

- **Full runs cost real money**: run them only when the user asks. The PR subset is the default.
- Run against paypal-mock, never against the sandbox or `prod-demo`.
- Hard gates: 0 policy violations, and 1 click to cancel for personas who want to leave.
