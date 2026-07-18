-- OpenCFD 2606 cutover canaries are operational evidence, not aerodynamic
-- results.  Preserve their exact GCS generations without inventing a result,
-- attempt, AoA, coefficient, or polar owner.  This ledger is deliberately
-- separate from solver_evidence_blobs/archives and from forensic quarantine.
--
-- These four immutable runtime rows and the 16 row seals are generated from
-- config/operational-canary-approved-inventory.json.  The r2/r3/r4 rows no
-- longer existed in the live database because the failed rollout never
-- acquired an aerodynamic owner; recreating their exact operational runtime
-- identities does not create a result or a polar.
INSERT INTO "solver_runtime_builds" (
  "id", "solver_implementation_id", "provenance_key", "build_id",
  "source_revision", "image_digest", "application_source_sha256",
  "package_sha256", "binary_sha256", "architecture", "metadata"
) VALUES
  ('a5d34ae1-4588-4780-a66a-f6683ca0e902', '2f8bc764-09ae-4ff3-8fd2-260600000001', 'ee66c48fe58131ac2013b11b1a8fb491f5fb0a615e6cea423d03d04e23af57c7', 'prod-20260717-63385777be73-r2', '481094fdf34f11ed6d0d603ee59a858a0124236d', NULL, '6b629a9b71685d94d756a91d1e7121a2774bb20da62522a10eeb46d4de401b2f', 'aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d', '36b5e8b213ab5b968cd94bbbf464ea9681619192fe71550cfbd4bdb678108f6e', 'x86_64', '{"purpose":"operational_canary_approved_inventory","inventorySha256":"1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b"}'::jsonb),
  ('a5d34ae1-4588-4780-a66a-f6683ca0e903', '2f8bc764-09ae-4ff3-8fd2-260600000001', '1043dc06840114a1a319beb9411904b3230adbb3d1787fc934f74811678bb004', 'prod-20260717-cd0967a1ba4e-r3', '481094fdf34f11ed6d0d603ee59a858a0124236d', NULL, '1926b961c19133370f0903c2394980bba782ccd91db03de9d432c735f368c56e', 'aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d', '36b5e8b213ab5b968cd94bbbf464ea9681619192fe71550cfbd4bdb678108f6e', 'x86_64', '{"purpose":"operational_canary_approved_inventory","inventorySha256":"1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b"}'::jsonb),
  ('a5d34ae1-4588-4780-a66a-f6683ca0e904', '2f8bc764-09ae-4ff3-8fd2-260600000001', 'eabbf99a08ba73748b98045ebb274afce43be84276c2359c393c633f1e509f54', 'prod-20260717-2ab861cb4ce6-r4', '481094fdf34f11ed6d0d603ee59a858a0124236d', NULL, '57bca7b4fee964f30d0a44a9a7e83967ed975357aee1f44f46d0d3865412439c', 'aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d', '36b5e8b213ab5b968cd94bbbf464ea9681619192fe71550cfbd4bdb678108f6e', 'x86_64', '{"purpose":"operational_canary_approved_inventory","inventorySha256":"1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b"}'::jsonb),
  ('a5d34ae1-4588-4780-a66a-f6683ca0e99c', '2f8bc764-09ae-4ff3-8fd2-260600000001', '6a6348a0eaee9e8ebc5795fd157f51af2d4fcc93927a76054d3653ec01418851', 'prod-20260717-7a13801aa5b3-r5', '481094fdf34f11ed6d0d603ee59a858a0124236d', NULL, '661f7061ecd12932305c5a3c479e8d1680d1bcc3ab7e8cd020ab66f5a57075db', 'aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d', '36b5e8b213ab5b968cd94bbbf464ea9681619192fe71550cfbd4bdb678108f6e', 'x86_64', '{"purpose":"operational_canary_approved_inventory","inventorySha256":"1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b"}'::jsonb)
ON CONFLICT ("provenance_key") DO NOTHING;
--> statement-breakpoint

