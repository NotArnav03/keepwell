# Keepwell demo video storyboard

Target runtime: **2:40** (under the 3-minute submission limit). Owner: Ayush. Record only against
the staging/prod-demo sandbox with fictional Pantry Plan data. Never show credentials, tokens,
subscriber email addresses, or real payment information.

| Time | Shot / narration | On-screen proof |
|---|---|---|
| 0:00–0:15 | The problem: cancellation and failed payments are moments when a subscriber needs a fair choice, not pressure. | Keepwell title and Pantry Plan context. |
| 0:15–0:40 | Start from the Pantry Plan subscriber experience; choose a reason and show the concise offer. Explain that the offer is policy-bounded. | Real sandbox widget, one offer card, policy version. |
| 0:40–1:00 | Decline the offer and cancel immediately. State that cancellation does not depend on AI. | Click Cancel now; show the result without a fabricated success state. |
| 1:00–1:30 | Switch to the merchant dashboard and show the subscriber/action update. | Status/action values loaded from the API; visibly label any simulated item. |
| 1:30–1:55 | Trace the action through its audit entry and verify the hash chain. | Audit entry, action ID, PayPal subscription ID, successful verify result. |
| 1:55–2:20 | Show the scheduler/timeline if a valid Bryntum licence has been confirmed; otherwise show the honest event list. | No trial-watermarked Bryntum assets in a public video. |
| 2:20–2:40 | Close on the product and truthful limitations. | Hosted demo URL and repo; mention sandbox/test data. |

## Recording checklist

- Have a teammate unfamiliar with the app perform the scenario once before recording.
- Use a clean browser profile, reset/lease a sandbox subscription, and confirm the sandbox API is
  awake before capture. Do not expose the lease token or dashboard secrets.
- Record the full flow in one take where possible; use cuts only to remove loading/wait time, never
  to imply an action succeeded when it did not.
- Capture at 1080p, add readable captions, keep text large, and keep the final edit below 3:00.
- Review the final video for personal data, secrets, simulated badges, and accurate PayPal status.
- Upload to the team's YouTube account and add the public URL to the Devpost entry. Upload/publishing
  is still pending team access and a real recording.
