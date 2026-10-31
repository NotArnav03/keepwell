// Win-back (M5, ARCHITECTURE.md 6.10). Nothing is wired into server.ts yet: the job runner and
// the event bus are M1's, so whoever mounts them calls register() and mounts winbackRoutes.
export { WinbackService, WINBACK_DELAY_MS, type WinbackDeps, type StartOutcome } from "./service.js";
export { winbackRoutes, type WinbackRoutesOptions } from "./routes.js";
export { recordReply, ReplyRequest, ReplyError, REPLY_MAX_CHARS, type ReplyDeps } from "./replies.js";
export { drizzleWinbackStore, drizzleSubscriptionDirectory } from "./drizzle.js";
export type {
  JobQueue,
  SubscriptionDirectory,
  WinbackPolicy,
  WinbackStore,
  WinbackSubscriptionView,
} from "./ports.js";
