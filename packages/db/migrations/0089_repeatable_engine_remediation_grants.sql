-- Ordinary preliminary URANS remains bounded to two physical CFD runs. A
-- distinct, proven engine/controller correction may grant one additional
-- immutable run even when an earlier correction for the same physical cell
-- was also exhausted. Preserve every attempt and every grant; never reset the
-- physical-attempt counter or reuse a source revision.
CREATE TABLE "sim_precalc_obligation_remediations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "obligation_id" uuid NOT NULL,
  "source_revision" text NOT NULL,
  "reason" text NOT NULL,
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sim_precalc_obligation_remediations_obligation_id_fk"
    FOREIGN KEY ("obligation_id")
    REFERENCES "sim_precalc_obligations"("id")
    ON DELETE CASCADE,
  CONSTRAINT "sim_precalc_obligation_remediations_source_revision_check"
    CHECK ("source_revision" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "sim_precalc_obligation_remediations_reason_check"
    CHECK (btrim("reason") <> ''),
  CONSTRAINT "sim_precalc_obligation_remediations_obligation_source_uq"
    UNIQUE ("obligation_id", "source_revision")
);
--> statement-breakpoint

CREATE INDEX "sim_precalc_obligation_remediations_obligation_idx"
  ON "sim_precalc_obligation_remediations" ("obligation_id", "granted_at");
--> statement-breakpoint

-- Materialize the previously single-valued grant as the first immutable audit
-- row before relaxing the summary columns.
INSERT INTO "sim_precalc_obligation_remediations" (
  "obligation_id",
  "source_revision",
  "reason",
  "granted_at"
)
SELECT
  "id",
  "remediation_source_revision",
  "remediation_reason",
  "remediation_granted_at"
FROM "sim_precalc_obligations"
WHERE "remediation_attempts_granted" = 1;
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligations"
  DROP CONSTRAINT "sim_precalc_obligations_attempt_bounds_check",
  DROP CONSTRAINT "sim_precalc_obligations_remediation_shape_check";
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligations"
  ADD CONSTRAINT "sim_precalc_obligations_attempt_bounds_check"
  CHECK (
    "attempt_count" >= 0
    AND "remediation_attempts_granted" >= 0
    AND "max_attempts" = 2 + "remediation_attempts_granted"
    AND "attempt_count" <= "max_attempts"
  ),
  ADD CONSTRAINT "sim_precalc_obligations_remediation_shape_check"
  CHECK (
    (
      "remediation_attempts_granted" = 0
      AND "remediation_reason" IS NULL
      AND "remediation_source_revision" IS NULL
      AND "remediation_granted_at" IS NULL
    )
    OR (
      "remediation_attempts_granted" > 0
      AND btrim(COALESCE("remediation_reason", '')) <> ''
      AND COALESCE("remediation_source_revision", '') ~ '^[0-9a-f]{40}$'
      AND "remediation_granted_at" IS NOT NULL
    )
  );
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligation_attempts"
  DROP CONSTRAINT "sim_precalc_obligation_attempts_solver_number_check";
--> statement-breakpoint

