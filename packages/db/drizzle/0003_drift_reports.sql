CREATE TABLE "drift_reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"checked" integer NOT NULL,
	"drifted" integer NOT NULL,
	"details" jsonb NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drift_reports" ADD CONSTRAINT "drift_reports_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drift_reports_merchant_id_ran_at_index" ON "drift_reports" USING btree ("merchant_id","ran_at");--> statement-breakpoint
-- A tenant table: row-level security like every other (0001_tenant_isolation.sql).
ALTER TABLE "drift_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "drift_reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "drift_reports" USING (keepwell_can_see(merchant_id)) WITH CHECK (keepwell_can_see(merchant_id));
