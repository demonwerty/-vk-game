CREATE TABLE "referral_claims" (
	"vk_id" text PRIMARY KEY,
	"claimed" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"invitee_id" text PRIMARY KEY,
	"referrer_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" ("referrer_id");