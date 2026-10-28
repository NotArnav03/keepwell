# apps/judge

**Owner: Aditya (M3 Surfaces).** Judge Mode landing page: test credentials, three one-click scenarios, time machine, status.

Root `CLAUDE.md` rules apply. Rules specific to this package:

- It must work for a stranger with zero context, so test it with someone outside the team before freeze.
- Every simulated or time-shifted step is labelled `SIMULATED` or `TIME SHIFT`.
- If the pool is empty or the API is down, show the honest fallback path and the status, never a blank page.
