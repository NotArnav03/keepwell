# packages/contracts

**Owner: everyone (shared).** Zod schemas, API types, domain events and job names from docs/CONTRACTS.md.

Root `CLAUDE.md` rules apply. Rules specific to this package:

- **Changes need a PR labelled `contract-change` and approval from two owners**, with the affected owners tagged.
- Additive changes (new optional field, new event) are fine. Renames and removals need all affected owners to agree.
- No runtime logic here besides schemas and tiny helpers. No I/O.