DO $$
BEGIN
  IF (SELECT count(*) FROM "solver_runtime_builds" WHERE
    ("id", "provenance_key") IN (
      ('a5d34ae1-4588-4780-a66a-f6683ca0e902'::uuid, 'ee66c48fe58131ac2013b11b1a8fb491f5fb0a615e6cea423d03d04e23af57c7'),
      ('a5d34ae1-4588-4780-a66a-f6683ca0e903'::uuid, '1043dc06840114a1a319beb9411904b3230adbb3d1787fc934f74811678bb004'),
      ('a5d34ae1-4588-4780-a66a-f6683ca0e904'::uuid, 'eabbf99a08ba73748b98045ebb274afce43be84276c2359c393c633f1e509f54'),
      ('a5d34ae1-4588-4780-a66a-f6683ca0e99c'::uuid, '6a6348a0eaee9e8ebc5795fd157f51af2d4fcc93927a76054d3653ec01418851')
    )
  ) <> 4 THEN
    RAISE EXCEPTION 'approved operational-canary runtime identities conflict with existing rows';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE TABLE "solver_operational_canary_approved_inventory" (
  "inventory_sha256" text NOT NULL,
  "engine_job_id" text NOT NULL,
  "evidence_path" text NOT NULL,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "generation" text NOT NULL,
  "row_seal_sha256" text NOT NULL,
  CONSTRAINT "solver_operational_canary_approved_inventory_pk"
    PRIMARY KEY ("engine_job_id", "evidence_path"),
  CONSTRAINT "solver_operational_canary_approved_target_uq"
    UNIQUE ("bucket", "object_key", "generation"),
  CONSTRAINT "solver_operational_canary_approved_inventory_digest_check" CHECK (
    "inventory_sha256" = '1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b'
    AND "row_seal_sha256" ~ '^[0-9a-f]{64}$'
  )
);
--> statement-breakpoint
INSERT INTO "solver_operational_canary_approved_inventory" (
  "inventory_sha256", "engine_job_id", "evidence_path", "bucket",
  "object_key", "generation", "row_seal_sha256"
) VALUES
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','007950b682e14a81a52d126c2f19f6a4','cases/c0p05_u166_a0/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/22/227b88334a49b46ff96d9c88fd8c1bbf484eb3fc8c06692b64627b3cab1a4467.tar.zst','1784265654400391','58f1d58781bd07feac8c46328574e2bb37055d04f1acb606cf90d038e6d7acd2'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','01b19001fff648c79fc7443ece7c59d2','cases/c0p1_u50_a2/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/6f/6fd89977691a1fa2e1cac2e3d6f4935cae1eb744b4ae84f30d9242aa78fad942.tar.zst','1784253860084375','cdeae8998a2cb7bcdf2af0629fd2fb889618f09c581cddd06a3572d49064b7f1'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','01b19001fff648c79fc7443ece7c59d2','cases/c0p1_u50_a5/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/0a/0a4054dfc5a05b83fb1fcd7eab0cf4fa0f9620fb67efd36cc2e7020c3caa3211.tar.zst','1784253925692138','2fe857e73feabbdebb1ef91a09aec4ab9fd95c10db610945e549f9d6b8669dcc'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','4c64f7be8dcd4e8aa314a0cb593986a5','cases/c0p1_u50_a2/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/12/12f2f1bae8e6e750c1ad7d18f9f794d669794d24771a50a8ace52b59df698a75.tar.zst','1784262728974059','7ee7e8caa1ea7537b10c6f779a6eca74deda4f22cd44401fad3e4de6e62d2a7c'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','4c64f7be8dcd4e8aa314a0cb593986a5','cases/c0p1_u50_a5/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/f9/f94c453a422e1cd589967de079578600db21a550c4c58922f9abfa9f3c0e563a.tar.zst','1784262737223313','2ddbd04c5a81845cd1b7f5faf31ac83e3e39a5594820e7288a5c603bb48781c6'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','6f5146938cde4c87957159b0214ed6b1','cases/c0p05_u166_a0/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/51/51ff9fc2535dcac71fc2f5ad2e33f7ae07f7fc4a020751177a4d7d8dc7a84b02.tar.zst','1784260130593934','e90e6a69b3117a8e1542fe6766c2ac7508bf5bce84e0d154ffa3f0356dba9e00'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','77960f1d5700411585ce8cc433ebc0cd','cases/c0p1_u50_a5/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/f9/f9569365e86ce5db8d305d5cb10d74b3ae2add71a39d350503172f9f645afe20.tar.zst','1784265247146278','3a031f6bb4e22b13c05d42aac3d79e0b9c788fe733ba298a0418000b97007824'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','a68933577cb14f9584e15f617f8770d9','cases/c0p1_u50_a2/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/bd/bd9a3d70aead7584a371207036aed4296079dd584fa686bc5c052add0757a3c3.tar.zst','1784259769646972','b809f35d21325f92c58c2b4fe25d345e54852adf4597fefe2495a8a2e1ef9a5b'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','a68933577cb14f9584e15f617f8770d9','cases/c0p1_u50_a5/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/83/835b5a6699b3d0c2cb80e49a4d815d1ec632493e1f58774a96fe2376fbdae9fc.tar.zst','1784259777242845','8247d3ed0bcf40e6830dc3ea0a9736596dd01bd44ac3314a5a5b3951c8cd3fbc'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','aed4ddc3441d4239afd32baba34db3ef','cases/c0p1_u50_a5/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/11/114dd2444a54c0e88126899ccf38e2910cf58bf9ce1dd471b73d05298a9f3378.tar.zst','1784262752500802','f9810806a41002bace936ed28c833a3a9c09123736f5e202efdd2e42f4410cc8'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','b57cb2d8cee741eaa146b528d6fbdc6f','cases/c0p05_u166_a0/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/31/310d52e45aa127e078ec3c6b5e915903e62a5365aa96cf8e77896b9a247d343c.tar.zst','1784263147857413','75f513725c2f584f30ccec0690744fbde9bea71bf9e784ebf5ecebeed1497dd1'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','c7d09bb488584dd4a25b5209431d9034','cases/c0p1_u50_a2/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/82/824696f6e8b22a60cdfd53a653dbdd088fd741fac33252f8f0e90dea98ba5e79.tar.zst','1784257459167967','8086f3bf43b6cf84a0f3d8077ffb6d677ff05b570fb964d8692faa3c3bb950c0'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','c7d09bb488584dd4a25b5209431d9034','cases/c0p1_u50_a5/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/ed/ed4dd030946854a2cde072fa2432869c465f53e81c1fd0459596527d825ec6c8.tar.zst','1784257467754985','27f264a63a547f73e492e5cf7aa9aa7232370fba243dc6dd3960370e7bf97c2f'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','ca41fc4c138a4141983a033e2a0f8749','cases/c0p1_u50_a2/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/58/58ea09d2ffe77322b499365708f109fb3f6e7f5e5b3ce6ed6dec061782ae06a4.tar.zst','1784265224162242','e57be6b5dfcfc8a30607ada94dc6136d2f7926d9c3e0302644e966d5bd51072a'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','ca41fc4c138a4141983a033e2a0f8749','cases/c0p1_u50_a5/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/dc/dc4b754bf7b4ea53d6996c44a481d7a912556cdb4e76e72856ca8de936861672.tar.zst','1784265232088893','cf659c15ef92b03fab232496d2130288d4d1d8bd78fd2875e202b097649a17e6'),
  ('1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b','de3dbbef99e248549e9cbe7d76cc5714','cases/c0p1_u50_a5/evidence','airfoils-pro-storage-bucket','solver-evidence/v1/sha256/71/71b618de5ccb19a049d1dff2ce13ac6d1222eb8d6d204583b7a1f2920787b47b.tar.zst','1784259792662020','fb128850ce82941d573235df23fd033e9f5d4b2ada49595091293e421e74e257');
--> statement-breakpoint

