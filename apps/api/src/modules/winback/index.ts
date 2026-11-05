// Win-back (M5, ARCHITECTURE.md 6.10). platform.ts calls registerWinback().
export {
  WinbackService,
  WINBACK_DELAY_MS,
  type WinbackDeps,
  type StartOutcome,
  type StartBatchResult,
  type StartBatchSkip,
  type StartBatchSkipReason,
} from "./service.js";
export { winbackRoutes, type WinbackRoutesOptions } from "./routes.js";
export { recordReply, ReplyRequest, ReplyError, REPLY_MAX_CHARS, type ReplyDeps } from "./replies.js";
export { drizzleWinbackStore, drizzleSubscriptionDirectory, type SubscriberLookup } from "./drizzle.js";
export { registerWinback, type WinbackWiring } from "./wire.js";
export type {
  JobQueue,
  SubscriptionDirectory,
  WinbackPolicy,
  WinbackStore,
  WinbackSubscriptionView,
} from "./ports.js";
