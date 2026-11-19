CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" integer NOT NULL,
	"reference" text NOT NULL,
	"kora_reference" text,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_user_id" text NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text,
	"portion_note" text,
	"dietary_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"price_kobo" integer NOT NULL,
	"is_dinner" boolean DEFAULT true NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"availability_note" text,
	"source_type" text NOT NULL,
	"source_ref" text,
	"collected_by" text NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"search" "tsvector",
	CONSTRAINT "meals_price_positive" CHECK ("meals"."price_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "review_tags" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"review_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"polarity" text NOT NULL,
	"confidence" real NOT NULL,
	"tagger" text NOT NULL,
	"model_version" text,
	"reviewed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "review_tags_confidence_range" CHECK ("review_tags"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meal_id" uuid,
	"vendor_id" uuid,
	"text" text NOT NULL,
	"rating" smallint,
	"consent_basis" text,
	"anonymised" boolean DEFAULT false NOT NULL,
	"source_ref" text,
	"collected_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"location_text" text,
	"serves_dinner" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"collected_by" text NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meals" ADD CONSTRAINT "meals_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tags" ADD CONSTRAINT "review_tags_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_tx_wallet_id_idx" ON "wallet_transactions" USING btree ("wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_tx_reference_idx" ON "wallet_transactions" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user_id_idx" ON "wallets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_telegram_user_id_idx" ON "wallets" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX "meals_vendor_id_idx" ON "meals" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "review_tags_review_id_idx" ON "review_tags" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "reviews_meal_id_idx" ON "reviews" USING btree ("meal_id");