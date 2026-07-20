import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { databaseUrl } from "../src/env";
import * as schema from "../src/schema";
import type { DB } from "../src/client";

process.env.ENGINE_CONTROL_PLANE_TOKEN =
  "broker-test-control-plane-token-32-bytes";
process.env.AIRFOILFOAM_EVIDENCE_BUCKET = "broker-canary-test";
process.env.ENGINE_URL = "http://engine-broker.test";
process.env.REMOTE_EVIDENCE_MAX_ACTIVE_UPLOADS_PER_SOLVER = "1";
const {
  expireBrokeredEvidenceUploads,
  fetchBoundBrokeredEvidenceArchive,
  requestBrokeredEvidenceUpload,
  revokeSolverEvidenceUploads,
  verifyBrokeredEvidenceUpload,
} = await import("../../../apps/api/src/remote-evidence-broker");

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const dbName = `aerodb_broker_canary_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

let admin: ReturnType<typeof postgres> | null = null;
let setup: ReturnType<typeof postgres> | null = null;
let database: DB | null = null;

const id = {
  solver: "80000000-0000-4000-8000-000000000001",
  promise: "80000000-0000-4000-8000-000000000002",
  point: "80000000-0000-4000-8000-000000000003",
  upload: "80000000-0000-4000-8000-000000000004",
  attestation: "80000000-0000-4000-8000-000000000005",
  airfoil: "80000000-0000-4000-8000-000000000006",
  revision: "80000000-0000-4000-8000-000000000007",
};
const sha = "8".repeat(64);
const tarSha = "9".repeat(64);
const manifestSha = "a".repeat(64);
const bucket = "broker-canary-test";
const key = `solver-evidence/v1/sha256/${sha.slice(0, 2)}/${sha}.tar.zst`;
const generation = "9007199254740993123";
const reservedGeneration = "9007199254740993124";

function resumableUrl(objectKey: string, uploadId: string): string {
  const query = new URLSearchParams({
    uploadType: "resumable",
    name: objectKey,
    upload_id: uploadId,
    ifGenerationMatch: "0",
  });
  return `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?${query.toString()}`;
}

function enginePath(input: string | URL | Request): string {
  return new URL(String(input)).pathname;
}

function parsedJsonBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function receipt() {
  return JSON.stringify({
    schema_version: 1,
    status: "ok",
    engine: { family: "openfoam", distribution: "opencfd", version: "2606" },
    evidence_storage: {
      backend: "gcs",
      bucket,
      archive_format: "tar+zstd",
      compression: "zstd",
      local_disposition: "remote-only",
    },
    jobs: [
      {
        points: [
          {
            artifacts: [
              {
                kind: "engine_bundle",
                sha256: sha,
                byte_size: "4096",
                storage: {
                  bucket,
                  object_key: key,
                  generation,
                  stored_sha256: sha,
                  stored_byte_size: "4096",
                  crc32c: "ImIEBA==",
                },
              },
              {
                kind: "engine_bundle",
                sha256: sha,
                byte_size: "4096",
                storage: {
                  bucket,
                  object_key: key,
                  generation: reservedGeneration,
                  stored_sha256: sha,
                  stored_byte_size: "4096",
                  crc32c: "ImIEBA==",
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  setup = postgres(targetUrl.toString(), { max: 1 });
  await migrate(drizzle(setup), { migrationsFolder: migrations });
  database = drizzle(setup, { schema }) as unknown as DB;
  await setup.unsafe("SET session_replication_role = replica");
  await setup.unsafe(`
    INSERT INTO registered_remote_solvers
      (id, instance_id, instance_name, auth_token_hash, credential_version)
    VALUES ('${id.solver}', 'remote-fence-instance', 'Remote fence', '${"b".repeat(64)}', 1);
    INSERT INTO sync_sweep_promises
      (id, source_instance_id, airfoil_id, simulation_preset_revision_id,
       aoa_count, "expiresAt", request_payload)
    VALUES ('${id.promise}', 'remote-fence-instance', '${id.airfoil}', '${id.revision}',
            1, now() + interval '1 day', '{"solverId":"${id.solver}"}'::jsonb);
    INSERT INTO sync_sweep_promise_points
      (id, promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
    VALUES ('${id.point}', '${id.promise}', '${id.airfoil}', '${id.revision}', 3);
    INSERT INTO sync_brokered_evidence_uploads
      (id, idempotency_key, promise_id, promise_point_id, solver_id,
       source_instance_id, remote_result_id, remote_result_attempt_id, aoa_deg,
       engine_job_id, engine_case_slug, bucket, object_key, stored_sha256,
       stored_byte_size, tar_sha256, tar_byte_size, manifest_sha256,
       manifest_byte_size, zstd_level, bundled_file_count, state,
       upload_url, upload_expires_at)
    VALUES ('${id.upload}', '80000000-0000-4000-8000-000000000008', '${id.promise}',
            '${id.point}', '${id.solver}', 'remote-fence-instance',
            '80000000-0000-4000-8000-000000000009',
            '80000000-0000-4000-8000-00000000000a', 3, 'job-1', 'case-1',
            '${bucket}', '${key}', '${sha}', 4096, '${tarSha}', 8192,
            '${manifestSha}', 1024, 7, 3, 'issued',
            '${resumableUrl(key, "fixture-1")}', now() + interval '1 day');
    INSERT INTO sync_brokered_evidence_uploads
      (id, idempotency_key, promise_id, promise_point_id, solver_id,
       source_instance_id, remote_result_id, remote_result_attempt_id, aoa_deg,
       engine_job_id, engine_case_slug, bucket, object_key, stored_sha256,
       stored_byte_size, tar_sha256, tar_byte_size, manifest_sha256,
       manifest_byte_size, zstd_level, bundled_file_count, state,
       upload_url, upload_expires_at)
    VALUES ('80000000-0000-4000-8000-000000000010',
            '80000000-0000-4000-8000-000000000011', '${id.promise}',
            '${id.point}', '${id.solver}', 'remote-fence-instance',
            '80000000-0000-4000-8000-000000000012',
            '80000000-0000-4000-8000-000000000013', 3, 'job-2', 'case-2',
            '${bucket}', '${key}', '${sha}', 4096, '${tarSha}', 8192,
            '${manifestSha}', 1024, 7, 3, 'issued',
            '${resumableUrl(key, "fixture-2")}', now() + interval '1 day');
    INSERT INTO solver_engine_canary_attestations
      (id, solver_implementation_id, solver_runtime_build_id,
       solver_execution_pool_id, receipt_sha256, receipt, attested_by)
    VALUES ('${id.attestation}', '2f8bc764-09ae-4ff3-8fd2-260600000001',
            '80000000-0000-4000-8000-00000000000b',
            '80000000-0000-4000-8000-00000000000c', '${"c".repeat(64)}',
            '${receipt().replaceAll("'", "''")}'::jsonb, 'test');
  `);
  await setup.unsafe("SET session_replication_role = origin");
}, 120_000);

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await setup?.end({ timeout: 1 });
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end({ timeout: 1 });
  }
}, 120_000);

describe("0080 brokered evidence / 0079 canary cleanup reciprocal fence", () => {
  it("keeps 0080 fail-closed and adds only acknowledged expired retries in 0082", () => {
    const migration0080 = readFileSync(
      resolve(migrations, "0080_brokered_remote_evidence_uploads.sql"),
      "utf8",
    );
    const migration0082 = readFileSync(
      resolve(migrations, "0082_remote_hub_binding_receipts.sql"),
      "utf8",
    );
    const migration0085 = readFileSync(
      resolve(migrations, "0085_settled_legacy_evidence_upgrade.sql"),
      "utf8",
    );
    expect(migration0080).toMatch(
      /sync_brokered_evidence_uploads_promise_fk[\s\S]*?sync_sweep_promises[\s\S]*?ON DELETE restrict/i,
    );
    expect(migration0080).toMatch(
      /sync_brokered_evidence_uploads_promise_point_fk[\s\S]*?sync_sweep_promise_points[\s\S]*?ON DELETE restrict/i,
    );
    expect(migration0080).not.toMatch(
      /sync_brokered_evidence_uploads_(?:promise|promise_point)_fk[\s\S]{0,180}ON DELETE cascade/i,
    );
    expect(migration0082).not.toMatch(
      /DROP CONSTRAINT\s+"sync_brokered_evidence_uploads_(?:promise|promise_point)_fk"/i,
    );
    expect(migration0080).not.toContain("expired_retry");
    expect(migration0082).toMatch(
      /expired_retry[\s\S]*?OLD\.session_cancellation_acknowledged_at IS NOT NULL[\s\S]*?NEW\.attempt_count = OLD\.attempt_count \+ 1/i,
    );
    expect(migration0085).toMatch(
      /result\.current_result_attempt_id = point\.result_attempt_id[\s\S]*?point\.status = 'fulfilled'[\s\S]*?attempt\.valid_for_polar/i,
    );
    expect(migration0085).toMatch(
      /manifest\.sha256 = candidate\.manifest_sha256[\s\S]*?legacy\.mime_type = 'application\/gzip'[\s\S]*?superseding\.kind::text = 'engine_bundle'/i,
    );
    expect(migration0085).toMatch(
      /AND NOT settled_legacy_upgrade[\s\S]*?requires an active promise lease[\s\S]*?AND NOT settled_legacy_upgrade[\s\S]*?requires an active promise point/i,
    );
  });

  it("keeps remote delivery promise ownership RESTRICT after the full migration chain", async () => {
    const constraints = await setup!<{ confdeltype: string }[]>`
      SELECT constraint_row.confdeltype
      FROM pg_constraint constraint_row
      JOIN pg_class owner ON owner.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = owner.relnamespace
      WHERE constraint_row.contype = 'f'
        AND namespace.nspname = current_schema()
        AND owner.relname = 'sync_remote_result_deliveries'
        AND constraint_row.conname = 'sync_remote_result_deliveries_promise_id_fk'
    `;

    expect(constraints).toEqual([{ confdeltype: "r" }]);
  });

  it("upgrades one exact fulfilled legacy gzip generation after its parent lease closes", async () => {
    if (!setup || !database)
      throw new Error("isolated broker database is unavailable");
    const solverId = "81000000-0000-4000-8000-000000000001";
    const promiseId = "81000000-0000-4000-8000-000000000002";
    const pointId = "81000000-0000-4000-8000-000000000003";
    const resultId = "81000000-0000-4000-8000-000000000004";
    const attemptId = "81000000-0000-4000-8000-000000000005";
    const manifestId = "81000000-0000-4000-8000-000000000006";
    const gzipId = "81000000-0000-4000-8000-000000000007";
    const sourceInstanceId = "settled-legacy-instance";
    const engineJobId = "job-settled-legacy";
    const engineCaseSlug = "case-settled-legacy";
    const request = {
      idempotencyKey: "81000000-0000-4000-8000-000000000008",
      promiseId,
      remoteResultId: "81000000-0000-4000-8000-000000000009",
      remoteResultAttemptId: "81000000-0000-4000-8000-00000000000a",
      aoaDeg: 18,
      engineJobId,
      engineCaseSlug,
      storedSha256: "d".repeat(64),
      storedByteSize: 4096,
      tarSha256: "e".repeat(64),
      tarByteSize: 8192,
      manifestSha256: "c".repeat(64),
      manifestByteSize: 1024,
      zstdLevel: 10,
      bundledFileCount: 3,
    };
    await setup.unsafe("SET session_replication_role = replica");
    await setup.unsafe(`
      INSERT INTO registered_remote_solvers
        (id, instance_id, instance_name, auth_token_hash, credential_version)
      VALUES ('${solverId}', '${sourceInstanceId}', 'Settled legacy solver',
              '${"7".repeat(64)}', 1);
      INSERT INTO sync_sweep_promises
        (id, source_instance_id, airfoil_id, simulation_preset_revision_id,
         aoa_count, status, "expiresAt", "cancelledAt", request_payload)
      VALUES ('${promiseId}', '${sourceInstanceId}', '${id.airfoil}', '${id.revision}',
              1, 'cancelled', now() - interval '1 day', now(),
              '{"solverId":"${solverId}"}'::jsonb);
      INSERT INTO results
        (id, current_result_attempt_id, airfoil_id, bc_id,
         simulation_preset_revision_id, aoa_deg, status, source, regime)
      VALUES ('${resultId}', '${attemptId}', '${id.airfoil}', '${id.airfoil}',
              '${id.revision}', 18, 'done', 'solved', 'rans');
      INSERT INTO result_attempts
        (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id,
         aoa_deg, engine_job_id, engine_case_slug, status, source,
         valid_for_polar, regime)
      VALUES ('${attemptId}', '${resultId}', '${id.airfoil}', '${id.airfoil}',
              '${id.revision}', 18,
              'sync:${sourceInstanceId}:${engineJobId}', '${engineCaseSlug}',
              'done', 'solved', true, 'rans');
      INSERT INTO sync_sweep_promise_points
        (id, promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
         status, result_id, result_attempt_id)
      VALUES ('${pointId}', '${promiseId}', '${id.airfoil}', '${id.revision}',
              18, 'fulfilled', '${resultId}', '${attemptId}');
      INSERT INTO solver_evidence_artifacts
        (id, result_id, result_attempt_id, airfoil_id, engine_job_id,
         engine_case_slug, aoa_deg, kind, storage_key, mime_type, sha256,
         byte_size)
      VALUES
        ('${manifestId}', '${resultId}', '${attemptId}', '${id.airfoil}',
         'sync:${sourceInstanceId}:${engineJobId}', '${engineCaseSlug}', 18,
         'manifest', 'sync-imports/cc/${request.manifestSha256}.json',
         'application/json', '${request.manifestSha256}',
         ${request.manifestByteSize}),
        ('${gzipId}', '${resultId}', '${attemptId}', '${id.airfoil}',
         'sync:${sourceInstanceId}:${engineJobId}', '${engineCaseSlug}', 18,
         'openfoam_bundle', 'sync-imports/aa/${"a".repeat(64)}.gz',
         'application/gzip', '${"a".repeat(64)}', 12288);
    `);
    await setup.unsafe("SET session_replication_role = origin");
    const [solver] = await database
      .select()
      .from(schema.registeredRemoteSolvers)
      .where(eq(schema.registeredRemoteSolvers.id, solverId));
    if (!solver) throw new Error("settled legacy solver fixture disappeared");

    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = enginePath(input);
        if (path.endsWith("/session")) {
          const body = parsedJsonBody(init);
          return Response.json({
            state: "issued",
            uploadUrl: resumableUrl(
              String(body.objectKey),
              "settled-legacy-upgrade",
            ),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        if (path.endsWith("/session-settled"))
          return Response.json({ state: "registered" });
        if (path.endsWith("/cancel-identity"))
          return Response.json({ state: "cancelled", statusCode: 499 });
        return Response.json({ detail: "unexpected route" }, { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const issued = await requestBrokeredEvidenceUpload(
      database,
      solver,
      request,
    );
    expect(issued.state).toBe("issued");
    await expireBrokeredEvidenceUploads(database);
    const [retained] = await setup<{ state: string }[]>`
      SELECT state FROM sync_brokered_evidence_uploads
      WHERE id=${issued.id}::uuid
    `;
    expect(retained.state).toBe("issued");

    const callsBeforeMismatch = fetchMock.mock.calls.length;
    await expect(
      requestBrokeredEvidenceUpload(database, solver, {
        ...request,
        idempotencyKey: "81000000-0000-4000-8000-00000000000b",
        remoteResultAttemptId: "81000000-0000-4000-8000-00000000000c",
        manifestSha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/neither active work nor an eligible settled legacy/);
    await expect(
      requestBrokeredEvidenceUpload(database, solver, {
        ...request,
        idempotencyKey: "81000000-0000-4000-8000-00000000000d",
        remoteResultAttemptId: "81000000-0000-4000-8000-00000000000e",
        engineJobId: "different-job",
      }),
    ).rejects.toThrow(/neither active work nor an eligible settled legacy/);
    expect(fetchMock.mock.calls).toHaveLength(callsBeforeMismatch);
  });

  it("serializes both owners on the same advisory identity and rejects the loser", async () => {
    const owner = postgres(targetUrl.toString(), { max: 1 });
    const cleanup = postgres(targetUrl.toString(), { max: 1 });
    let releaseOwner!: () => void;
    const holdOwner = new Promise<void>((resolve) => (releaseOwner = resolve));
    let ownerLocked!: () => void;
    const ownerHasLock = new Promise<void>(
      (resolve) => (ownerLocked = resolve),
    );

    const ownerTx = owner.begin(async (tx) => {
      await tx.unsafe(`
        UPDATE sync_brokered_evidence_uploads
        SET state='verifying', claim_token='80000000-0000-4000-8000-00000000000d',
            claim_expires_at=now() + interval '5 minutes'
        WHERE id='${id.upload}';
        UPDATE sync_brokered_evidence_uploads
        SET state='verified', claim_token=NULL, claim_expires_at=NULL,
            upload_url=NULL, upload_expires_at=NULL, generation='${generation}',
            crc32c='ImIEBA==', verified_at=now()
        WHERE id='${id.upload}';
      `);
      ownerLocked();
      await holdOwner;
    });
    await ownerHasLock;

    let cleanupSettled = false;
    const cleanupTx = cleanup
      .unsafe(
        `
        INSERT INTO solver_canary_object_cleanup_reservations
          (canary_attestation_id, bucket, object_key, generation, sha256,
           byte_size, crc32c, reserved_by)
        VALUES ('${id.attestation}', '${bucket}', '${key}', '${generation}',
                '${sha}', 4096, 'ImIEBA==', 'test')
      `,
      )
      .finally(() => {
        cleanupSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cleanupSettled).toBe(false);

    releaseOwner();
    await ownerTx;
    await expect(cleanupTx).rejects.toThrow(
      /cannot reserve a canonical brokered evidence generation/,
    );
    await owner.end({ timeout: 1 });
    await cleanup.end({ timeout: 1 });

    await setup!.unsafe(`
      INSERT INTO solver_canary_object_cleanup_reservations
        (canary_attestation_id, bucket, object_key, generation, sha256,
         byte_size, crc32c, reserved_by)
      VALUES ('${id.attestation}', '${bucket}', '${key}', '${reservedGeneration}',
              '${sha}', 4096, 'ImIEBA==', 'test')
    `);
    await expect(
      setup!.unsafe(`
        UPDATE sync_brokered_evidence_uploads
        SET state='verifying', claim_token='80000000-0000-4000-8000-000000000014',
            claim_expires_at=now() + interval '5 minutes'
        WHERE id='80000000-0000-4000-8000-000000000010';
        UPDATE sync_brokered_evidence_uploads
        SET state='verified', claim_token=NULL, claim_expires_at=NULL,
            upload_url=NULL, upload_expires_at=NULL, generation='${reservedGeneration}',
            crc32c='ImIEBA==', verified_at=now()
        WHERE id='80000000-0000-4000-8000-000000000010';
      `),
    ).rejects.toThrow(/reserved for canary cleanup/);
    const [stillIssued] = await setup!<{ state: string }[]>`
      SELECT state FROM sync_brokered_evidence_uploads
      WHERE id='80000000-0000-4000-8000-000000000010'::uuid
    `;
    expect(stillIssued.state).toBe("issued");
  });

  it("reissues one acknowledged expired attempt without weakening live ownership", async () => {
    if (!setup || !database)
      throw new Error("isolated broker database is unavailable");
    const solverId = "80000000-0000-4000-8000-000000000070";
    const promiseId = "80000000-0000-4000-8000-000000000071";
    const pointId = "80000000-0000-4000-8000-000000000072";
    await setup.unsafe("SET session_replication_role = replica");
    await setup.unsafe(`
      INSERT INTO registered_remote_solvers
        (id, instance_id, instance_name, auth_token_hash, credential_version)
      VALUES ('${solverId}', 'remote-reissue-instance', 'Remote reissue',
              '${"4".repeat(64)}', 1);
      INSERT INTO sync_sweep_promises
        (id, source_instance_id, airfoil_id, simulation_preset_revision_id,
         aoa_count, "expiresAt", request_payload)
      VALUES ('${promiseId}', 'remote-reissue-instance', '${id.airfoil}', '${id.revision}',
              1, now() + interval '1 day', '{"solverId":"${solverId}"}'::jsonb);
      INSERT INTO sync_sweep_promise_points
        (id, promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
      VALUES ('${pointId}', '${promiseId}', '${id.airfoil}', '${id.revision}', 8);
    `);
    await setup.unsafe("SET session_replication_role = origin");
    const [solver] = await database
      .select()
      .from(schema.registeredRemoteSolvers)
      .where(eq(schema.registeredRemoteSolvers.id, solverId));
    if (!solver) throw new Error("remote reissue solver fixture disappeared");

    let sessionRequests = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = enginePath(input);
        if (path.endsWith("/session")) {
          sessionRequests += 1;
          const body = parsedJsonBody(init);
          return Response.json({
            state: "issued",
            uploadUrl: resumableUrl(
              String(body.objectKey),
              `same-attempt-${sessionRequests}`,
            ),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        if (path.endsWith("/cancel-identity"))
          return Response.json({ state: "cancelled", statusCode: 499 });
        if (path.endsWith("/session-settled"))
          return Response.json({ state: "settled" });
        return Response.json(
          { detail: "unexpected reissue test route" },
          { status: 404 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      idempotencyKey: "80000000-0000-4000-8000-000000000073",
      promiseId,
      remoteResultId: "80000000-0000-4000-8000-000000000074",
      remoteResultAttemptId: "80000000-0000-4000-8000-000000000075",
      aoaDeg: 8,
      engineJobId: "job-same-attempt-reissue",
      engineCaseSlug: "case-same-attempt-reissue",
      storedSha256: "4".repeat(64),
      storedByteSize: 2048,
      tarSha256: "5".repeat(64),
      tarByteSize: 4096,
      manifestSha256: "6".repeat(64),
      manifestByteSize: 512,
      zstdLevel: 7,
      bundledFileCount: 2,
    };
    const first = await requestBrokeredEvidenceUpload(
      database,
      solver,
      request,
    );
    expect(first).toMatchObject({
      state: "issued",
      uploadUrl: expect.stringContaining("same-attempt-1"),
    });
    await setup`
      UPDATE sync_brokered_evidence_uploads
      SET upload_expires_at=now() - interval '1 second'
      WHERE id=${first.id}::uuid
    `;
    await expireBrokeredEvidenceUploads(database);
    const [expired] = await setup<
      {
        id: string;
        state: string;
        attempt_count: number;
        upload_url: string | null;
        upload_expires_at: string | null;
        session_cancellation_acknowledged_at: string | null;
      }[]
    >`
      SELECT id, state, attempt_count, upload_url, upload_expires_at,
             session_cancellation_acknowledged_at
      FROM sync_brokered_evidence_uploads
      WHERE id=${first.id}::uuid
    `;
    expect(expired).toMatchObject({
      id: first.id,
      state: "expired",
      attempt_count: 1,
      upload_url: null,
      upload_expires_at: null,
    });
    expect(expired.session_cancellation_acknowledged_at).not.toBeNull();

    const directReissue = () =>
      setup!.unsafe(`
        UPDATE sync_brokered_evidence_uploads
        SET state='issuing', attempt_count=attempt_count + 1,
            claim_token='80000000-0000-4000-8000-000000000076',
            claim_expires_at=now() + interval '5 minutes',
            session_cancellation_acknowledged_at=NULL
        WHERE id='${first.id}'
      `);
    const readRetryState = async () => {
      const [state] = await setup!.unsafe<
        {
          state: string;
          attempt_count: number;
          session_cancellation_acknowledged_at: string | null;
          upload_url: string | null;
          upload_expires_at: string | null;
        }[]
      >(`
        SELECT state, attempt_count, session_cancellation_acknowledged_at,
               upload_url, upload_expires_at
        FROM sync_brokered_evidence_uploads
        WHERE id='${first.id}'
      `);
      return state;
    };

    await setup`
      UPDATE sync_brokered_evidence_uploads
      SET session_cancellation_acknowledged_at=NULL
      WHERE id=${first.id}::uuid
    `;
    const beforeRejectedRetry = await readRetryState();
    await expect(directReissue()).rejects.toThrow(
      /illegal brokered evidence upload state transition: expired -> issuing/,
    );
    expect(await readRetryState()).toEqual(beforeRejectedRetry);
    await setup`
      UPDATE sync_brokered_evidence_uploads
      SET session_cancellation_acknowledged_at=now()
      WHERE id=${first.id}::uuid
    `;

    await setup`
      UPDATE sync_sweep_promises SET "expiresAt"=now() - interval '1 second'
      WHERE id=${promiseId}::uuid
    `;
    await expect(directReissue()).rejects.toThrow(
      /requires an active promise lease/,
    );
    await setup`
      UPDATE sync_sweep_promises
      SET "expiresAt"=now() + interval '1 day'
      WHERE id=${promiseId}::uuid
    `;

    await setup`
      UPDATE sync_sweep_promise_points SET status='cancelled'
      WHERE id=${pointId}::uuid
    `;
    await expect(directReissue()).rejects.toThrow(
      /requires an active promise point/,
    );
    await setup`
      UPDATE sync_sweep_promise_points SET status='active'
      WHERE id=${pointId}::uuid
    `;

    const second = await requestBrokeredEvidenceUpload(
      database,
      solver,
      request,
    );
    expect(second).toMatchObject({
      id: first.id,
      state: "issued",
      uploadUrl: expect.stringContaining("same-attempt-2"),
    });
    const [reissued] = await setup<
      {
        state: string;
        attempt_count: number;
        session_cancellation_acknowledged_at: string | null;
        n: number;
      }[]
    >`
      SELECT upload.state, upload.attempt_count,
             upload.session_cancellation_acknowledged_at,
             count(*) OVER ()::int AS n
      FROM sync_brokered_evidence_uploads upload
      WHERE upload.promise_id=${promiseId}::uuid
        AND upload.solver_id=${solverId}::uuid
        AND upload.remote_result_attempt_id=${request.remoteResultAttemptId}::uuid
    `;
    expect(reissued).toEqual({
      state: "issued",
      attempt_count: 2,
      session_cancellation_acknowledged_at: null,
      n: 1,
    });

    await setup`
      UPDATE sync_brokered_evidence_uploads
      SET upload_expires_at=now() - interval '1 second'
      WHERE id=${first.id}::uuid
    `;
    await expireBrokeredEvidenceUploads(database);
    await setup`
      UPDATE registered_remote_solvers SET revoked_at=now()
      WHERE id=${solverId}::uuid
    `;
    await expect(directReissue()).rejects.toThrow(
      /solver credential is not active/,
    );
    expect(sessionRequests).toBe(2);
  });

  it("is idempotent under a session race, enforces quota, and revokes expired/cancelled work", async () => {
    if (!setup || !database)
      throw new Error("isolated broker database is unavailable");
    // The reciprocal-fence fixture intentionally remains issued after its
    // verification transaction rolls back. Retire that independent fixture so
    // the quota exercised below is owned solely by this lifecycle test.
    await setup.unsafe(`
      UPDATE sync_brokered_evidence_uploads
      SET state='expired', upload_url=NULL, upload_expires_at=NULL
      WHERE id='80000000-0000-4000-8000-000000000010'
    `);
    const promiseId = "80000000-0000-4000-8000-000000000020";
    const pointId = "80000000-0000-4000-8000-000000000021";
    await setup.unsafe("SET session_replication_role = replica");
    await setup.unsafe(`
      INSERT INTO sync_sweep_promises
        (id, source_instance_id, airfoil_id, simulation_preset_revision_id,
         aoa_count, "expiresAt", request_payload)
      VALUES ('${promiseId}', 'remote-fence-instance', '${id.airfoil}', '${id.revision}',
              1, now() + interval '1 day', '{"solverId":"${id.solver}"}'::jsonb);
      INSERT INTO sync_sweep_promise_points
        (id, promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
      VALUES ('${pointId}', '${promiseId}', '${id.airfoil}', '${id.revision}', 12);
    `);
    await setup.unsafe("SET session_replication_role = origin");
    const [solver] = await database
      .select()
      .from(schema.registeredRemoteSolvers)
      .where(eq(schema.registeredRemoteSolvers.id, id.solver));
    if (!solver) throw new Error("remote solver fixture disappeared");
    let failRetainedCancellation = true;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = enginePath(input);
        if (path.endsWith("/session")) {
          const body = parsedJsonBody(init);
          return new Response(
            JSON.stringify({
              state: "issued",
              uploadUrl: resumableUrl(String(body.objectKey), "race"),
              expiresAt: new Date(
                Date.now() +
                  (body.engineJobId === "job-overlong"
                    ? 9 * 60 * 60_000
                    : 60_000),
              ).toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path.endsWith("/session-settled"))
          return Response.json({ state: "registered" });
        if (path.endsWith("/cancel-identity")) {
          const body = parsedJsonBody(init);
          if (
            failRetainedCancellation &&
            body.engineJobId === "job-retained-session"
          )
            return Response.json(
              { detail: "provider unavailable" },
              { status: 503 },
            );
          return Response.json({ state: "cancelled", statusCode: 499 });
        }
        return Response.json(
          { detail: "unexpected broker test route" },
          { status: 404 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      idempotencyKey: "80000000-0000-4000-8000-000000000022",
      promiseId,
      remoteResultId: "80000000-0000-4000-8000-000000000023",
      remoteResultAttemptId: "80000000-0000-4000-8000-000000000024",
      aoaDeg: 12,
      engineJobId: "job-race",
      engineCaseSlug: "case-race",
      storedSha256: "d".repeat(64),
      storedByteSize: 2048,
      tarSha256: "e".repeat(64),
      tarByteSize: 4096,
      manifestSha256: "f".repeat(64),
      manifestByteSize: 512,
      zstdLevel: 7,
      bundledFileCount: 2,
    };
    const race = await Promise.allSettled([
      requestBrokeredEvidenceUpload(database, solver, request),
      requestBrokeredEvidenceUpload(database, solver, request),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(race.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        enginePath(input).endsWith("/session"),
      ),
    ).toHaveLength(1);
    const [{ n }] = await setup<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sync_brokered_evidence_uploads
      WHERE solver_id=${id.solver}::uuid AND idempotency_key=${request.idempotencyKey}::uuid
    `;
    expect(n).toBe(1);
    const engineCallsBeforeIdentityMismatch = fetchMock.mock.calls.length;
    await expect(
      requestBrokeredEvidenceUpload(database, solver, {
        ...request,
        manifestSha256: "1".repeat(64),
      }),
    ).rejects.toThrow(/idempotency key already names different evidence/);
    expect(fetchMock.mock.calls).toHaveLength(
      engineCallsBeforeIdentityMismatch,
    );

    const secondPromise = "80000000-0000-4000-8000-000000000025";
    await setup.unsafe("SET session_replication_role = replica");
    await setup.unsafe(`
      INSERT INTO sync_sweep_promises
        (id, source_instance_id, airfoil_id, simulation_preset_revision_id,
         aoa_count, "expiresAt", request_payload)
      VALUES ('${secondPromise}', 'remote-fence-instance', '${id.airfoil}', '${id.revision}',
              1, now() + interval '1 day', '{"solverId":"${id.solver}"}'::jsonb);
      INSERT INTO sync_sweep_promise_points
        (promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
      VALUES ('${secondPromise}', '${id.airfoil}', '${id.revision}', 13);
    `);
    await setup.unsafe("SET session_replication_role = origin");
    await expect(
      requestBrokeredEvidenceUpload(database, solver, {
        ...request,
        idempotencyKey: "80000000-0000-4000-8000-000000000026",
        promiseId: secondPromise,
        remoteResultId: "80000000-0000-4000-8000-000000000027",
        remoteResultAttemptId: "80000000-0000-4000-8000-000000000028",
        aoaDeg: 13,
        engineJobId: "job-quota",
      }),
    ).rejects.toThrow(/quota/);

    await setup.unsafe(`
      UPDATE sync_brokered_evidence_uploads
      SET upload_expires_at=now() - interval '1 second'
      WHERE idempotency_key='${request.idempotencyKey}'
    `);
    await expireBrokeredEvidenceUploads(database);
    const [expired] = await setup<
      { state: string; upload_url: string | null }[]
    >`
      SELECT state, upload_url FROM sync_brokered_evidence_uploads
      WHERE idempotency_key=${request.idempotencyKey}::uuid
    `;
    expect(expired).toEqual({ state: "expired", upload_url: null });

    const issued = await requestBrokeredEvidenceUpload(database, solver, {
      ...request,
      idempotencyKey: "80000000-0000-4000-8000-000000000029",
      promiseId: secondPromise,
      remoteResultId: "80000000-0000-4000-8000-00000000002a",
      remoteResultAttemptId: "80000000-0000-4000-8000-00000000002b",
      aoaDeg: 13,
      engineJobId: "job-cancel",
    });
    expect(issued.state).toBe("issued");
    await setup`UPDATE sync_sweep_promises SET status='cancelled' WHERE id=${secondPromise}::uuid`;
    await expireBrokeredEvidenceUploads(database);
    const [revoked] = await setup<
      { state: string; upload_url: string | null }[]
    >`
      SELECT state, upload_url FROM sync_brokered_evidence_uploads
      WHERE idempotency_key='80000000-0000-4000-8000-000000000029'::uuid
    `;
    expect(revoked).toEqual({ state: "revoked", upload_url: null });

    const overlongPromise = "80000000-0000-4000-8000-00000000002c";
    await setup.unsafe("SET session_replication_role = replica");
    await setup.unsafe(`
      INSERT INTO sync_sweep_promises
        (id, source_instance_id, airfoil_id, simulation_preset_revision_id,
         aoa_count, "expiresAt", request_payload)
      VALUES ('${overlongPromise}', 'remote-fence-instance', '${id.airfoil}', '${id.revision}',
              1, now() + interval '1 day', '{"solverId":"${id.solver}"}'::jsonb);
      INSERT INTO sync_sweep_promise_points
        (promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
      VALUES ('${overlongPromise}', '${id.airfoil}', '${id.revision}', 14);
    `);
    await setup.unsafe("SET session_replication_role = origin");
    const overlongRequest = {
      ...request,
      idempotencyKey: "80000000-0000-4000-8000-00000000002d",
      promiseId: overlongPromise,
      remoteResultId: "80000000-0000-4000-8000-00000000002e",
      remoteResultAttemptId: "80000000-0000-4000-8000-00000000002f",
      aoaDeg: 14,
      engineJobId: "job-overlong",
    };
    await expect(
      requestBrokeredEvidenceUpload(database, solver, overlongRequest),
    ).rejects.toThrow(/invalid upload session response/);
    const [overlong] = await setup<
      {
        state: string;
        upload_url: string | null;
        session_cancellation_acknowledged_at: string | null;
      }[]
    >`
      SELECT state, upload_url, session_cancellation_acknowledged_at
      FROM sync_brokered_evidence_uploads
      WHERE idempotency_key=${overlongRequest.idempotencyKey}::uuid
    `;
    expect(overlong.state).toBe("failed");
    expect(overlong.upload_url).toBeNull();
    expect(overlong.session_cancellation_acknowledged_at).not.toBeNull();

    const crashedUpload = "80000000-0000-4000-8000-000000000050";
    const crashedSha = "6".repeat(64);
    const crashedKey = `solver-evidence/v1/sha256/66/${crashedSha}.tar.zst`;
    await setup.unsafe("SET session_replication_role = replica");
    await setup.unsafe(`
      INSERT INTO sync_brokered_evidence_uploads
        (id, idempotency_key, promise_id, promise_point_id, solver_id,
         source_instance_id, remote_result_id, remote_result_attempt_id, aoa_deg,
         engine_job_id, bucket, object_key, stored_sha256, stored_byte_size,
         tar_sha256, tar_byte_size, manifest_sha256, manifest_byte_size,
         zstd_level, bundled_file_count, state, claim_token, claim_expires_at)
      SELECT '${crashedUpload}', '80000000-0000-4000-8000-000000000051',
             '${overlongPromise}', point.id, '${id.solver}', 'remote-fence-instance',
             '80000000-0000-4000-8000-000000000052',
             '80000000-0000-4000-8000-000000000053', 14, 'job-crashed-after-provider',
             '${bucket}', '${crashedKey}', '${crashedSha}', 2048, '${tarSha}', 4096,
             '${manifestSha}', 512, 7, 2, 'issuing',
             '80000000-0000-4000-8000-000000000054', now() - interval '1 second'
      FROM sync_sweep_promise_points point
      WHERE point.promise_id='${overlongPromise}' AND point.aoa_deg=14;
    `);
    await setup.unsafe("SET session_replication_role = origin");
    await expireBrokeredEvidenceUploads(database);
    const crashCancellation = fetchMock.mock.calls
      .filter(([input]) => enginePath(input).endsWith("/cancel-identity"))
      .map(([, init]) => parsedJsonBody(init))
      .find((body) => body.brokeredUploadId === crashedUpload);
    expect(crashCancellation).toMatchObject({
      brokeredUploadId: crashedUpload,
      uploadUrl: null,
      objectKey: crashedKey,
    });
    const [crashed] = await setup<
      {
        state: string;
        session_cancellation_acknowledged_at: string | null;
      }[]
    >`
      SELECT state, session_cancellation_acknowledged_at
      FROM sync_brokered_evidence_uploads WHERE id=${crashedUpload}::uuid
    `;
    expect(crashed.state).toBe("failed");
    expect(crashed.session_cancellation_acknowledged_at).not.toBeNull();

    const retainedUpload = "80000000-0000-4000-8000-000000000055";
    const retainedSha = "7".repeat(64);
    const retainedKey = `solver-evidence/v1/sha256/77/${retainedSha}.tar.zst`;
    await setup.unsafe("SET session_replication_role = replica");
    await setup.unsafe(`
      INSERT INTO sync_brokered_evidence_uploads
        (id, idempotency_key, promise_id, promise_point_id, solver_id,
         source_instance_id, remote_result_id, remote_result_attempt_id, aoa_deg,
         engine_job_id, bucket, object_key, stored_sha256, stored_byte_size,
         tar_sha256, tar_byte_size, manifest_sha256, manifest_byte_size,
         zstd_level, bundled_file_count, state, upload_url, upload_expires_at)
      SELECT '${retainedUpload}', '80000000-0000-4000-8000-000000000056',
             '${overlongPromise}', point.id, '${id.solver}', 'remote-fence-instance',
             '80000000-0000-4000-8000-000000000057',
             '80000000-0000-4000-8000-000000000058', 14, 'job-retained-session',
             '${bucket}', '${retainedKey}', '${retainedSha}', 2048, '${tarSha}', 4096,
             '${manifestSha}', 512, 7, 2, 'failed',
             '${resumableUrl(retainedKey, "retained")}', now() + interval '1 hour'
      FROM sync_sweep_promise_points point
      WHERE point.promise_id='${overlongPromise}' AND point.aoa_deg=14;
    `);
    await setup.unsafe("SET session_replication_role = origin");
    await expect(
      requestBrokeredEvidenceUpload(database, solver, {
        ...request,
        idempotencyKey: "80000000-0000-4000-8000-000000000059",
        promiseId: overlongPromise,
        remoteResultId: "80000000-0000-4000-8000-00000000005a",
        remoteResultAttemptId: "80000000-0000-4000-8000-00000000005b",
        aoaDeg: 14,
        engineJobId: "job-quota-behind-retained-session",
        storedSha256: "5".repeat(64),
      }),
    ).rejects.toThrow(/quota/);
    const [retained] = await setup<
      {
        upload_url: string | null;
        session_cancellation_acknowledged_at: string | null;
      }[]
    >`
      SELECT upload_url, session_cancellation_acknowledged_at
      FROM sync_brokered_evidence_uploads WHERE id=${retainedUpload}::uuid
    `;
    expect(retained.upload_url).toBe(resumableUrl(retainedKey, "retained"));
    expect(retained.session_cancellation_acknowledged_at).toBeNull();
    failRetainedCancellation = false;
    await expireBrokeredEvidenceUploads(database);
    const [reconciledRetained] = await setup<
      {
        upload_url: string | null;
        session_cancellation_acknowledged_at: string | null;
      }[]
    >`
      SELECT upload_url, session_cancellation_acknowledged_at
      FROM sync_brokered_evidence_uploads WHERE id=${retainedUpload}::uuid
    `;
    expect(reconciledRetained.upload_url).toBeNull();
    expect(
      reconciledRetained.session_cancellation_acknowledged_at,
    ).not.toBeNull();
    await setup`
      UPDATE sync_sweep_promise_points SET status='cancelled'
      WHERE promise_id=${overlongPromise}::uuid
    `;
  });

  it("recovers a committed generation when the final upload response was lost", async () => {
    if (!setup || !database)
      throw new Error("isolated broker database is unavailable");
    const promiseId = "80000000-0000-4000-8000-000000000060";
    const pointId = "80000000-0000-4000-8000-000000000061";
    await setup.unsafe("SET session_replication_role = replica");
    await setup.unsafe(`
      INSERT INTO sync_sweep_promises
        (id, source_instance_id, airfoil_id, simulation_preset_revision_id,
         aoa_count, "expiresAt", request_payload)
      VALUES ('${promiseId}', 'remote-fence-instance', '${id.airfoil}', '${id.revision}',
              1, now() + interval '1 day', '{"solverId":"${id.solver}"}'::jsonb);
      INSERT INTO sync_sweep_promise_points
        (id, promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
      VALUES ('${pointId}', '${promiseId}', '${id.airfoil}', '${id.revision}', 17);
    `);
    await setup.unsafe("SET session_replication_role = origin");
    const [solver] = await database
      .select()
      .from(schema.registeredRemoteSolvers)
      .where(eq(schema.registeredRemoteSolvers.id, id.solver));
    if (!solver) throw new Error("remote solver fixture disappeared");
    const request = {
      idempotencyKey: "80000000-0000-4000-8000-000000000062",
      promiseId,
      remoteResultId: "80000000-0000-4000-8000-000000000063",
      remoteResultAttemptId: "80000000-0000-4000-8000-000000000064",
      aoaDeg: 17,
      engineJobId: "job-lost-final-response",
      engineCaseSlug: "case-lost-final-response",
      storedSha256: "1".repeat(64),
      storedByteSize: 3072,
      tarSha256: "2".repeat(64),
      tarByteSize: 6144,
      manifestSha256: "3".repeat(64),
      manifestByteSize: 768,
      zstdLevel: 10,
      bundledFileCount: 4,
    };
    let sessionRequests = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = enginePath(input);
        if (path.endsWith("/session")) {
          sessionRequests += 1;
          if (sessionRequests === 1) {
            return Response.json({
              state: "issued",
              uploadUrl: resumableUrl(
                `solver-evidence/v1/sha256/11/${request.storedSha256}.tar.zst`,
                "lost-final-response",
              ),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });
          }
          const body = parsedJsonBody(init);
          return Response.json({
            state: "verified",
            remote: {
              schemaVersion: 1,
              format: "tar+zstd",
              bucket,
              objectKey: body.objectKey,
              generation,
              storedSha256: request.storedSha256,
              storedSize: request.storedByteSize,
              tarSha256: request.tarSha256,
              tarSize: request.tarByteSize,
              crc32c: "ImIEBA==",
              zstdLevel: request.zstdLevel,
              createdAt: new Date().toISOString(),
            },
          });
        }
        if (path.endsWith("/session-settled"))
          return Response.json({ state: "settled" });
        return Response.json(
          { detail: "unexpected broker test route" },
          { status: 404 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const issued = await requestBrokeredEvidenceUpload(
      database,
      solver,
      request,
    );
    expect(issued.state).toBe("issued");
    const recovered = await requestBrokeredEvidenceUpload(
      database,
      solver,
      request,
    );
    expect(recovered).toMatchObject({
      state: "verified",
      id: issued.id,
      remote: {
        bucket,
        generation,
        storedSha256: request.storedSha256,
      },
    });
    expect(sessionRequests).toBe(2);
    const [stored] = await setup<
      {
        state: string;
        generation: string | null;
        upload_url: string | null;
      }[]
    >`
      SELECT state, generation, upload_url
      FROM sync_brokered_evidence_uploads
      WHERE id=${issued.id}::uuid
    `;
    expect(stored).toEqual({
      state: "verified",
      generation,
      upload_url: null,
    });
  });

  it("rejects cross-instance scope, verifies the full returned identity, and revokes credentials", async () => {
    if (!setup || !database)
      throw new Error("isolated broker database is unavailable");
    const otherSolverId = "80000000-0000-4000-8000-000000000030";
    const otherPromiseId = "80000000-0000-4000-8000-000000000031";
    const ownedPromiseId = "80000000-0000-4000-8000-000000000032";
    await setup.unsafe("SET session_replication_role = replica");
    await setup.unsafe(`
      INSERT INTO registered_remote_solvers
        (id, instance_id, instance_name, auth_token_hash, credential_version)
      VALUES ('${otherSolverId}', 'other-remote-instance', 'Other remote',
              '${"1".repeat(64)}', 1);
      INSERT INTO sync_sweep_promises
        (id, source_instance_id, airfoil_id, simulation_preset_revision_id,
         aoa_count, "expiresAt", request_payload)
      VALUES ('${otherPromiseId}', 'other-remote-instance', '${id.airfoil}', '${id.revision}',
              1, now() + interval '1 day', '{"solverId":"${otherSolverId}"}'::jsonb),
             ('${ownedPromiseId}', 'remote-fence-instance', '${id.airfoil}', '${id.revision}',
              1, now() + interval '1 day', '{"solverId":"${id.solver}"}'::jsonb);
      INSERT INTO sync_sweep_promise_points
        (promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
      VALUES ('${otherPromiseId}', '${id.airfoil}', '${id.revision}', 15),
             ('${ownedPromiseId}', '${id.airfoil}', '${id.revision}', 14);
    `);
    await setup.unsafe("SET session_replication_role = origin");
    const [solver] = await database
      .select()
      .from(schema.registeredRemoteSolvers)
      .where(eq(schema.registeredRemoteSolvers.id, id.solver));
    if (!solver) throw new Error("remote solver fixture disappeared");
    const request = {
      idempotencyKey: "80000000-0000-4000-8000-000000000033",
      promiseId: ownedPromiseId,
      remoteResultId: "80000000-0000-4000-8000-000000000034",
      remoteResultAttemptId: "80000000-0000-4000-8000-000000000035",
      aoaDeg: 14,
      engineJobId: "job-identity",
      engineCaseSlug: "case-identity",
      storedSha256: "2".repeat(64),
      storedByteSize: 3072,
      tarSha256: "3".repeat(64),
      tarByteSize: 6144,
      manifestSha256: "4".repeat(64),
      manifestByteSize: 768,
      zstdLevel: 10,
      bundledFileCount: 4,
    };
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = enginePath(input);
        if (path.endsWith("/session")) {
          const body = parsedJsonBody(init);
          return new Response(
            JSON.stringify({
              state: "issued",
              uploadUrl: resumableUrl(String(body.objectKey), "identity"),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (path.endsWith("/session-settled"))
          return Response.json({ state: "registered" });
        if (path.endsWith("/cancel-identity"))
          return Response.json({ state: "cancelled", statusCode: 499 });
        return new Response(
          JSON.stringify({
            state: "verified",
            remote: {
              schemaVersion: 1,
              format: "tar+zstd",
              bucket: "wrong-bucket",
              objectKey: `solver-evidence/v1/sha256/22/${request.storedSha256}.tar.zst`,
              generation,
              storedSha256: request.storedSha256,
              storedSize: request.storedByteSize,
              tarSha256: request.tarSha256,
              tarSize: request.tarByteSize,
              crc32c: "ImIEBA==",
              zstdLevel: request.zstdLevel,
              createdAt: new Date().toISOString(),
            },
            manifestSha256: request.manifestSha256,
            manifestSize: request.manifestByteSize,
            bundledFileCount: request.bundledFileCount,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestBrokeredEvidenceUpload(database, solver, {
        ...request,
        idempotencyKey: "80000000-0000-4000-8000-000000000036",
        promiseId: otherPromiseId,
      }),
    ).rejects.toThrow(/exact active promise is not owned/);
    expect(fetchMock).not.toHaveBeenCalled();

    const issued = await requestBrokeredEvidenceUpload(
      database,
      solver,
      request,
    );
    expect(issued.state).toBe("issued");
    await expect(
      verifyBrokeredEvidenceUpload(database, solver, issued.id, generation),
    ).rejects.toThrow(/invalid verification response/);
    const [failed] = await setup<
      { state: string; upload_url: string | null }[]
    >`
      SELECT state, upload_url FROM sync_brokered_evidence_uploads
      WHERE id=${issued.id}::uuid
    `;
    expect(failed).toEqual({ state: "failed", upload_url: null });

    await revokeSolverEvidenceUploads(database, solver.id);
    const [revokedSolver] = await setup<
      {
        auth_token_hash: string | null;
        revoked_at: string | null;
      }[]
    >`
      SELECT auth_token_hash, revoked_at FROM registered_remote_solvers
      WHERE id=${solver.id}::uuid
    `;
    expect(revokedSolver.auth_token_hash).toBeNull();
    expect(revokedSolver.revoked_at).not.toBeNull();
    expect(Number.isFinite(Date.parse(revokedSolver.revoked_at!))).toBe(true);
    const [revokedUpload] = await setup<
      { state: string; upload_url: string | null }[]
    >`
      SELECT state, upload_url FROM sync_brokered_evidence_uploads
      WHERE id=${issued.id}::uuid
    `;
    expect(revokedUpload).toEqual({ state: "revoked", upload_url: null });
  });

  it("retains bound audit ownership while allowing explicit unbound cleanup", async () => {
    if (!setup || !database)
      throw new Error("isolated broker database is unavailable");
    const unboundPromise = "80000000-0000-4000-8000-000000000040";
    const unboundPoint = "80000000-0000-4000-8000-000000000041";
    const unboundUpload = "80000000-0000-4000-8000-000000000042";
    const boundPromise = "80000000-0000-4000-8000-000000000043";
    const boundPoint = "80000000-0000-4000-8000-000000000044";
    const boundUpload = "80000000-0000-4000-8000-000000000045";
    await setup.unsafe("SET session_replication_role = replica");
    await setup.unsafe(`
      INSERT INTO sync_sweep_promises
        (id, source_instance_id, airfoil_id, simulation_preset_revision_id,
         aoa_count, "expiresAt", request_payload)
      VALUES ('${unboundPromise}', 'remote-fence-instance', '${id.airfoil}', '${id.revision}',
              1, now() + interval '1 day', '{"solverId":"${id.solver}"}'::jsonb),
             ('${boundPromise}', 'remote-fence-instance', '${id.airfoil}', '${id.revision}',
              1, now() + interval '1 day', '{"solverId":"${id.solver}"}'::jsonb);
      INSERT INTO sync_sweep_promise_points
        (id, promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
      VALUES ('${unboundPoint}', '${unboundPromise}', '${id.airfoil}', '${id.revision}', 21),
             ('${boundPoint}', '${boundPromise}', '${id.airfoil}', '${id.revision}', 22);
      INSERT INTO sync_brokered_evidence_uploads
        (id, idempotency_key, promise_id, promise_point_id, solver_id,
         source_instance_id, remote_result_id, remote_result_attempt_id, aoa_deg,
         engine_job_id, bucket, object_key, stored_sha256, stored_byte_size,
         tar_sha256, tar_byte_size, manifest_sha256, manifest_byte_size,
         zstd_level, bundled_file_count, state)
      VALUES ('${unboundUpload}', '80000000-0000-4000-8000-000000000046',
              '${unboundPromise}', '${unboundPoint}', '${id.solver}',
              'remote-fence-instance', '80000000-0000-4000-8000-000000000047',
              '80000000-0000-4000-8000-000000000048', 21, 'unbound-job',
              '${bucket}', '${key}', '${sha}', 4096, '${tarSha}', 8192,
              '${manifestSha}', 1024, 7, 3, 'requested');
      INSERT INTO sync_brokered_evidence_uploads
        (id, idempotency_key, promise_id, promise_point_id, solver_id,
         source_instance_id, remote_result_id, remote_result_attempt_id, aoa_deg,
         engine_job_id, bucket, object_key, stored_sha256, stored_byte_size,
         tar_sha256, tar_byte_size, manifest_sha256, manifest_byte_size,
         zstd_level, bundled_file_count, state, generation, crc32c, verified_at,
         canonical_result_id, canonical_result_attempt_id, canonical_artifact_id,
         bound_at)
      VALUES ('${boundUpload}', '80000000-0000-4000-8000-000000000049',
              '${boundPromise}', '${boundPoint}', '${id.solver}',
              'remote-fence-instance', '80000000-0000-4000-8000-00000000004a',
              '80000000-0000-4000-8000-00000000004b', 22, 'bound-job',
              '${bucket}', '${key}', '${sha}', 4096, '${tarSha}', 8192,
              '${manifestSha}', 1024, 7, 3, 'bound', '${generation}', 'ImIEBA==', now(),
              '80000000-0000-4000-8000-00000000004c',
              '80000000-0000-4000-8000-00000000004d',
              '80000000-0000-4000-8000-00000000004e', now());
    `);
    await setup.unsafe("SET session_replication_role = origin");

    const [solver] = await database
      .select()
      .from(schema.registeredRemoteSolvers)
      .where(eq(schema.registeredRemoteSolvers.id, id.solver));
    if (!solver) throw new Error("remote solver fixture disappeared");
    const archiveBytes = new Uint8Array(4096).fill(7);
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(enginePath(input)).toBe("/internal/evidence-uploads/download");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${process.env.ENGINE_CONTROL_PLANE_TOKEN}`,
        );
        expect(parsedJsonBody(init)).toMatchObject({
          brokeredUploadId: boundUpload,
          solverId: id.solver,
          objectKey: key,
          generation,
          crc32c: "ImIEBA==",
        });
        return new Response(archiveBytes, {
          status: 200,
          headers: {
            "content-type": "application/zstd",
            "content-length": "4096",
            "x-content-sha256": sha,
            "x-gcs-generation": generation,
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const archive = await fetchBoundBrokeredEvidenceArchive(
      database,
      solver,
      boundUpload,
    );
    expect(archive).toMatchObject({
      size: 4096,
      mimeType: "application/zstd",
      storedSha256: sha,
      generation,
    });
    expect(
      new Uint8Array(await new Response(archive.body).arrayBuffer()),
    ).toEqual(archiveBytes);
    await expect(
      fetchBoundBrokeredEvidenceArchive(
        database,
        { ...solver, id: "80000000-0000-4000-8000-000000000099" },
        boundUpload,
      ),
    ).rejects.toThrow(/not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      setup`DELETE FROM sync_sweep_promises WHERE id=${unboundPromise}::uuid`,
    ).rejects.toThrow(/sync_brokered_evidence_uploads_promise_fk/);
    await setup`DELETE FROM sync_brokered_evidence_uploads WHERE id=${unboundUpload}::uuid`;
    await setup`DELETE FROM sync_sweep_promises WHERE id=${unboundPromise}::uuid`;
    const [{ n: pointCount }] = await setup<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sync_sweep_promise_points
      WHERE id=${unboundPoint}::uuid
    `;
    expect(pointCount).toBe(0);

    await expect(
      setup`DELETE FROM sync_brokered_evidence_uploads WHERE id=${boundUpload}::uuid`,
    ).rejects.toThrow(/audit ownership is immutable/);
  });
});
