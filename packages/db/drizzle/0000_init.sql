CREATE TABLE "merchant_users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_users_merchantId_email_unique" UNIQUE("merchant_id","email")
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"mode" text DEFAULT 'normal' NOT NULL,
	"paypal_client_id" text,
	"paypal_secret_enc" text,
	"paypal_token_enc" text,
	"paypal_token_expires_at" timestamp with time zone,
	"webhook_id" text,
	"keepwell_signing_secret_enc" text,
	"active_policy_version" integer,
	"last_sweep_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"paypal_plan_id" text NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"interval_unit" text NOT NULL,
	"interval_count" integer NOT NULL,
	"price_value" numeric(12, 2) NOT NULL,
	"price_currency" char(3) NOT NULL,
	"status" text NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_merchantId_paypalPlanId_unique" UNIQUE("merchant_id","paypal_plan_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"paypal_subscription_id" text NOT NULL,
	"paypal_plan_id" text NOT NULL,
	"plan_name" text NOT NULL,
	"status" text NOT NULL,
	"interval_unit" text NOT NULL,
	"interval_count" integer NOT NULL,
	"price_value" numeric(12, 2) NOT NULL,
	"price_currency" char(3) NOT NULL,
	"override_value" numeric(12, 2),
	"override_currency" char(3),
	"started_at" timestamp with time zone NOT NULL,
	"next_billing_time" timestamp with time zone,
	"last_payment_value" numeric(12, 2),
	"last_payment_currency" char(3),
	"last_payment_at" timestamp with time zone,
	"outstanding_value" numeric(12, 2),
	"outstanding_currency" char(3),
	"failed_payments_count" integer DEFAULT 0 NOT NULL,
	"last_failure_reason" text,
	"last_failure_at" timestamp with time zone,
	"next_retry_time" timestamp with time zone,
	"subscriber_email_hash" text,
	"subscriber_first_name" text,
	"snapshot" jsonb NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_merchantId_paypalSubscriptionId_unique" UNIQUE("merchant_id","paypal_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"subscription_id" uuid,
	"type" text NOT NULL,
	"params" jsonb NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"origin" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"idempotency_key" text,
	"paypal_request_id" text,
	"paypal_debug_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"approve_url" text,
	"result" jsonb,
	"error" jsonb,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actions_merchantId_idempotencyKey_unique" UNIQUE("merchant_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"merchant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"subject_ids" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "audit_log_merchant_id_seq_pk" PRIMARY KEY("merchant_id","seq")
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"state" text DEFAULT 'available' NOT NULL,
	"leased_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_subscriptions_subscriptionId_unique" UNIQUE("subscription_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_resumes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"action_id" uuid,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"raw_body" text NOT NULL,
	"headers" jsonb NOT NULL,
	"verification" text,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_merchantId_eventId_unique" UNIQUE("merchant_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"day" date NOT NULL,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "llm_usage_day_feature_model_pk" PRIMARY KEY("day","feature","model")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"menu_snapshot" jsonb NOT NULL,
	"picked_offer" jsonb,
	"decision" jsonb,
	"consent" jsonb,
	"status" text DEFAULT 'presented' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"merchant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"published_by" text NOT NULL,
	"change_note" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_merchant_id_version_pk" PRIMARY KEY("merchant_id","version")
);
--> statement-breakpoint
CREATE TABLE "delegations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delegations_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"merchant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_events_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"fallback_level" text DEFAULT 'L0' NOT NULL,
	"reason" text DEFAULT 'unknown' NOT NULL,
	"presented_offer_id" text,
	"policy_version" integer NOT NULL,
	"outcome" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dunning_cases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"failed_count" integer NOT NULL,
	"next_retry_time" timestamp with time zone,
	"playbook" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"recovered_value" numeric(12, 2),
	"recovered_currency" char(3),
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "insight_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"estimate" jsonb,
	"state" text DEFAULT 'proposed' NOT NULL,
	"action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"session_id" uuid,
	"reason" text NOT NULL,
	"sub_reason" text,
	"feature_requests" text[],
	"competitor" text,
	"sentiment" text,
	"quote" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"subscription_id" uuid,
	"to" text NOT NULL,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"provider_id" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_subscriptions" ADD CONSTRAINT "pool_subscriptions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_subscriptions" ADD CONSTRAINT "pool_subscriptions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_resumes" ADD CONSTRAINT "scheduled_resumes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_resumes" ADD CONSTRAINT "scheduled_resumes_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_resumes" ADD CONSTRAINT "scheduled_resumes_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_cases" ADD CONSTRAINT "dunning_cases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_cases" ADD CONSTRAINT "dunning_cases_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_actions" ADD CONSTRAINT "insight_actions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_actions" ADD CONSTRAINT "insight_actions_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_merchant_id_status_index" ON "subscriptions" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX "subscriptions_merchant_id_subscriber_email_hash_index" ON "subscriptions" USING btree ("merchant_id","subscriber_email_hash");--> statement-breakpoint
CREATE INDEX "actions_subscription_id_state_index" ON "actions" USING btree ("subscription_id","state");--> statement-breakpoint
CREATE INDEX "actions_state_next_attempt_at_index" ON "actions" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "domain_events_merchant_id_occurred_at_index" ON "domain_events" USING btree ("merchant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "pool_subscriptions_merchant_id_state_index" ON "pool_subscriptions" USING btree ("merchant_id","state");--> statement-breakpoint
CREATE INDEX "scheduled_resumes_status_due_at_index" ON "scheduled_resumes" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "webhook_events_status_received_at_index" ON "webhook_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "sessions_merchant_id_started_at_index" ON "sessions" USING btree ("merchant_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_subscription_id_index" ON "sessions" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "dunning_cases_merchant_id_state_index" ON "dunning_cases" USING btree ("merchant_id","state");--> statement-breakpoint
CREATE INDEX "insights_merchant_id_created_at_index" ON "insights" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_status_due_at_index" ON "notifications" USING btree ("status","due_at");