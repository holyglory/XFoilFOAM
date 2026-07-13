DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM airfoils airfoil
    WHERE airfoil.slug IN ('naca-1', 'ua79sfm')
      AND (
        EXISTS (SELECT 1 FROM results result WHERE result.airfoil_id = airfoil.id)
        OR EXISTS (SELECT 1 FROM result_attempts attempt WHERE attempt.airfoil_id = airfoil.id)
        OR EXISTS (SELECT 1 FROM sim_jobs job WHERE job.airfoil_id = airfoil.id)
        OR EXISTS (SELECT 1 FROM sim_precalc_obligations obligation WHERE obligation.airfoil_id = airfoil.id)
        OR EXISTS (SELECT 1 FROM sim_urans_requests request_item WHERE request_item.airfoil_id = airfoil.id)
        OR EXISTS (SELECT 1 FROM sim_urans_verify_queue verify_item WHERE verify_item.airfoil_id = airfoil.id)
      )
  ) THEN
    RAISE EXCEPTION 'cannot archive incomplete source components after solver work exists; preserve evidence and migrate geometry explicitly';
  END IF;
END $$;
--> statement-breakpoint
UPDATE airfoils
SET "archivedAt" = COALESCE("archivedAt", '2026-07-13T00:00:00.000Z'::timestamptz),
    tags = (
      SELECT array_agg(DISTINCT tag ORDER BY tag)
      FROM unnest(airfoils.tags || ARRAY['source-component', 'solver-unsupported']::text[]) AS source_tag(tag)
    ),
    "updatedAt" = now()
WHERE slug IN ('naca-1', 'ua79sfm');
--> statement-breakpoint
UPDATE sim_campaign_points point
SET state = 'released', "updatedAt" = now()
FROM airfoils airfoil
WHERE point.airfoil_id = airfoil.id
  AND airfoil.slug IN ('naca-1', 'ua79sfm')
  AND point.state = 'requested'
  AND point.result_id IS NULL;
--> statement-breakpoint
DELETE FROM sim_campaign_lanes lane
USING airfoils airfoil
WHERE lane.airfoil_id = airfoil.id
  AND airfoil.slug IN ('naca-1', 'ua79sfm');
--> statement-breakpoint
UPDATE sim_campaign_progress progress
SET requested = 0,
    solved = 0,
    failed = 0,
    running = 0,
    superseded = 0,
    derived = 0,
    rejected = 0,
    blocked = 0,
    precalc_mesh_repairing = 0,
    blocked_mesh_quality = 0,
    blocked_precalc_exhausted = 0,
    blocked_engine_submit = 0,
    blocked_other = 0,
    "updatedAt" = now()
FROM airfoils airfoil
WHERE progress.airfoil_id = airfoil.id
  AND airfoil.slug IN ('naca-1', 'ua79sfm');
