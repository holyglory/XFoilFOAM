-- Remember the last ordinary low-precise batch class across intervening FAST
-- claims. Existing campaign cursors start with a measured retry opportunity.
ALTER TABLE progressive_cfd_claim_turns
  ADD COLUMN last_precise_measured boolean NOT NULL DEFAULT false;
