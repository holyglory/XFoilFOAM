-- A remote polar is a long CFD ownership lease, not a short HTTP lock. The
-- previous 24-hour default (and one transfer path's historical one-hour
-- renewal) could release a healthy in-flight solve back to local scheduling.
ALTER TABLE sync_api_settings
  ALTER COLUMN default_promise_ttl_hours SET DEFAULT 72;
--> statement-breakpoint

UPDATE sync_api_settings
SET default_promise_ttl_hours = 72,
    "updatedAt" = now()
WHERE default_promise_ttl_hours = 24;