CREATE TABLE "solver_operational_canary_evidence_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "approved_inventory_sha256" text NOT NULL,
  "provenance_kind" text NOT NULL,
  "canary_attestation_id" uuid
    REFERENCES "solver_engine_canary_attestations"("id"),
  "solver_implementation_id" uuid NOT NULL
    REFERENCES "solver_implementations"("id"),
  "solver_runtime_build_id" uuid NOT NULL
    REFERENCES "solver_runtime_builds"("id"),
  "engine_job_id" text NOT NULL,
  "evidence_path" text NOT NULL,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "generation" text NOT NULL,
  "stored_sha256" text NOT NULL,
  "stored_byte_size" bigint NOT NULL,
  "crc32c" text NOT NULL,
  "tar_sha256" text NOT NULL,
  "tar_byte_size" bigint NOT NULL,
  "zstd_level" integer NOT NULL,
  "pointer_sha256" text NOT NULL,
  "pointer_byte_size" bigint NOT NULL,
  "manifest_sha256" text NOT NULL,
  "manifest_byte_size" bigint NOT NULL,
  "archive_member_set_sha256" text NOT NULL,
  "archive_member_count" integer NOT NULL,
  "status_sha256" text NOT NULL,
  "status_byte_size" bigint NOT NULL,
  "source_build_sha256" text,
  "source_build_byte_size" bigint,
  "source_journal_sha256" text,
  "source_journal_byte_size" bigint,
  "operator_receipt_sha256" text,
  "operator_receipt_byte_size" bigint,
  "cutover_failure_phase" text,
  "cutover_failure_exit_code" integer,
  "registration_receipt_sha256" text NOT NULL UNIQUE,
  "registration_receipt_canonical" text NOT NULL,
  "registration_receipt" jsonb NOT NULL,
  "registered_by" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_operational_canary_evidence_target_uq"
    UNIQUE ("bucket", "object_key", "generation"),
  CONSTRAINT "solver_operational_canary_evidence_job_path_uq"
    UNIQUE ("engine_job_id", "evidence_path"),
  CONSTRAINT "solver_operational_canary_evidence_approved_member_fk"
    FOREIGN KEY ("engine_job_id", "evidence_path")
    REFERENCES "solver_operational_canary_approved_inventory"
      ("engine_job_id", "evidence_path"),
  CONSTRAINT "solver_operational_canary_evidence_runtime_owner_fk"
    FOREIGN KEY ("solver_runtime_build_id", "solver_implementation_id")
    REFERENCES "solver_runtime_builds"("id", "solver_implementation_id"),
  CONSTRAINT "solver_operational_canary_evidence_provenance_check" CHECK (
    (
      "provenance_kind" = 'attested_canary'
      AND "canary_attestation_id" IS NOT NULL
      AND "source_build_sha256" IS NULL
      AND "source_build_byte_size" IS NULL
      AND "source_journal_sha256" IS NULL
      AND "source_journal_byte_size" IS NULL
      AND "operator_receipt_sha256" IS NULL
      AND "operator_receipt_byte_size" IS NULL
      AND "cutover_failure_phase" IS NULL
      AND "cutover_failure_exit_code" IS NULL
    ) OR (
      "provenance_kind" = 'unattested_cutover_canary'
      AND "canary_attestation_id" IS NULL
      AND "source_build_sha256" ~ '^[0-9a-f]{64}$'
      AND "source_build_byte_size" > 0
      AND "source_journal_sha256" ~ '^[0-9a-f]{64}$'
      AND "source_journal_byte_size" > 0
      AND "operator_receipt_sha256" ~ '^[0-9a-f]{64}$'
      AND "operator_receipt_byte_size" > 0
      AND btrim("cutover_failure_phase") <> ''
      AND "cutover_failure_exit_code" > 0
    )
  ),
  CONSTRAINT "solver_operational_canary_evidence_path_check" CHECK (
    btrim("engine_job_id") <> ''
    AND "engine_job_id" !~ '[/\\\\]'
    AND btrim("evidence_path") <> ''
    AND "evidence_path" NOT LIKE '/%'
    AND "evidence_path" !~ '(^|/)[.]{1,2}(/|$)'
    AND position(E'\\\\' in "evidence_path") = 0
    AND btrim("bucket") <> ''
    AND btrim("object_key") <> ''
    AND "object_key" NOT LIKE '/%'
    AND "object_key" !~ '(^|/)[.]{1,2}(/|$)'
    AND position(E'\\\\' in "object_key") = 0
    AND "object_key" = 'solver-evidence/v1/sha256/'
      || substring("stored_sha256" from 1 for 2) || '/'
      || "stored_sha256" || '.tar.zst'
  ),
  CONSTRAINT "solver_operational_canary_evidence_identity_check" CHECK (
    "approved_inventory_sha256" = '1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b'
    AND "generation" ~ '^[1-9][0-9]{0,19}$'
    AND "generation"::numeric <= 18446744073709551615
    AND "stored_sha256" ~ '^[0-9a-f]{64}$'
    AND "stored_byte_size" > 0
    AND "crc32c" ~ '^[A-Za-z0-9+/]{6}==$'
    AND "tar_sha256" ~ '^[0-9a-f]{64}$'
    AND "tar_byte_size" > 0
    AND "zstd_level" BETWEEN 1 AND 22
    AND "pointer_sha256" ~ '^[0-9a-f]{64}$'
    AND "pointer_byte_size" > 0
    AND "manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "manifest_byte_size" > 0
    AND "archive_member_set_sha256" ~ '^[0-9a-f]{64}$'
    AND "archive_member_count" > 1
    AND "status_sha256" ~ '^[0-9a-f]{64}$'
    AND "status_byte_size" > 0
    AND "registration_receipt_sha256" ~ '^[0-9a-f]{64}$'
    AND btrim("registration_receipt_canonical") <> ''
    AND jsonb_typeof("registration_receipt") = 'object'
    AND btrim("registered_by") <> ''
  )
);
--> statement-breakpoint
CREATE INDEX "solver_operational_canary_evidence_job_idx"
  ON "solver_operational_canary_evidence_objects"
  ("engine_job_id", "createdAt");
--> statement-breakpoint
CREATE INDEX "solver_operational_canary_evidence_runtime_idx"
  ON "solver_operational_canary_evidence_objects"
  ("solver_runtime_build_id", "createdAt");
--> statement-breakpoint

