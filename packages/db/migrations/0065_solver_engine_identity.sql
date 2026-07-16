-- Logical solver identity, exact runtime provenance, and mutable execution
-- routing are deliberately separate domains. Only the logical identity is
-- allowed to participate in method/polar compatibility.
ALTER TYPE "evidence_artifact_kind" ADD VALUE IF NOT EXISTS 'engine_bundle';
--> statement-breakpoint
CREATE TABLE "solver_implementations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "family" text NOT NULL,
  "distribution" text NOT NULL,
  "release_version" text NOT NULL,
  "method_family" text NOT NULL,
  "adapter_contract_version" integer NOT NULL,
  "numerics_revision" text NOT NULL,
  "capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "upstream_url" text,
  "license_spdx" text,
  "retired_at" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_implementations_key_unique" UNIQUE("key"),
  CONSTRAINT "solver_implementations_logical_identity_uq" UNIQUE(
    "family", "distribution", "release_version",
    "adapter_contract_version", "numerics_revision"
  ),
  CONSTRAINT "solver_implementations_adapter_version_check"
    CHECK ("adapter_contract_version" >= 0)
);
--> statement-breakpoint
CREATE INDEX "solver_implementations_active_idx"
  ON "solver_implementations" ("family", "distribution", "release_version")
  WHERE "retired_at" IS NULL;
--> statement-breakpoint

-- The legacy row is a truthful unknown bucket for snapshots that never
-- recorded a solver release. It is not a runnable adapter. Existing snapshots
-- remain byte-for-byte unchanged and are never relabelled as OpenCFD 2406.
INSERT INTO "solver_implementations" (
  "id", "key", "family", "distribution", "release_version",
  "method_family", "adapter_contract_version", "numerics_revision",
  "capabilities", "upstream_url", "license_spdx", "retired_at"
) VALUES
  (
    '2f8bc764-09ae-4ff3-8fd2-000000000000',
    'openfoam:legacy:unknown:adapter-legacy:numerics-unknown',
    'openfoam', 'legacy', 'unknown', 'finite_volume_rans_urans', 0,
    'unknown', '{}'::jsonb, NULL, NULL, now()
  ),
  (
    '2f8bc764-09ae-4ff3-8fd2-240600000001',
    'openfoam:opencfd:2406:adapter-v1:numerics-v1',
    'openfoam', 'opencfd', '2406', 'finite_volume_rans_urans', 1, '1',
    '{"methodKeys":["openfoam.rans","openfoam.urans"],"dimensionality":["2d"],"evidence":["coefficients","mesh","fields","logs"]}'::jsonb,
    'https://develop.openfoam.com/Development/openfoam/-/tree/OpenFOAM-v2406',
    'GPL-3.0-or-later', NULL
  ),
  (
    '2f8bc764-09ae-4ff3-8fd2-001400000001',
    'openfoam:foundation:14:adapter-v1:numerics-v1',
    'openfoam', 'foundation', '14', 'finite_volume_rans_urans', 1, '1',
    '{"methodKeys":["openfoam.rans","openfoam.urans"],"dimensionality":["2d"],"evidence":["coefficients","mesh","fields","logs"]}'::jsonb,
    'https://github.com/OpenFOAM/OpenFOAM-14',
    'GPL-3.0-or-later', NULL
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_solver_implementation_identity_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    OLD."key", OLD."family", OLD."distribution", OLD."release_version",
    OLD."method_family", OLD."adapter_contract_version",
    OLD."numerics_revision", OLD."capabilities", OLD."upstream_url",
    OLD."license_spdx", OLD."createdAt"
  ) IS DISTINCT FROM ROW(
    NEW."key", NEW."family", NEW."distribution", NEW."release_version",
    NEW."method_family", NEW."adapter_contract_version",
    NEW."numerics_revision", NEW."capabilities", NEW."upstream_url",
    NEW."license_spdx", NEW."createdAt"
  ) THEN
    RAISE EXCEPTION 'solver implementation identity is immutable; insert a new implementation row';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_implementations_identity_immutable"
BEFORE UPDATE ON "solver_implementations"
FOR EACH ROW EXECUTE FUNCTION reject_solver_implementation_identity_update();
--> statement-breakpoint

