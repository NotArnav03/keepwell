# packages/widget

**Owner: Aditya (M3 Surfaces).** The embeddable Preact widget, rendered in Shadow DOM and installed with one script tag.

Root `CLAUDE.md` rules apply. Rules specific to this package:

- The **Cancel now** button never depends on the LLM, and in L2 mode not even on our API (show the PayPal autopay link).
- Bundle stays under 50 KB gzipped; check it in CI.
- Offer cards render from the structured `Offer`, never from model text.
- WCAG 2.2 AA: keyboard-only flow, focus trap, live region, reduced motion.
