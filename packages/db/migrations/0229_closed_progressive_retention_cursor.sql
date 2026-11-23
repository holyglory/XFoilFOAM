-- Advance over every inspected owner, including excluded pages, across sweeper restarts.
ALTER TABLE sweeper_state ADD COLUMN closed_progressive_retention_after_id uuid;
