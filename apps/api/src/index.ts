import { loadEnv } from "./env.js";
import { buildServer } from "./server.js";

const env = loadEnv();
const app = buildServer(env);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
}

process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));

await app.listen({ host: env.HOST, port: env.PORT });
