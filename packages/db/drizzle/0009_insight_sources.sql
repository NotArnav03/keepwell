ALTER TABLE "insights" ADD COLUMN "reply_id" uuid;--> statement-breakpoint
ALTER TABLE "insights" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "insights" ADD COLUMN "source" text DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "insights_session_id_index" ON "insights" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_reply_id_index" ON "insights" USING btree ("reply_id");