-- Engine-job identity is an independent ownership boundary.  The GCS lock
-- prevents object adoption races; this second exact lock prevents a delayed
-- result ingest from acquiring the source job after operational ownership.
CREATE OR REPLACE FUNCTION lock_operational_canary_engine_job_identity(
  p_engine_job_id text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(COALESCE(p_engine_job_id, ''), 26061)
  );
END;
$$;
--> statement-breakpoint

-- One append-only acknowledgement proves that local packaged/raw members were
-- stripped only after a fresh generation-pinned, all-member restore.  GCS is
-- explicitly retained; this table has no delete outcome.
CREATE TABLE "solver_operational_canary_retention_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "canary_evidence_object_id" uuid NOT NULL UNIQUE
    REFERENCES "solver_operational_canary_evidence_objects"("id"),
  "outcome" text NOT NULL,
  "verification_mode" text NOT NULL,
  "verified_member_count" integer NOT NULL,
  "bytes_deleted" bigint NOT NULL,
  "receipt_sha256" text NOT NULL UNIQUE,
  "receipt_canonical" text NOT NULL,
  "receipt" jsonb NOT NULL,
  "executed_by" text NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_operational_canary_retention_outcome_check" CHECK (
    "outcome" IN ('local_evidence_stripped', 'already_remote_only')
  ),
  CONSTRAINT "solver_operational_canary_retention_identity_check" CHECK (
    "verification_mode" ~ '^archive[+]manifest[+]all-members-restore:[1-9][0-9]*$'
    AND "verified_member_count" > 0
    AND "bytes_deleted" >= 0
    AND "receipt_sha256" ~ '^[0-9a-f]{64}$'
    AND btrim("receipt_canonical") <> ''
    AND jsonb_typeof("receipt") = 'object'
    AND btrim("executed_by") <> ''
  )
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_operational_canary_evidence_registration()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approved_matches bigint;
  calculated_row_seal text;
  attested_matches bigint;
  runtime_matches bigint;
  source_owner_count bigint;
  artifact_owner_count bigint;
  blob_owner_count bigint;
  brokered_owner_count bigint;
  cleanup_owner_count bigint;
  expected_source_build text;
  expected_failure_phase text;
  expected_failure_exit integer;
