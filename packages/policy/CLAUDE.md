# packages/policy

**Owner: Ishan (M2 Brain).** The pure policy engine: `computeMenu`, `evaluate`, `explain`.

Root `CLAUDE.md` rules apply. Rules specific to this package:

- **Pure functions only**: no I/O, no clock reads (time is passed in), no randomness.
- Every rule has unit tests **and** a property test (fast-check). Branch coverage stays at 100%.
- Built-in PayPal constraints (the 10-day price rule, 1 offer per session, cancel intent → empty menu) are not configurable.
- Never weaken or delete a property test to make a change pass.
