import * as Sentry from "@sentry/node";
import { loadEnv } from "./env.js";
import { startPlatform } from "./platform.js";

const env = loadEnv();

// Errors go to Sentry only when a DSN is configured (free tier), and nothing else does. Sentry 11
// collects bodies, headers, cookies and query strings by default: webhook bodies hold subscriber
// data and headers carry tokens, so all of it is switched off. No tracing either.
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENV,
    ...(env.RENDER_GIT_COMMIT && { release: env.RENDER_GIT_COMMIT }),
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    tracesSampleRate: 0,
  });
}

const platform = await startPlatform(env);
if (env.SENTRY_DSN) Sentry.setupFastifyErrorHandler(platform.app);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  platform.app.log.info({ signal }, "shutting down");
  await platform.stop();
  process.exit(0);
}

process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));

await platform.app.listen({ host: env.HOST, port: env.PORT });