BEGIN
  -- This is the exact lock used by 0079 cleanup and 0080 brokered upload.
  PERFORM lock_solver_canary_cleanup_identity(
    NEW."bucket", NEW."object_key", NEW."generation"
  );
  PERFORM lock_operational_canary_engine_job_identity(NEW."engine_job_id");

  IF NEW."solver_implementation_id" <>
       '2f8bc764-09ae-4ff3-8fd2-260600000001'::uuid THEN
    RAISE EXCEPTION 'operational canary evidence must be OpenCFD 2606';
  END IF;

  calculated_row_seal := encode(sha256(convert_to(concat_ws(E'\n',
    'opencfd2606-operational-canary-row-seal-v1',
    NEW."approved_inventory_sha256",
    NEW."provenance_kind",
    COALESCE(NEW."canary_attestation_id"::text, ''),
    NEW."solver_implementation_id"::text,
    NEW."solver_runtime_build_id"::text,
    NEW."engine_job_id",
    NEW."evidence_path",
    NEW."bucket",
    NEW."object_key",
    NEW."generation",
    NEW."stored_sha256",
    NEW."stored_byte_size"::text,
    NEW."crc32c",
    NEW."tar_sha256",
    NEW."tar_byte_size"::text,
    NEW."zstd_level"::text,
    NEW."pointer_sha256",
    NEW."pointer_byte_size"::text,
    NEW."manifest_sha256",
    NEW."manifest_byte_size"::text,
    NEW."archive_member_set_sha256",
    NEW."archive_member_count"::text,
    NEW."status_sha256",
    NEW."status_byte_size"::text,
    COALESCE(NEW."source_build_sha256", ''),
    COALESCE(NEW."source_build_byte_size"::text, ''),
    COALESCE(NEW."source_journal_sha256", ''),
    COALESCE(NEW."source_journal_byte_size"::text, ''),
    COALESCE(NEW."operator_receipt_sha256", ''),
    COALESCE(NEW."operator_receipt_byte_size"::text, ''),
    COALESCE(NEW."cutover_failure_phase", ''),
    COALESCE(NEW."cutover_failure_exit_code"::text, '')
  ), 'UTF8')), 'hex');

  SELECT count(*) INTO approved_matches
  FROM "solver_operational_canary_approved_inventory" approved
  WHERE approved."inventory_sha256" = NEW."approved_inventory_sha256"
    AND approved."engine_job_id" = NEW."engine_job_id"
    AND approved."evidence_path" = NEW."evidence_path"
    AND approved."bucket" = NEW."bucket"
    AND approved."object_key" = NEW."object_key"
    AND approved."generation" = NEW."generation"
    AND approved."row_seal_sha256" = calculated_row_seal;
  IF approved_matches <> 1 THEN
    RAISE EXCEPTION 'operational canary claim is outside or changes the sealed exact-16 inventory';
  END IF;

  SELECT count(*) INTO runtime_matches
  FROM "solver_runtime_builds" runtime
  JOIN "solver_implementations" implementation
    ON implementation."id" = runtime."solver_implementation_id"
  WHERE runtime."id" = NEW."solver_runtime_build_id"
    AND runtime."solver_implementation_id" = NEW."solver_implementation_id"
    AND implementation."family" = 'openfoam'
    AND implementation."distribution" = 'opencfd'
    AND implementation."release_version" = '2606'
    AND runtime."build_id" = NEW."registration_receipt" -> 'runtime' ->> 'buildId'
    AND runtime."source_revision" IS NOT DISTINCT FROM
      NULLIF(NEW."registration_receipt" -> 'runtime' ->> 'sourceRevision', '')
    AND runtime."image_digest" IS NOT DISTINCT FROM
      NULLIF(NEW."registration_receipt" -> 'runtime' ->> 'imageDigest', '')
    AND runtime."application_source_sha256" IS NOT DISTINCT FROM
      NULLIF(NEW."registration_receipt" -> 'runtime' ->> 'applicationSourceSha256', '')
    AND runtime."package_sha256" IS NOT DISTINCT FROM
      NULLIF(NEW."registration_receipt" -> 'runtime' ->> 'packageSha256', '')
    AND runtime."binary_sha256" IS NOT DISTINCT FROM
      NULLIF(NEW."registration_receipt" -> 'runtime' ->> 'binarySha256', '')
    AND runtime."architecture" IS NOT DISTINCT FROM
      NULLIF(NEW."registration_receipt" -> 'runtime' ->> 'architecture', '');
  IF runtime_matches <> 1 THEN
    RAISE EXCEPTION 'operational canary runtime receipt does not match one exact OpenCFD 2606 runtime build';
  END IF;

  IF NEW."registration_receipt" ->> 'schemaVersion' IS DISTINCT FROM '1'
     OR NEW."registration_receipt" ->> 'approvedInventorySha256'
       IS DISTINCT FROM NEW."approved_inventory_sha256"
     OR NEW."registration_receipt_canonical"::jsonb IS DISTINCT FROM
       NEW."registration_receipt"
     OR encode(sha256(convert_to(NEW."registration_receipt_canonical", 'UTF8')), 'hex')
       IS DISTINCT FROM NEW."registration_receipt_sha256"
     OR NEW."registration_receipt" ->> 'kind' IS DISTINCT FROM
       'opencfd2606-operational-canary-evidence-registration'
     OR NEW."registration_receipt" -> 'provenance' ->> 'kind' IS DISTINCT FROM
       NEW."provenance_kind"
     OR NEW."registration_receipt" -> 'runtime' ->> 'solverImplementationId'
       IS DISTINCT FROM NEW."solver_implementation_id"::text
     OR NEW."registration_receipt" -> 'runtime' ->> 'solverRuntimeBuildId'
       IS DISTINCT FROM NEW."solver_runtime_build_id"::text
     OR NEW."registration_receipt" -> 'job' ->> 'id' IS DISTINCT FROM
       NEW."engine_job_id"
     OR NEW."registration_receipt" -> 'job' ->> 'state' IS DISTINCT FROM
       'completed'
     OR NEW."registration_receipt" -> 'job' ->> 'statusSha256' IS DISTINCT FROM
       NEW."status_sha256"
     OR NEW."registration_receipt" -> 'job' ->> 'statusByteSize' IS DISTINCT FROM
       NEW."status_byte_size"::text
     OR NEW."registration_receipt" -> 'evidence' ->> 'path' IS DISTINCT FROM
       NEW."evidence_path"
     OR NEW."registration_receipt" -> 'evidence' ->> 'pointerSha256' IS DISTINCT FROM
       NEW."pointer_sha256"
     OR NEW."registration_receipt" -> 'evidence' ->> 'pointerByteSize' IS DISTINCT FROM
       NEW."pointer_byte_size"::text
     OR NEW."registration_receipt" -> 'evidence' ->> 'archiveSha256' IS DISTINCT FROM
       NEW."stored_sha256"
     OR NEW."registration_receipt" -> 'evidence' ->> 'archiveByteSize' IS DISTINCT FROM
       NEW."stored_byte_size"::text
     OR NEW."registration_receipt" -> 'evidence' ->> 'manifestSha256' IS DISTINCT FROM
       NEW."manifest_sha256"
     OR NEW."registration_receipt" -> 'evidence' ->> 'manifestByteSize' IS DISTINCT FROM
       NEW."manifest_byte_size"::text
     OR NEW."registration_receipt" -> 'evidence' ->> 'archiveMemberSetSha256' IS DISTINCT FROM
       NEW."archive_member_set_sha256"
     OR NEW."registration_receipt" -> 'evidence' ->> 'archiveMemberCount' IS DISTINCT FROM
       NEW."archive_member_count"::text
     OR NEW."registration_receipt" -> 'target' ->> 'bucket' IS DISTINCT FROM
       NEW."bucket"
     OR NEW."registration_receipt" -> 'target' ->> 'objectKey' IS DISTINCT FROM
       NEW."object_key"
     OR NEW."registration_receipt" -> 'target' ->> 'generation' IS DISTINCT FROM
       NEW."generation"
     OR NEW."registration_receipt" -> 'target' ->> 'storedSha256' IS DISTINCT FROM
       NEW."stored_sha256"
     OR NEW."registration_receipt" -> 'target' ->> 'storedByteSize' IS DISTINCT FROM
       NEW."stored_byte_size"::text
     OR NEW."registration_receipt" -> 'target' ->> 'crc32c' IS DISTINCT FROM
       NEW."crc32c"
     OR NEW."registration_receipt" -> 'target' ->> 'tarSha256' IS DISTINCT FROM
       NEW."tar_sha256"
     OR NEW."registration_receipt" -> 'target' ->> 'tarByteSize' IS DISTINCT FROM
       NEW."tar_byte_size"::text
     OR NEW."registration_receipt" -> 'target' ->> 'zstdLevel' IS DISTINCT FROM
       NEW."zstd_level"::text
     OR NEW."registration_receipt" ->> 'operator' IS DISTINCT FROM
       NEW."registered_by" THEN
    RAISE EXCEPTION 'operational canary registration receipt does not match its exact row';
  END IF;

  IF NEW."provenance_kind" = 'attested_canary' THEN
    IF NEW."registration_receipt" -> 'provenance' ->> 'attestationId'
         IS DISTINCT FROM NEW."canary_attestation_id"::text THEN
      RAISE EXCEPTION 'attested operational canary receipt has the wrong attestation';
    END IF;
    SELECT count(*) INTO attested_matches
    FROM "solver_engine_canary_attestations" attestation
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(attestation."receipt" -> 'jobs') = 'array'
        THEN attestation."receipt" -> 'jobs' ELSE '[]'::jsonb END
    ) job
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(job -> 'points') = 'array'
        THEN job -> 'points' ELSE '[]'::jsonb END
    ) point
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(point -> 'artifacts') = 'array'
        THEN point -> 'artifacts' ELSE '[]'::jsonb END
    ) artifact
    WHERE attestation."id" = NEW."canary_attestation_id"
      -- receipt_sha256 is the normalized database-semantic canonical JSON
      -- identity, intentionally distinct from the retained raw receipt hash.
      AND attestation."receipt_sha256" =
        'f6d17988ea40e96c885df709357806a097daa19948d8b02efc6df25e035f6149'
      AND attestation."solver_implementation_id" = NEW."solver_implementation_id"
      AND attestation."solver_runtime_build_id" = NEW."solver_runtime_build_id"
      AND attestation."receipt" ->> 'schema_version' = '1'
      AND attestation."receipt" ->> 'status' = 'ok'
      AND job ->> 'job_id' = NEW."engine_job_id"
      AND artifact ->> 'kind' = 'engine_bundle'
      AND artifact ->> 'sha256' = NEW."stored_sha256"
      AND artifact ->> 'byte_size' = NEW."stored_byte_size"::text
      AND artifact -> 'storage' ->> 'bucket' = NEW."bucket"
      AND artifact -> 'storage' ->> 'object_key' = NEW."object_key"
      AND artifact -> 'storage' ->> 'generation' = NEW."generation"
      AND artifact -> 'storage' ->> 'stored_sha256' = NEW."stored_sha256"
      AND artifact -> 'storage' ->> 'stored_byte_size' = NEW."stored_byte_size"::text
      AND artifact -> 'storage' ->> 'crc32c' = NEW."crc32c";
    IF attested_matches <> 1 THEN
      RAISE EXCEPTION 'attested operational canary object is absent or ambiguous in its durable attestation';
    END IF;
  ELSE
    expected_source_build := NEW."registration_receipt" -> 'provenance' -> 'sourceBuild' ->> 'buildId';
    expected_failure_phase := NEW."registration_receipt" -> 'provenance' -> 'failure' ->> 'phase';
    expected_failure_exit := (NEW."registration_receipt" -> 'provenance' -> 'failure' ->> 'exitCode')::integer;
    IF NEW."registration_receipt" -> 'provenance' -> 'sourceBuild' ->> 'sha256'
         IS DISTINCT FROM NEW."source_build_sha256"
       OR NEW."registration_receipt" -> 'provenance' -> 'sourceBuild' ->> 'byteSize'
         IS DISTINCT FROM NEW."source_build_byte_size"::text
       OR NEW."registration_receipt" -> 'provenance' -> 'sourceJournal' ->> 'sha256'
         IS DISTINCT FROM NEW."source_journal_sha256"
       OR NEW."registration_receipt" -> 'provenance' -> 'sourceJournal' ->> 'byteSize'
         IS DISTINCT FROM NEW."source_journal_byte_size"::text
       OR NEW."registration_receipt" -> 'provenance' -> 'operatorReceipt' ->> 'sha256'
         IS DISTINCT FROM NEW."operator_receipt_sha256"
       OR NEW."registration_receipt" -> 'provenance' -> 'operatorReceipt' ->> 'byteSize'
         IS DISTINCT FROM NEW."operator_receipt_byte_size"::text
       OR expected_failure_phase IS DISTINCT FROM NEW."cutover_failure_phase"
       OR expected_failure_exit IS DISTINCT FROM NEW."cutover_failure_exit_code"
       OR expected_source_build IS DISTINCT FROM
         NEW."registration_receipt" -> 'runtime' ->> 'buildId' THEN
      RAISE EXCEPTION 'unattested cutover canary lacks exact protected source provenance';
    END IF;
    IF NOT (
      (expected_source_build = 'prod-20260717-63385777be73-r2'
        AND expected_failure_phase = 'queue_probe_same_build_replay'
        AND expected_failure_exit = 14)
      OR (expected_source_build = 'prod-20260717-cd0967a1ba4e-r3'
        AND expected_failure_phase = 'retention_retry'
        AND expected_failure_exit = 14)
      OR (expected_source_build = 'prod-20260717-2ab861cb4ce6-r4'
        AND expected_failure_phase = 'transient_retention'
        AND expected_failure_exit = 137)
    ) THEN
      RAISE EXCEPTION 'unattested cutover canary source build/failure is not in the exact recovery allowlist';
    END IF;
  END IF;

  -- These directories were engine maintenance canaries, never sim_jobs.  A
  -- delayed ingest or any canonical/quarantine/brokered owner makes the claim
  -- unsafe.  The shared advisory lock closes the check/insert write-skew race.
  SELECT
    (SELECT count(*) FROM "sim_jobs" WHERE "engine_job_id" = NEW."engine_job_id")
    + (SELECT count(*) FROM "results" WHERE "engine_job_id" = NEW."engine_job_id")
    + (SELECT count(*) FROM "result_attempts" WHERE "engine_job_id" = NEW."engine_job_id")
  INTO source_owner_count;

  SELECT count(*) INTO blob_owner_count
  FROM "solver_evidence_blobs" blob
  WHERE blob."backend" = 'gcs'
    AND blob."bucket" = NEW."bucket"
    AND blob."object_key" = NEW."object_key"
    AND blob."generation" = NEW."generation";

  SELECT count(*) INTO artifact_owner_count
  FROM "solver_evidence_artifacts" artifact
  WHERE artifact."engine_job_id" = NEW."engine_job_id"
     OR (
       artifact."metadata" ->> 'storageBackend' = 'gcs'
       AND artifact."metadata" ->> 'bucket' = NEW."bucket"
       AND artifact."metadata" ->> 'objectKey' = NEW."object_key"
       AND artifact."metadata" ->> 'generation' = NEW."generation"
     ) OR (
       artifact."metadata" -> 'storage' ->> 'backend' = 'gcs'
       AND artifact."metadata" -> 'storage' ->> 'bucket' = NEW."bucket"
       AND artifact."metadata" -> 'storage' ->> 'object_key' = NEW."object_key"
       AND artifact."metadata" -> 'storage' ->> 'generation' = NEW."generation"
     );

  SELECT count(*) INTO brokered_owner_count
  FROM "sync_brokered_evidence_uploads" upload
  WHERE upload."bucket" = NEW."bucket"
    AND upload."object_key" = NEW."object_key"
    AND upload."generation" = NEW."generation";

  SELECT count(*) INTO cleanup_owner_count
  FROM "solver_canary_object_cleanup_reservations" cleanup
  WHERE cleanup."bucket" = NEW."bucket"
    AND cleanup."object_key" = NEW."object_key"
    AND cleanup."generation" = NEW."generation";

  IF source_owner_count <> 0 OR blob_owner_count <> 0
     OR artifact_owner_count <> 0 OR brokered_owner_count <> 0
     OR cleanup_owner_count <> 0 THEN
    RAISE EXCEPTION
      'operational canary evidence conflicts with existing ownership (source %, blob %, artifact %, brokered %, cleanup %)',
      source_owner_count, blob_owner_count, artifact_owner_count,
      brokered_owner_count, cleanup_owner_count;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_operational_canary_evidence_registration_guard"
