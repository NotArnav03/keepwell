ALTER TABLE "insight_actions" ADD COLUMN "rationale" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "insight_actions" ADD COLUMN "proposed_by" text DEFAULT 'copilot' NOT NULL;--> statement-breakpoint
ALTER TABLE "insight_actions" ADD COLUMN "error" text;