CREATE TABLE "solver_runtime_builds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "solver_implementation_id" uuid NOT NULL REFERENCES "solver_implementations"("id"),
  "provenance_key" text NOT NULL,
  "build_id" text NOT NULL,
  "source_revision" text,
  "image_digest" text,
  "application_source_sha256" text,
  "package_sha256" text,
  "binary_sha256" text,
  "architecture" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_runtime_builds_provenance_key_unique" UNIQUE("provenance_key"),
  CONSTRAINT "solver_runtime_builds_id_implementation_uq" UNIQUE("id", "solver_implementation_id"),
  CONSTRAINT "solver_runtime_builds_provenance_key_check"
    CHECK ("provenance_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_runtime_builds_application_source_sha256_check"
    CHECK (
      "application_source_sha256" IS NULL
      OR "application_source_sha256" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "solver_runtime_builds_image_digest_check"
    CHECK (
      "image_digest" IS NULL
      OR "image_digest" ~ '^sha256:[0-9a-f]{64}$'
    ),
  CONSTRAINT "solver_runtime_builds_package_sha256_check"
    CHECK (
      "package_sha256" IS NULL
      OR "package_sha256" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "solver_runtime_builds_binary_sha256_check"
    CHECK (
      "binary_sha256" IS NULL
      OR "binary_sha256" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "solver_runtime_builds_content_fingerprint_check"
    CHECK (
      COALESCE("application_source_sha256" ~ '^[0-9a-f]{64}$', false)
      OR COALESCE("image_digest" ~ '^sha256:[0-9a-f]{64}$', false)
      OR COALESCE("package_sha256" ~ '^[0-9a-f]{64}$', false)
      OR COALESCE("binary_sha256" ~ '^[0-9a-f]{64}$', false)
    )
);
--> statement-breakpoint
CREATE INDEX "solver_runtime_builds_implementation_idx"
  ON "solver_runtime_builds" ("solver_implementation_id", "createdAt");
--> statement-breakpoint
CREATE INDEX "solver_runtime_builds_build_id_idx"
  ON "solver_runtime_builds" ("solver_implementation_id", "build_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_solver_runtime_build_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver runtime provenance is immutable; insert a new runtime build row';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_runtime_builds_immutable"
BEFORE UPDATE ON "solver_runtime_builds"
FOR EACH ROW EXECUTE FUNCTION reject_solver_runtime_build_update();
--> statement-breakpoint

CREATE TABLE "solver_execution_pools" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "solver_implementation_id" uuid NOT NULL REFERENCES "solver_implementations"("id"),
  "routing_key" text NOT NULL,
  "capacity_kind" text DEFAULT 'cpu_slots' NOT NULL,
  "capacity_limit" integer,
  "enabled" boolean DEFAULT false NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_execution_pools_slug_unique" UNIQUE("slug"),
  CONSTRAINT "solver_execution_pools_routing_uq" UNIQUE("routing_key"),
  CONSTRAINT "solver_execution_pools_id_implementation_uq" UNIQUE("id", "solver_implementation_id"),
  CONSTRAINT "solver_execution_pools_capacity_check"
    CHECK ("capacity_limit" IS NULL OR "capacity_limit" >= 0)
);
--> statement-breakpoint
CREATE INDEX "solver_execution_pools_implementation_idx"
  ON "solver_execution_pools" ("solver_implementation_id", "enabled");
--> statement-breakpoint
INSERT INTO "solver_execution_pools" (
  "id", "slug", "name", "solver_implementation_id", "routing_key",
  "capacity_kind", "capacity_limit", "enabled", "metadata"
) VALUES
  (
    '3f8bc764-09ae-4ff3-8fd2-240600000001',
    'openfoam-opencfd-2406', 'OpenFOAM OpenCFD 2406',
    '2f8bc764-09ae-4ff3-8fd2-240600000001',
    'celery', 'cpu_slots', NULL, true, '{}'::jsonb
  ),
  (
    '3f8bc764-09ae-4ff3-8fd2-001400000001',
    'openfoam-foundation-14', 'OpenFOAM Foundation 14',
    '2f8bc764-09ae-4ff3-8fd2-001400000001',
    'openfoam-foundation-14', 'cpu_slots', NULL, false, '{}'::jsonb
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_solver_execution_pool_identity_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    OLD."slug", OLD."solver_implementation_id", OLD."routing_key",
    OLD."capacity_kind", OLD."createdAt"
  ) IS DISTINCT FROM ROW(
    NEW."slug", NEW."solver_implementation_id", NEW."routing_key",
    NEW."capacity_kind", NEW."createdAt"
  ) THEN
    RAISE EXCEPTION 'solver execution pool identity is immutable; insert a new pool';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_execution_pools_identity_immutable"
BEFORE UPDATE ON "solver_execution_pools"
FOR EACH ROW EXECUTE FUNCTION reject_solver_execution_pool_identity_update();
--> statement-breakpoint

ALTER TABLE "solver_profiles"
  ADD COLUMN "solver_implementation_id" uuid
    DEFAULT '2f8bc764-09ae-4ff3-8fd2-240600000001' NOT NULL
    REFERENCES "solver_implementations"("id");
--> statement-breakpoint
CREATE INDEX "solver_profiles_implementation_idx"
  ON "solver_profiles" ("solver_implementation_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_retired_solver_profile_implementation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "solver_implementations" implementation
    WHERE implementation."id" = NEW."solver_implementation_id"
      AND implementation."retired_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'retired solver implementation cannot be selected by a solver profile';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_profiles_reject_retired_implementation"
BEFORE INSERT OR UPDATE OF "solver_implementation_id" ON "solver_profiles"
FOR EACH ROW EXECUTE FUNCTION reject_retired_solver_profile_implementation();
--> statement-breakpoint

ALTER TABLE "simulation_preset_revisions"
  ADD COLUMN "solver_implementation_id" uuid
    DEFAULT '2f8bc764-09ae-4ff3-8fd2-000000000000' NOT NULL
    REFERENCES "solver_implementations"("id"),
  ADD COLUMN "method_compatibility_hash_version" integer,
  ADD COLUMN "method_compatibility_hash" text,
  ADD COLUMN "is_canonical_method" boolean DEFAULT false NOT NULL,
  ADD CONSTRAINT "simulation_preset_revisions_method_hash_shape_check"
    CHECK (
      ("method_compatibility_hash_version" IS NULL AND "method_compatibility_hash" IS NULL)
      OR (
        "method_compatibility_hash_version" > 0
        AND "method_compatibility_hash" ~ '^[0-9a-f]{64}$'
      )
    );
--> statement-breakpoint
CREATE INDEX "simulation_preset_revisions_method_compatibility_hash_idx"
  ON "simulation_preset_revisions" (
    "method_compatibility_hash_version", "method_compatibility_hash"
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "simulation_preset_revisions_canonical_method_uq"
  ON "simulation_preset_revisions" (
    "method_compatibility_hash_version", "method_compatibility_hash"
  ) WHERE "is_canonical_method";
--> statement-breakpoint

ALTER TABLE "sim_jobs"
  ADD COLUMN "method_key" text,
  ADD COLUMN "solver_implementation_id" uuid REFERENCES "solver_implementations"("id"),
  ADD COLUMN "solver_runtime_build_id" uuid REFERENCES "solver_runtime_builds"("id"),
  ADD COLUMN "solver_execution_pool_id" uuid REFERENCES "solver_execution_pools"("id"),
  ADD CONSTRAINT "sim_jobs_runtime_build_owner_fk"
    FOREIGN KEY ("solver_runtime_build_id", "solver_implementation_id")
    REFERENCES "solver_runtime_builds"("id", "solver_implementation_id"),
  ADD CONSTRAINT "sim_jobs_execution_pool_owner_fk"
    FOREIGN KEY ("solver_execution_pool_id", "solver_implementation_id")
    REFERENCES "solver_execution_pools"("id", "solver_implementation_id"),
  ADD CONSTRAINT "sim_jobs_runtime_shape_check"
    CHECK (
      ("solver_runtime_build_id" IS NULL AND "solver_execution_pool_id" IS NULL)
      OR "solver_implementation_id" IS NOT NULL
    ),
  ADD CONSTRAINT "sim_jobs_method_key_check"
    CHECK ("method_key" IS NULL OR btrim("method_key") <> '');
--> statement-breakpoint
CREATE INDEX "sim_jobs_solver_implementation_idx" ON "sim_jobs" ("solver_implementation_id");
--> statement-breakpoint
CREATE INDEX "sim_jobs_solver_runtime_build_idx" ON "sim_jobs" ("solver_runtime_build_id");
--> statement-breakpoint
CREATE INDEX "sim_jobs_solver_execution_pool_idx" ON "sim_jobs" ("solver_execution_pool_id");
--> statement-breakpoint

ALTER TABLE "result_attempts"
  ADD COLUMN "method_key" text,
  ADD COLUMN "solver_implementation_id" uuid REFERENCES "solver_implementations"("id"),
  ADD COLUMN "solver_runtime_build_id" uuid REFERENCES "solver_runtime_builds"("id"),
  ADD CONSTRAINT "result_attempts_runtime_build_owner_fk"
    FOREIGN KEY ("solver_runtime_build_id", "solver_implementation_id")
    REFERENCES "solver_runtime_builds"("id", "solver_implementation_id"),
  ADD CONSTRAINT "result_attempts_runtime_build_shape_check"
    CHECK ("solver_runtime_build_id" IS NULL OR "solver_implementation_id" IS NOT NULL),
  ADD CONSTRAINT "result_attempts_method_key_check"
    CHECK ("method_key" IS NULL OR btrim("method_key") <> '');
--> statement-breakpoint
CREATE INDEX "result_attempts_solver_implementation_idx" ON "result_attempts" ("solver_implementation_id");
--> statement-breakpoint
CREATE INDEX "result_attempts_solver_runtime_build_idx" ON "result_attempts" ("solver_runtime_build_id");
--> statement-breakpoint

ALTER TABLE "results"
  ADD COLUMN "method_key" text,
  ADD COLUMN "solver_implementation_id" uuid REFERENCES "solver_implementations"("id"),
  ADD COLUMN "solver_runtime_build_id" uuid REFERENCES "solver_runtime_builds"("id"),
  ADD CONSTRAINT "results_runtime_build_owner_fk"
    FOREIGN KEY ("solver_runtime_build_id", "solver_implementation_id")
    REFERENCES "solver_runtime_builds"("id", "solver_implementation_id"),
  ADD CONSTRAINT "results_runtime_build_shape_check"
    CHECK ("solver_runtime_build_id" IS NULL OR "solver_implementation_id" IS NOT NULL),
  ADD CONSTRAINT "results_method_key_check"
    CHECK ("method_key" IS NULL OR btrim("method_key") <> '');
--> statement-breakpoint

ALTER TABLE "solver_evidence_artifacts"
  ADD COLUMN "method_key" text,
  ADD COLUMN "solver_implementation_id" uuid REFERENCES "solver_implementations"("id"),
  ADD COLUMN "solver_runtime_build_id" uuid REFERENCES "solver_runtime_builds"("id"),
  ADD CONSTRAINT "solver_evidence_artifacts_runtime_build_owner_fk"
    FOREIGN KEY ("solver_runtime_build_id", "solver_implementation_id")
    REFERENCES "solver_runtime_builds"("id", "solver_implementation_id"),
  ADD CONSTRAINT "solver_evidence_artifacts_runtime_build_shape_check"
    CHECK ("solver_runtime_build_id" IS NULL OR "solver_implementation_id" IS NOT NULL),
  ADD CONSTRAINT "solver_evidence_artifacts_method_key_check"
    CHECK ("method_key" IS NULL OR btrim("method_key") <> '');
--> statement-breakpoint
CREATE INDEX "solver_evidence_artifacts_solver_implementation_idx"
  ON "solver_evidence_artifacts" ("solver_implementation_id");
--> statement-breakpoint
CREATE INDEX "solver_evidence_artifacts_solver_runtime_build_idx"
  ON "solver_evidence_artifacts" ("solver_runtime_build_id");
