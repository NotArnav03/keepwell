import type { Audit, DomainEvents, Notifier } from "@keepwell/contracts";
import type { Db, Tx } from "@keepwell/db";
import type { NotifyConfig } from "./config.js";
import { createDispatcher, type Dispatcher } from "./dispatcher.js";
import { createNotifier, type NotifyLogger } from "./notifier.js";
import { ConsoleFreeProvider, ResendProvider, type EmailProvider } from "./providers.js";

export { loadNotifyConfig, type NotifyConfig } from "./config.js";
export { createDispatcher, enqueueDueNotifications, backoffMs, type DispatchOutcome } from "./dispatcher.js";
export { createNotifier } from "./notifier.js";
export { EmailProviderError, FakeEmailProvider, type EmailProvider } from "./providers.js";

export interface CreateNotifyOptions {
  db: Db;
  audit: Audit<Tx>;
  events: DomainEvents<Tx>;
  config: NotifyConfig;
  log: NotifyLogger;
  /** Defaults to Resend when a key is configured, otherwise the console provider. */
  provider?: EmailProvider;
}

/** What other modules get: `notifier.enqueue` for callers, `dispatcher.dispatch` for the notify.dispatch job. */
export function createNotify(options: CreateNotifyOptions): {
  notifier: Notifier<Tx>;
  dispatcher: Dispatcher;
} {
  const { db, audit, events, config, log } = options;
  const provider =
    options.provider ??
    (config.resendApiKey
      ? new ResendProvider({
          apiKey: config.resendApiKey,
          baseUrl: config.resendApiBase,
          from: config.emailFrom,
        })
      : new ConsoleFreeProvider(log));
  return {
    notifier: createNotifier({ db, audit, log }),
    dispatcher: createDispatcher({ db, provider, audit, events, config, log }),
  };
}
