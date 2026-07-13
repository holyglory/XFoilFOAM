CREATE TABLE "sim_campaign_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"actor" text,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_campaign_lifecycle_events_action_check" CHECK ("sim_campaign_lifecycle_events"."action" IN ('pause', 'resume', 'cancel', 'close', 'archive', 'unarchive'))
);
--> statement-breakpoint
ALTER TABLE "sim_campaign_lifecycle_events" ADD CONSTRAINT "sim_campaign_lifecycle_events_campaign_id_sim_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."sim_campaigns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "sim_campaign_lifecycle_events_campaign_created_idx" ON "sim_campaign_lifecycle_events" USING btree ("campaign_id", "createdAt");
