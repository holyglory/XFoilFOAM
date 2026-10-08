ALTER TABLE polar_analysis_targets
ADD COLUMN mach double precision GENERATED ALWAYS AS (
  CASE WHEN jsonb_typeof(physical->'derived'->'mach') = 'number'
    THEN (physical->'derived'->>'mach')::double precision ELSE NULL END
) STORED;
--> statement-breakpoint
CREATE INDEX polar_analysis_targets_mach_id_idx
  ON polar_analysis_targets (mach, id);