BEFORE INSERT ON "solver_operational_canary_evidence_objects"
FOR EACH ROW EXECUTE FUNCTION validate_operational_canary_evidence_registration();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_operational_canary_retention_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owned "solver_operational_canary_evidence_objects"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT owned
  FROM "solver_operational_canary_evidence_objects"
  WHERE "id" = NEW."canary_evidence_object_id";

  IF jsonb_typeof(NEW."receipt" -> 'deletedPaths') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'operational canary retention deletedPaths must be an array';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW."receipt" -> 'deletedPaths') deleted(path)
    WHERE deleted.path NOT IN (
      'openfoam', 'time_directories', 'VTK', 'engine_evidence.tar.zst',
      'engine_evidence.tar.gz', 'openfoam_evidence.tar.gz'
    )
  ) THEN
    RAISE EXCEPTION 'operational canary retention receipt names an unsafe deleted path';
  END IF;
  IF (
    SELECT count(*) <> count(DISTINCT deleted.path)
    FROM jsonb_array_elements_text(NEW."receipt" -> 'deletedPaths') deleted(path)
  ) THEN
    RAISE EXCEPTION 'operational canary retention receipt repeats a deleted path';
  END IF;

  IF NEW."receipt" ->> 'schemaVersion' IS DISTINCT FROM '1'
     OR NEW."receipt_canonical"::jsonb IS DISTINCT FROM NEW."receipt"
     OR encode(sha256(convert_to(NEW."receipt_canonical", 'UTF8')), 'hex')
       IS DISTINCT FROM NEW."receipt_sha256"
     OR NEW."receipt" ->> 'kind' IS DISTINCT FROM
       'opencfd2606-operational-canary-local-retention-receipt'
     OR NEW."receipt" ->> 'ownershipId' IS DISTINCT FROM owned."id"::text
     OR NEW."receipt" ->> 'registrationReceiptSha256' IS DISTINCT FROM
       owned."registration_receipt_sha256"
     OR NEW."receipt" ->> 'outcome' IS DISTINCT FROM NEW."outcome"
     OR NEW."receipt" ->> 'verificationMode' IS DISTINCT FROM
       NEW."verification_mode"
     OR NEW."receipt" ->> 'verifiedMemberCount' IS DISTINCT FROM
       NEW."verified_member_count"::text
     OR NEW."receipt" ->> 'bytesDeleted' IS DISTINCT FROM
       NEW."bytes_deleted"::text
     OR NEW."receipt" ->> 'gcsDisposition' IS DISTINCT FROM
       'retained_exact_generation'
     OR NEW."receipt" -> 'target' ->> 'bucket' IS DISTINCT FROM owned."bucket"
     OR NEW."receipt" -> 'target' ->> 'objectKey' IS DISTINCT FROM owned."object_key"
     OR NEW."receipt" -> 'target' ->> 'generation' IS DISTINCT FROM owned."generation"
     OR NEW."receipt" -> 'target' ->> 'storedSha256' IS DISTINCT FROM owned."stored_sha256"
     OR NEW."receipt" -> 'target' ->> 'storedByteSize' IS DISTINCT FROM owned."stored_byte_size"::text
     OR NEW."receipt" -> 'target' ->> 'crc32c' IS DISTINCT FROM owned."crc32c"
     OR NEW."receipt" ->> 'operator' IS DISTINCT FROM NEW."executed_by"
     OR (NEW."receipt" ->> 'verifiedAt')::timestamptz IS DISTINCT FROM NEW."verified_at"
     OR NEW."verified_member_count" <> owned."archive_member_count" - 1
     OR NEW."verification_mode" <> 'archive+manifest+all-members-restore:' || (owned."archive_member_count" - 1)::text
     OR (NEW."outcome" = 'local_evidence_stripped' AND (
       NEW."bytes_deleted" <= 0
       OR jsonb_array_length(NEW."receipt" -> 'deletedPaths') = 0
     ))
     OR (NEW."outcome" = 'already_remote_only' AND (
       NEW."bytes_deleted" <> 0
       OR jsonb_array_length(NEW."receipt" -> 'deletedPaths') <> 0
     )) THEN
    RAISE EXCEPTION 'operational canary retention receipt does not match its exact immutable ownership';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_operational_canary_retention_receipt_guard"
