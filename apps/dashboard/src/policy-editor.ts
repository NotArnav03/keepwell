import { PolicyDraft, type PolicyContext, type PolicyDraft as PolicyDraftType } from "@keepwell/contracts";
import { computeMenu } from "@keepwell/policy";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });

/** Parse merchant-edited JSON through the shared policy schema before preview or publish. */
export function parsePolicyDraft(source: string): PolicyDraftType {
  const value: unknown = JSON.parse(source);
  return PolicyDraft.parse(value);
}

/** Run the exact shared policy engine in-browser against server-provided fresh contexts. */
export function previewPolicyDraft(draft: PolicyDraftType, contexts: PolicyContext[]) {
  return contexts.map((context) => computeMenu({ ...draft, version: 1 }, context));
}

export function renderPolicyEditor(draft: PolicyDraftType): string {
  const serialized = escapeHtml(JSON.stringify(draft, null, 2));
  return `<form id="policy-editor"><h2>Retention policy</h2>
<label for="policy-document">Policy document (JSON)</label>
<textarea id="policy-document" name="document" rows="24" spellcheck="false" required>${serialized}</textarea>
<p>Dry-run is a preview only. Publishing creates a new immutable policy version.</p>
<button type="submit" name="intent" value="dry-run">Dry-run selected subscribers</button>
<button type="submit" name="intent" value="publish">Publish policy</button>
</form><section aria-live="polite" aria-label="Policy preview results" id="policy-preview"></section>`;
}
