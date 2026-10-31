ALTER TABLE "insights" ADD COLUMN "reply_id" uuid;--> statement-breakpoint
ALTER TABLE "insights" ADD COLUMN "source" text DEFAULT 'session' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "insights_session_id_index" ON "insights" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_reply_id_index" ON "insights" USING btree ("reply_id");