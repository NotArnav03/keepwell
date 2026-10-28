# apps/demo-store

**Owner: Aditya (M3 Surfaces).** "Pantry Plan", the fictional merchant site with the PayPal JS SDK subscribe button and the Keepwell widget installed. It's hosted on a different origin from the API on purpose.

Root `CLAUDE.md` rules apply. Rules specific to this package:

- Only the sandbox **client id** (public) may appear here, never a secret.
- Never grant access from `onApprove` alone: the server verifies the subscription with GET first.
- All people and data are fictional.
