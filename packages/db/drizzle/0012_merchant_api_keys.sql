CREATE TABLE "merchant_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "merchant_api_keys_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "merchant_api_keys" ADD CONSTRAINT "merchant_api_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A tenant table: row-level security like every other (0001_tenant_isolation.sql). Authenticating a
-- key runs in acrossMerchants, since the token arrives before we know the merchant.
ALTER TABLE "merchant_api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merchant_api_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "merchant_api_keys" USING (keepwell_can_see(merchant_id)) WITH CHECK (keepwell_can_see(merchant_id));
