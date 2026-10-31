CREATE TABLE "email_unsubscribes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "suppressed_because" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "last_error" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "simulated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "email_unsubscribes" ADD CONSTRAINT "email_unsubscribes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_unsubscribes_merchant_id_email_index" ON "email_unsubscribes" USING btree ("merchant_id","email");--> statement-breakpoint
CREATE INDEX "notifications_merchant_id_to_sent_at_index" ON "notifications" USING btree ("merchant_id","to","sent_at");--> statement-breakpoint
-- Hand-written: the old default status was 'scheduled' and 'cancelled' is gone (the contract uses queued/sending/sent/failed/suppressed).
UPDATE "notifications" SET "status" = 'queued' WHERE "status" = 'scheduled';--> statement-breakpoint
UPDATE "notifications" SET "status" = 'suppressed', "suppressed_because" = 'superseded' WHERE "status" = 'cancelled';--> statement-breakpoint
-- Same tenant isolation as every other tenant table (0001_tenant_isolation.sql).
ALTER TABLE "email_unsubscribes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_unsubscribes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "email_unsubscribes" USING (keepwell_can_see(merchant_id)) WITH CHECK (keepwell_can_see(merchant_id));