ALTER TABLE "sim_precalc_obligation_attempts"
  ADD CONSTRAINT "sim_precalc_obligation_attempts_solver_number_check"
  CHECK (
    "solver_attempt_number" IS NULL
    OR "solver_attempt_number" > 0
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "validate_precalc_remediation_grant"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  obligation_state text;
  obligation_attempt_count integer;
  obligation_max_attempts integer;
BEGIN
  SELECT "state", "attempt_count", "max_attempts"
  INTO obligation_state, obligation_attempt_count, obligation_max_attempts
  FROM "sim_precalc_obligations"
  WHERE "id" = NEW."obligation_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'precalc remediation obligation % does not exist',
      NEW."obligation_id";
  END IF;
  IF obligation_state <> 'blocked'
     OR obligation_attempt_count <> obligation_max_attempts THEN
    RAISE EXCEPTION
      'precalc remediation requires an exhausted blocked obligation (state %, attempts %/%)',
      obligation_state, obligation_attempt_count, obligation_max_attempts;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "sim_precalc_obligation_remediations_validate_insert"
BEFORE INSERT ON "sim_precalc_obligation_remediations"
FOR EACH ROW
EXECUTE FUNCTION "validate_precalc_remediation_grant"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "apply_precalc_remediation_grant"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "sim_precalc_obligations"
  SET
    "remediation_attempts_granted" = "remediation_attempts_granted" + 1,
    "max_attempts" = "max_attempts" + 1,
    "remediation_reason" = NEW."reason",
    "remediation_source_revision" = NEW."source_revision",
    "remediation_granted_at" = NEW."granted_at",
    "state" = 'pending',
    "next_submit_at" = now(),
    "last_outcome" = 'corrective_engine_fix_retry_pending',
    "last_error" = NULL,
    "completed_at" = NULL,
    "updatedAt" = now()
  WHERE "id" = NEW."obligation_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'precalc remediation obligation % disappeared',
      NEW."obligation_id";
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "sim_precalc_obligation_remediations_apply_insert"
AFTER INSERT ON "sim_precalc_obligation_remediations"
FOR EACH ROW
EXECUTE FUNCTION "apply_precalc_remediation_grant"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "prevent_precalc_remediation_grant_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'precalc remediation grants are immutable';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "sim_precalc_obligation_remediations_immutable_update"
BEFORE UPDATE ON "sim_precalc_obligation_remediations"
FOR EACH ROW
EXECUTE FUNCTION "prevent_precalc_remediation_grant_update"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "assert_precalc_remediation_grant_summary"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_obligation_id uuid;
  summary_count integer;
  summary_reason text;
  summary_source_revision text;
  summary_granted_at timestamp with time zone;
  grant_count integer;
  latest_reason text;
  latest_source_revision text;
  latest_granted_at timestamp with time zone;
BEGIN
  IF TG_TABLE_NAME = 'sim_precalc_obligations' THEN
    target_obligation_id := NEW."id";
  ELSE
    target_obligation_id := COALESCE(NEW."obligation_id", OLD."obligation_id");
  END IF;

  SELECT
    "remediation_attempts_granted",
    "remediation_reason",
    "remediation_source_revision",
    "remediation_granted_at"
  INTO
    summary_count,
    summary_reason,
    summary_source_revision,
    summary_granted_at
  FROM "sim_precalc_obligations"
  WHERE "id" = target_obligation_id;

  -- Parent deletion legitimately cascades its audit rows.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer
  INTO grant_count
  FROM "sim_precalc_obligation_remediations"
  WHERE "obligation_id" = target_obligation_id;

  SELECT "reason", "source_revision", "granted_at"
  INTO latest_reason, latest_source_revision, latest_granted_at
  FROM "sim_precalc_obligation_remediations"
  WHERE "obligation_id" = target_obligation_id
  ORDER BY "granted_at" DESC, "id" DESC
  LIMIT 1;

  IF summary_count <> grant_count
     OR summary_reason IS DISTINCT FROM latest_reason
     OR summary_source_revision IS DISTINCT FROM latest_source_revision
     OR summary_granted_at IS DISTINCT FROM latest_granted_at THEN
    RAISE EXCEPTION
      'precalc remediation summary differs from immutable grant history for obligation %',
      target_obligation_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "sim_precalc_obligations_remediation_summary_guard"
AFTER INSERT OR UPDATE OF
  "remediation_attempts_granted",
  "remediation_reason",
  "remediation_source_revision",
  "remediation_granted_at"
ON "sim_precalc_obligations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_precalc_remediation_grant_summary"();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "sim_precalc_obligation_remediations_summary_guard"
AFTER INSERT OR UPDATE OR DELETE
ON "sim_precalc_obligation_remediations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_precalc_remediation_grant_summary"();
