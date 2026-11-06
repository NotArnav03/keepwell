-- llm_usage becomes one row per model call (#83's budget guard needs session time, tokens and
-- nano-dollar cost per call). The old per-day table never had a writer, so it is replaced, not migrated.
DROP TABLE "llm_usage" CASCADE;--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" uuid,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cost_nano_usd" bigint NOT NULL,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "llm_usage_at_index" ON "llm_usage" USING btree ("at");--> statement-breakpoint
CREATE INDEX "llm_usage_session_id_index" ON "llm_usage" USING btree ("session_id");--> statement-breakpoint
-- Recorded spend is append-only for the app, like the audit log: the budget can't be reset by rewriting it.
REVOKE UPDATE, DELETE, TRUNCATE ON "llm_usage" FROM keepwell_app;