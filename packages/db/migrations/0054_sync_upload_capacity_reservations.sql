CREATE TABLE sync_upload_capacity_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  token uuid NOT NULL,
  reserved_bytes bigint NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT sync_upload_capacity_reservations_bytes_check
    CHECK (reserved_bytes > 0)
);
--> statement-breakpoint
CREATE INDEX sync_upload_capacity_reservations_expiry_idx
  ON sync_upload_capacity_reservations (expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX sync_upload_capacity_reservations_token_uq
  ON sync_upload_capacity_reservations (token);
--> statement-breakpoint
