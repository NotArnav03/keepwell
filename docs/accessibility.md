# Accessibility (WCAG 2.2 AA)

Checked as of 2026-11-04 for the **widget** (`packages/widget`). The portal and Judge Mode are not built
yet (#38, #39); they reuse the widget's components and must be added to the table below when they exist.

## What is automated

`packages/widget/src/a11y.test.tsx` runs axe-core (tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`,
`wcag22aa`, `best-practice`) over every screen: first screen, conversation with reason chips, offer card,
waiting for PayPal, cancelled, API unreachable (L2 shell), and with the voice button. It also tests the
behaviour axe can't see: focus never falls out of the dialog, notices are announced, the offer card is a
labelled group, new-tab links say so, and voice input starts only on a press and stops on its own.

It runs in happy-dom, which has no layout, so colour contrast is off there. We chose not to add Playwright:
it needs a browser download in CI for one widget, and the pool spike (Q10) already decided against it.

## Recorded pass (real Chrome, fake sessions API)

| Check                                                                                            | Result                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| axe-core 4.14 with colour contrast, first screen, L1 chips, offer, waiting for PayPal, cancelled | 0 violations                                                                                           |
| axe "needs review"                                                                               | `label-content-name-mismatch` on the close button (glyph × vs "Close"); the glyph is now `aria-hidden` |
| Focus trap with real keys (Shift+Tab from the dialog wraps to the last control)                  | pass                                                                                                   |
| Focus after Accept removes the focused button                                                    | lands on the dialog, not the page behind                                                               |
| Reduced motion                                                                                   | the widget has no animation or transitions                                                             |

## Not done

- **Screen-reader pass.** No screen reader was driven (NVDA/VoiceOver). The structure it relies on is
  tested: `role="dialog"` with `aria-modal` and a label, `role="log"` (polite) for the conversation,
  `role="status"` for progress and `role="alert"` for failures. Someone should do a 10-minute NVDA run
  before the demo and record it here.
- **Voice input in a real recording.** Pressing Speak asks for the microphone, so it is covered by tests
  with a fake recognizer only.
- **Target size (2.5.8).** Not measured; the buttons have 7px/12px padding at 14px text, so they are
  expected to be above 24x24 px, but nobody has checked.

## Voice input and privacy

Voice uses the browser's Web Speech API, so it costs nothing and none of our servers hear the audio.
Chrome processes it on its vendor's servers, which is the browser's behaviour, not ours. The button is
hidden where the API doesn't exist, listening starts only on a press, takes one phrase, and stops by
itself or when the dialog closes. It is the first thing to cut if it causes trouble.