BEFORE INSERT ON "solver_operational_canary_retention_receipts"
FOR EACH ROW EXECUTE FUNCTION validate_operational_canary_retention_receipt();
--> statement-breakpoint

-- Reciprocal fences: once operational ownership wins, no cleanup, canonical
-- evidence row, or brokered remote upload may adopt the generation.  Each
-- side takes the same transaction-scoped advisory identity lock first.
CREATE OR REPLACE FUNCTION reject_reserved_operational_canary_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_bucket text;
  target_key text;
  target_generation text;
BEGIN
  IF TG_TABLE_NAME = 'solver_evidence_blobs' THEN
    IF NEW."backend" <> 'gcs' THEN RETURN NEW; END IF;
    target_bucket := NEW."bucket";
    target_key := NEW."object_key";
    target_generation := NEW."generation";
  ELSIF TG_TABLE_NAME = 'solver_canary_object_cleanup_reservations' THEN
    target_bucket := NEW."bucket";
    target_key := NEW."object_key";
    target_generation := NEW."generation";
  ELSIF TG_TABLE_NAME = 'sync_brokered_evidence_uploads' THEN
    IF NEW."generation" IS NULL THEN RETURN NEW; END IF;
    target_bucket := NEW."bucket";
    target_key := NEW."object_key";
    target_generation := NEW."generation";
  ELSE
    RAISE EXCEPTION 'unexpected operational canary fence table %', TG_TABLE_NAME;
  END IF;

  PERFORM lock_solver_canary_cleanup_identity(
    target_bucket, target_key, target_generation
  );
  IF EXISTS (
    SELECT 1 FROM "solver_operational_canary_evidence_objects" owned
    WHERE owned."bucket" = target_bucket
      AND owned."object_key" = target_key
      AND owned."generation" = target_generation
  ) THEN
    RAISE EXCEPTION 'GCS generation is immutable operational canary evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_blobs_operational_canary_fence"
