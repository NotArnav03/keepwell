import { z } from "zod";
import { createPayPalMock } from "./server.js";

// `pnpm dev:paypal-mock`: the mock on http://localhost:4010 for local development. Point the API
// at it with PAYPAL_API_BASE=http://localhost:4010 and the Pantry Plan mock credentials.

const env = z
  .object({
    PAYPAL_MOCK_PORT: z.coerce.number().int().min(1).max(65_535).default(4010),
    // Sandbox delivers webhooks 10–75 s late; a few seconds keeps the async path visible.
    PAYPAL_MOCK_WEBHOOK_DELAY_MS: z.coerce.number().int().min(0).default(2000),
  })
  .parse(process.env);

const mock = createPayPalMock({ logger: true, webhookDelayMs: env.PAYPAL_MOCK_WEBHOOK_DELAY_MS });
const url = await mock.listen({ port: env.PAYPAL_MOCK_PORT, host: "127.0.0.1" });
mock.app.log.info(`PayPal mock ready on ${url} (control routes: ${url}/__mock)`);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  mock.app.log.info({ signal }, "shutting down");
  await mock.close();
  process.exit(0);
}

process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));
