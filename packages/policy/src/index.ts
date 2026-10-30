// Pure policy engine: computeMenu, evaluate, explain. Owner: Ishan (M2).
// No I/O, no clock reads, no randomness: it runs the same in the API, the dashboard's dry-run,
// the evals and the MCP servers.
export { computeMenu, rankedKinds } from "./menu.js";
export { describeOffer, evaluate, explain } from "./evaluate.js";
export { pantryPlanPolicy } from "./defaults.js";
export {
  DEFAULT_REASON_PREFERENCES,
  OFFERABLE_KINDS,
  PAUSE_CYCLES,
  PRICE_CHANGE_MIN_DAYS,
  REFUND_WINDOW_DAYS,
  RULE,
  type OfferableKind,
  type RuleId,
} from "./rules.js";
