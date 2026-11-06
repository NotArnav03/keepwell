import type { Audit, DomainEvents, Notifier } from "@keepwell/contracts";
import type { Db, Tx } from "@keepwell/db";
import type { NotifyConfig } from "./config.js";
import { createDispatcher, enqueueDueNotifications, type Dispatcher } from "./dispatcher.js";
import { createNotifier, type NotifyLogger } from "./notifier.js";
import { ConsoleFreeProvider, ResendProvider, type EmailProvider } from "./providers.js";

export { notifyConfigFromEnv, type NotifyConfig } from "./config.js";
export { createDispatcher, enqueueDueNotifications, backoffMs, type DispatchOutcome } from "./dispatcher.js";
export { createNotifier } from "./notifier.js";
export { notifyRoutes, type NotifyRoutesOptions } from "./routes.js";
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

/** The slice of the jobs module (modules/jobs) that notify needs. */
export interface NotifyJobs {
  work(
    name: "notify.dispatch",
    handler: (payload: { notificationId: string }) => Promise<void>,
  ): Promise<void>;
  send(name: "notify.dispatch", payload: { notificationId: string }): Promise<string | null>;
}

/**
 * Starts the notify.dispatch worker and hooks the due-work sweep into M1's due.sweep
 * (`reconciler.registerDueWork`), which runs every minute. That sweep is what actually sends a
 * freshly enqueued message, retries after a provider failure, and recovers a worker that died mid-send.
 */
export async function wireNotify(options: {
  db: Db;
  dispatcher: Dispatcher;
  jobs: NotifyJobs;
  registerDueWork: (name: string, fn: () => Promise<void>) => void;
}): Promise<void> {
  const { db, dispatcher, jobs, registerDueWork } = options;
  await jobs.work("notify.dispatch", async ({ notificationId }) => {
    await dispatcher.dispatch(notificationId);
  });
  registerDueWork("notify.dispatch", async () => {
    await enqueueDueNotifications(db, async (payload) => {
      await jobs.send("notify.dispatch", payload);
    });
  });
}
