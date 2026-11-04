CREATE TABLE "magic_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "magic_links_expires_at_index" ON "magic_links" USING btree ("expires_at");--> statement-breakpoint
-- A tenant table: row-level security like every other (0001_tenant_isolation.sql). Redeeming a
-- link runs in acrossMerchants, since the token arrives before we know the merchant.
ALTER TABLE "magic_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "magic_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "magic_links" USING (keepwell_can_see(merchant_id)) WITH CHECK (keepwell_can_see(merchant_id));
