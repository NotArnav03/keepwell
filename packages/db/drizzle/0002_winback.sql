CREATE TABLE "winback_cases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"due_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"notification_id" uuid,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "winback_cases_merchantId_subscriptionId_unique" UNIQUE("merchant_id","subscription_id")
);
--> statement-breakpoint
CREATE TABLE "winback_replies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "winback_replies_caseId_unique" UNIQUE("case_id")
);
--> statement-breakpoint
ALTER TABLE "winback_cases" ADD CONSTRAINT "winback_cases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winback_cases" ADD CONSTRAINT "winback_cases_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winback_replies" ADD CONSTRAINT "winback_replies_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winback_replies" ADD CONSTRAINT "winback_replies_case_id_winback_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."winback_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winback_replies" ADD CONSTRAINT "winback_replies_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "winback_cases_state_due_at_index" ON "winback_cases" USING btree ("state","due_at");
--> statement-breakpoint
-- Same tenant isolation as every other merchant table (see 0001_tenant_isolation.sql).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['winback_cases', 'winback_replies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (keepwell_can_see(merchant_id)) WITH CHECK (keepwell_can_see(merchant_id))',
      t
    );
  END LOOP;
END $$;