BEFORE INSERT OR UPDATE OF "backend", "bucket", "object_key", "generation"
ON "solver_evidence_blobs"
FOR EACH ROW EXECUTE FUNCTION reject_reserved_operational_canary_identity();
--> statement-breakpoint
CREATE TRIGGER "solver_canary_cleanup_operational_evidence_fence"
BEFORE INSERT OR UPDATE ON "solver_canary_object_cleanup_reservations"
FOR EACH ROW EXECUTE FUNCTION reject_reserved_operational_canary_identity();
--> statement-breakpoint
CREATE TRIGGER "sync_brokered_upload_operational_canary_fence"
BEFORE INSERT OR UPDATE OF "bucket", "object_key", "generation"
ON "sync_brokered_evidence_uploads"
FOR EACH ROW EXECUTE FUNCTION reject_reserved_operational_canary_identity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_source_owner_for_operational_canary_job()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."engine_job_id" IS NOT DISTINCT FROM OLD."engine_job_id" THEN
    RETURN NEW;
  END IF;
  IF NEW."engine_job_id" IS NULL THEN RETURN NEW; END IF;
  PERFORM lock_operational_canary_engine_job_identity(NEW."engine_job_id");
  IF EXISTS (
    SELECT 1 FROM "solver_operational_canary_evidence_objects" owned
    WHERE owned."engine_job_id" = NEW."engine_job_id"
  ) THEN
    RAISE EXCEPTION 'engine job is immutable operational canary evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sim_jobs_operational_canary_job_fence"
BEFORE INSERT OR UPDATE OF "engine_job_id" ON "sim_jobs"
FOR EACH ROW EXECUTE FUNCTION reject_source_owner_for_operational_canary_job();
--> statement-breakpoint
CREATE TRIGGER "results_operational_canary_job_fence"
BEFORE INSERT OR UPDATE OF "engine_job_id" ON "results"
FOR EACH ROW EXECUTE FUNCTION reject_source_owner_for_operational_canary_job();
--> statement-breakpoint
CREATE TRIGGER "result_attempts_operational_canary_job_fence"
BEFORE INSERT OR UPDATE OF "engine_job_id" ON "result_attempts"
FOR EACH ROW EXECUTE FUNCTION reject_source_owner_for_operational_canary_job();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_artifact_for_operational_canary_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  top_bucket text;
  top_key text;
  top_generation text;
  nested_bucket text;
  nested_key text;
  nested_generation text;
BEGIN
  IF NEW."metadata" ->> 'storageBackend' = 'gcs' THEN
    top_bucket := NEW."metadata" ->> 'bucket';
    top_key := NEW."metadata" ->> 'objectKey';
    top_generation := NEW."metadata" ->> 'generation';
  END IF;
  IF NEW."metadata" -> 'storage' ->> 'backend' = 'gcs' THEN
    nested_bucket := NEW."metadata" -> 'storage' ->> 'bucket';
    nested_key := NEW."metadata" -> 'storage' ->> 'object_key';
    nested_generation := NEW."metadata" -> 'storage' ->> 'generation';
  END IF;
  IF top_bucket IS NOT NULL AND nested_bucket IS NOT NULL
     AND ROW(top_bucket, top_key, top_generation)
       IS DISTINCT FROM ROW(nested_bucket, nested_key, nested_generation) THEN
    RAISE EXCEPTION 'artifact has conflicting dual GCS storage identities';
  END IF;

  top_bucket := COALESCE(top_bucket, nested_bucket);
  top_key := COALESCE(top_key, nested_key);
  top_generation := COALESCE(top_generation, nested_generation);
  IF top_bucket IS NOT NULL THEN
    PERFORM lock_solver_canary_cleanup_identity(top_bucket, top_key, top_generation);
  END IF;
  IF NEW."engine_job_id" IS NOT NULL THEN
    PERFORM lock_operational_canary_engine_job_identity(NEW."engine_job_id");
  END IF;
  IF EXISTS (
    SELECT 1 FROM "solver_operational_canary_evidence_objects" owned
    WHERE (
      top_bucket IS NOT NULL
      AND owned."bucket" = top_bucket
      AND owned."object_key" = top_key
      AND owned."generation" = top_generation
    ) OR (
      NEW."engine_job_id" IS NOT NULL
      AND owned."engine_job_id" = NEW."engine_job_id"
    )
  ) THEN
    RAISE EXCEPTION 'GCS generation is immutable operational canary evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_evidence_artifacts_operational_canary_fence"
BEFORE INSERT OR UPDATE OF "metadata", "engine_job_id" ON "solver_evidence_artifacts"
FOR EACH ROW EXECUTE FUNCTION reject_artifact_for_operational_canary_identity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_operational_canary_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operational canary evidence audit rows are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_operational_canary_evidence_immutable"
BEFORE UPDATE OR DELETE ON "solver_operational_canary_evidence_objects"
FOR EACH ROW EXECUTE FUNCTION reject_operational_canary_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER "solver_operational_canary_approved_inventory_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "solver_operational_canary_approved_inventory"
FOR EACH ROW EXECUTE FUNCTION reject_operational_canary_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER "solver_operational_canary_retention_immutable"
BEFORE UPDATE OR DELETE ON "solver_operational_canary_retention_receipts"
FOR EACH ROW EXECUTE FUNCTION reject_operational_canary_audit_mutation();
