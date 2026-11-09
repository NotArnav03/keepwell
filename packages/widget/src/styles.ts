// Lives inside the Shadow DOM, so the merchant's CSS can't reach it and it can't reach theirs.
// The look is the Keepwell ledger (paper, ink, a navy cloth header with gold foil, the offer drawn as a
// receipt), in PayPal's colours. Text contrast is at least 4.5:1 in both schemes; no motion at all, so
// reduced motion is free. Fonts are the merchant page's if it loads them (Newsreader, IBM Plex),
// else good system faces.
export const css = `
:host {
  all: initial;
  --paper: #fffdf9; --sunken: #f0ece3; --rule: #cec7b7; --hair: #e4dfd3;
  --ink: #1b1d22; --ink2: #4d5059; --blue: #005ea6; --blue-hover: #003087; --on-blue: #ffffff;
  --blue-soft: #e7f0fa; --cloth: #003087; --cloth-deep: #00205c; --cloth-text: #eef3fb; --gold: #ffc439;
  --warn-bg: #fbf3e2; --warn: #7d4806; --grain: rgb(255 255 255 / 0);
  --serif: "Newsreader", ui-serif, "Iowan Old Style", Georgia, serif;
  --sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :host {
    --paper: #1c1916; --sunken: #13110f; --rule: #40382f; --hair: #2d2823;
    --ink: #eee8dc; --ink2: #b5ac9e; --blue: #7fb6e8; --blue-hover: #a4cbf0; --on-blue: #0a1f38;
    --blue-soft: #14263b; --cloth: #00184a; --cloth-deep: #000f33; --cloth-text: #dde7f7; --gold: #f0b83a;
    --warn-bg: #2a1f0e; --warn: #f0bd62;
  }
}
.kw-backdrop {
  position: fixed; inset: 0; z-index: 2147483000;
  background: rgb(0 14 45 / 0.55);
  display: flex; align-items: center; justify-content: center; padding: 16px;
  font: 15px/1.5 var(--sans); color: var(--ink);
}
/* In the hosted portal the widget is the page, not a layer over it. */
.kw-page.kw-backdrop { position: static; z-index: auto; background: none; padding: 0; display: block; }
.kw-page .kw-dialog { width: min(640px, 100%); max-height: none; box-shadow: none; border: 1px solid var(--rule); margin: 0 auto; }
.kw-dialog {
  background: var(--paper); border-radius: 6px; width: min(480px, 100%); max-height: 90vh;
  display: flex; flex-direction: column; box-shadow: 0 24px 60px rgb(0 10 40 / 0.4); overflow: hidden;
  border: 1px solid var(--rule);
}
/* the header is cloth: navy with gold-foil lettering and a stitched thread along its edge */
.kw-header {
  position: relative; display: flex; justify-content: space-between; gap: 12px; align-items: flex-start;
  padding: 14px 16px 16px; background-color: var(--cloth); color: var(--cloth-text);
  background-image:
    repeating-linear-gradient(0deg, rgb(255 255 255 / 0.028) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(90deg, rgb(0 0 0 / 0.07) 0 1px, transparent 1px 3px);
}
.kw-header::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 5px; border-bottom: 1.5px dashed rgb(255 196 57 / 0.4);
}
.kw-header h2 { margin: 0; font: 600 18px/1.2 var(--serif); color: var(--gold); text-shadow: 0 1px 0 rgb(0 0 0 / 0.35); }
.kw-plan { margin: 3px 0 0; color: var(--cloth-text); opacity: 0.8; font-size: 13px; font-family: var(--mono); }
.kw-header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
.kw-body { padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; background: var(--paper); }
.kw-log { display: flex; flex-direction: column; gap: 8px; }
.kw-line { margin: 0; padding: 8px 12px; max-width: 88%; white-space: pre-wrap; }
.kw-agent { background: var(--sunken); align-self: flex-start; border-left: 3px solid var(--rule); border-radius: 0 8px 8px 0; }
.kw-subscriber { background: var(--blue-soft); align-self: flex-end; border-right: 3px solid var(--blue); border-radius: 8px 0 0 8px; }
/* an offer is a receipt: dashed edge, serif title, the terms in full */
.kw-offer { border: 1.5px dashed var(--rule); background: var(--paper); border-radius: 4px; padding: 14px; position: relative; }
.kw-offer::before {
  content: ""; position: absolute; top: -1.5px; left: 12px; width: 44px; height: 3px; background: var(--gold);
}
.kw-offer p { margin: 0 0 8px; }
.kw-offer-title { font: 600 18px/1.25 var(--serif); }
.kw-small { font-size: 13px; color: var(--ink2); }
.kw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.kw-row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
.kw-row textarea { flex: 1; min-width: 0; font: inherit; padding: 8px; border: 1px solid var(--rule); border-radius: 5px; resize: none; background: var(--paper); color: var(--ink); }
.kw-status, .kw-done { margin: 0; color: var(--blue); font-weight: 500; }
.kw-notice { margin: 0; padding: 10px 16px; background: var(--warn-bg); color: var(--warn); font-size: 14px; border-top: 1px solid var(--rule); }
button, .kw-cancel {
  font: inherit; font-size: 14px; font-weight: 600; padding: 7px 13px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--rule); background: var(--paper); color: var(--ink); text-decoration: none;
}
button:hover:not(:disabled) { background: var(--sunken); }
button[aria-pressed="true"] { background: var(--blue-soft); border-color: var(--blue); color: var(--blue); }
button:disabled { opacity: 0.6; cursor: default; }
.kw-primary { background: var(--blue); border-color: var(--blue); color: var(--on-blue); }
.kw-primary:hover:not(:disabled) { background: var(--blue-hover); border-color: var(--blue-hover); }
/* cancelling is always there, and always plainly a button: cream on the cloth */
.kw-cancel { background: var(--cloth-text); border-color: var(--cloth-text); color: var(--cloth); }
.kw-cancel:hover { background: #ffffff; }
.kw-close { border: none; background: transparent; color: var(--cloth-text); font-size: 22px; line-height: 1; padding: 2px 8px; }
.kw-close:hover:not(:disabled) { background: rgb(255 255 255 / 0.12); }
a { color: var(--blue); }
:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
.kw-body :focus-visible, .kw-row :focus-visible { outline-color: var(--blue); }
.kw-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;
