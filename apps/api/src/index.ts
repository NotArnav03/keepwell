import { createPool, postgresReadiness } from "./db.js";
import { databaseUrl, loadEnv } from "./env.js";
import { buildServer } from "./server.js";

const env = loadEnv();
const url = databaseUrl(env);
// The callback only runs after a connection drops, by which time `app` exists.
const pool = url
  ? createPool(url, (err) => app.log.warn({ err }, "idle postgres connection closed"))
  : undefined;
const app = buildServer(env, {
  readinessChecks: pool ? [postgresReadiness(pool)] : [],
  // Waking a suspended Neon compute can take a few seconds.
  readinessTimeoutMs: 5000,
});

if (pool) {
  app.addHook("onClose", () => pool.end());
} else {
  app.log.warn("No DATABASE_URL_UNPOOLED or DATABASE_URL set: running without a database");
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
}

process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));

await app.listen({ host: env.HOST, port: env.PORT });
