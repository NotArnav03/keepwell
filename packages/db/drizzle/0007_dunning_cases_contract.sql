-- dunning_cases to the DunningCase contract (packages/contracts/src/growth/dunning.ts). The table had no
-- writers yet; the old terminal states fold into the contract's "closed".
UPDATE "dunning_cases" SET "state" = 'closed' WHERE "state" IN ('lost', 'cancelled');--> statement-breakpoint
ALTER TABLE "dunning_cases" ADD COLUMN "outstanding_value" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "dunning_cases" ADD COLUMN "outstanding_currency" char(3);--> statement-breakpoint
ALTER TABLE "dunning_cases" ADD COLUMN "notification_id" uuid;--> statement-breakpoint
ALTER TABLE "dunning_cases" ADD COLUMN "capture_action_id" uuid;--> statement-breakpoint
ALTER TABLE "dunning_cases" ADD COLUMN "simulated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dunning_cases" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "dunning_cases" ADD CONSTRAINT "dunning_cases_capture_action_id_actions_id_fk" FOREIGN KEY ("capture_action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dunning_cases_one_active_per_subscription" ON "dunning_cases" USING btree ("subscription_id") WHERE "dunning_cases"."state" in ('open', 'suspended');