// Lives inside the Shadow DOM, so the merchant's CSS can't reach it and it can't reach theirs.
// Contrast is at least 4.5:1 on every text colour; no motion at all, so reduced motion is free.
export const css = `
:host { all: initial; }
.kw-backdrop {
  position: fixed; inset: 0; z-index: 2147483000;
  background: rgb(15 23 42 / 0.45);
  display: flex; align-items: center; justify-content: center; padding: 16px;
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #0f172a;
}
.kw-dialog {
  background: #fff; border-radius: 12px; width: min(480px, 100%); max-height: 90vh;
  display: flex; flex-direction: column; box-shadow: 0 20px 50px rgb(0 0 0 / 0.25); overflow: hidden;
}
.kw-header {
  display: flex; justify-content: space-between; gap: 12px; align-items: flex-start;
  padding: 14px 16px; border-bottom: 1px solid #e2e8f0;
}
.kw-header h2 { margin: 0; font-size: 15px; font-weight: 600; }
.kw-plan { margin: 2px 0 0; color: #475569; font-size: 13px; }
.kw-header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
.kw-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.kw-log { display: flex; flex-direction: column; gap: 8px; }
.kw-line { margin: 0; padding: 8px 12px; border-radius: 10px; max-width: 85%; white-space: pre-wrap; }
.kw-agent { background: #f1f5f9; align-self: flex-start; }
.kw-subscriber { background: #dbeafe; align-self: flex-end; }
.kw-offer { border: 1px solid #93c5fd; background: #eff6ff; border-radius: 10px; padding: 12px; }
.kw-offer p { margin: 0 0 6px; }
.kw-offer-title { font-weight: 600; }
.kw-small { font-size: 13px; color: #475569; }
.kw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.kw-row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
.kw-row textarea { flex: 1; min-width: 0; font: inherit; padding: 8px; border: 1px solid #94a3b8; border-radius: 8px; resize: none; }
.kw-status, .kw-done { margin: 0; color: #1e3a8a; }
.kw-notice { margin: 0; padding: 10px 16px; background: #fef3c7; color: #78350f; font-size: 14px; }
button, .kw-cancel {
  font: inherit; font-size: 14px; padding: 7px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid #94a3b8; background: #fff; color: #0f172a; text-decoration: none;
}
button:disabled { opacity: 0.6; cursor: default; }
.kw-primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
.kw-cancel { border-color: #0f172a; font-weight: 600; }
.kw-close { border: none; font-size: 20px; line-height: 1; padding: 4px 8px; }
a { color: #1d4ed8; }
:focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
.kw-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;
