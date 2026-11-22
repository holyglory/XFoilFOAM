import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import {
  createClient,
  signProgressiveEvidenceCustodyReceipt,
  type DB,
  type ProgressiveEvidenceCustodyReceipt,
} from "@aerodb/db";
import { EngineError } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";
import {
  type ClosedProgressiveBackend,
  closedProgressiveJob,
  stripClosedProgressiveJobs,
} from "../src/closed-progressive-retention";

const client = createClient();
afterAll(() => client.sql.end());
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const promiseId = randomUUID(),
  solver = randomUUID(),
  root = "https://hub.example/api/sync/v1",
  token = "fixture-token";
const clock = new Date("2031-01-01");
const tableDefinitions = [
  'sim_jobs(id uuid primary key,status text,engine_job_id text,request_payload jsonb,stripped_at timestamptz,strip_report jsonb,"finishedAt" timestamptz,"ingestedAt" timestamptz,"updatedAt" timestamptz,"createdAt" timestamptz,ingest_lease_token uuid,ingest_lease_expires_at timestamptz,parent_job_id uuid)',
  "progressive_cfd_attempts(sim_job_id uuid,outcome text)",
  "progressive_worker_reports(sim_job_id uuid,acknowledged_at timestamptz,stopped_engine_job_id text)",
  "sim_urans_requests(continue_from_result_id uuid,state text)",
  "results(id uuid,sim_job_id uuid)",
  "sim_precalc_obligation_attempts(obligation_id uuid,result_attempt_id uuid)",
  "sim_precalc_obligations(id uuid,state text)",
  "sim_urans_verify_queue(latest_result_attempt_id uuid,state text,last_outcome text)",
  "result_attempts(id uuid,result_id uuid,sim_job_id uuid,engine_job_id text,engine_case_slug text,aoa_deg double precision,cl double precision,cd double precision,cm double precision,status text,regime text,evidence_payload jsonb DEFAULT '{}')",
  "result_media(id uuid,result_attempt_id uuid,storage_key text,sha256 text,byte_size bigint,mime_type text)",
  "result_media_storage_bindings(result_media_id uuid,blob_id uuid,local_storage_key text)",
  'result_media_blobs(id uuid,backend text,"verifiedAt" timestamptz,sha256 text,byte_size bigint,mime_type text)',
  "progressive_worker_evidence_attempts(sim_job_id uuid,result_attempt_id uuid,point_content_signature text)",
  "progressive_worker_hub_receipts(sim_job_id uuid,result_attempt_id uuid,point_content_signature text,receipt jsonb)",
  "progressive_worker_archive_receipts(sim_job_id uuid,point_content_signature text,brokered_upload_id uuid,receipt jsonb)",
  "progressive_worker_archive_reclaims(sim_job_id uuid,point_content_signature text,completed_at timestamptz)",
  "solver_evidence_artifacts(id uuid,kind text,result_id uuid,result_attempt_id uuid,engine_job_id text,storage_key text,metadata jsonb,sha256 text,byte_size bigint,mime_type text)",
  "remote_asset_references(local_row_id uuid,local_kind text,result_attempt_id uuid,result_id uuid,local_storage_key text,sha256 text,byte_size bigint,mime_type text,availability text,metadata jsonb,remote_result_id text,remote_artifact_id text,remote_download_url text)",
  "sync_api_settings(id int,remote_solver_registered_id uuid,remote_solver_auth_token text,upstream_base_url text)",
  "sync_sweep_promises(id uuid,source_base_url text,registered_solver_id uuid)",
];

async function fixture(db: DB, id: string, points: number) {
  const req = {
    remoteProgressiveExecution: {},
    syncPromiseId: promiseId,
    upstreamBaseUrl: root,
  };
  await db.execute(
    sql`INSERT INTO sim_jobs(id,engine_job_id,status,request_payload,"finishedAt") VALUES(${id},${id},'done',${JSON.stringify(req)}::jsonb,'2025-01-01')`,
  );
  await db.execute(
    sql`INSERT INTO progressive_worker_reports VALUES(${id},now(),${id})`,
  );
  const objects = [];
  for (let n = 0; n < points; n++) {
    const attempt = randomUUID(),
      result = randomUUID(),
      upload = randomUUID(),
      bundle = randomUUID(),
      caseSlug = "foil",
      base = `a${n}/evidence`;
    const remote = {
      bucket: "bucket",
      objectKey: `evidence/${upload}`,
      generation: "18446744073709551614",
      crc32c: "AAAAAA==",
      storedSha256: sha(upload),
      storedByteSize: upload.length,
      tarSha256: sha("tar"),
      tarByteSize: 1024,
      manifestSha256: sha("manifest" + n),
      manifestByteSize: 32,
      zstdLevel: 12,
      bundledFileCount: 3,
    };
    const signature = sha(attempt);
    const receipt: ProgressiveEvidenceCustodyReceipt = {
      schemaVersion: 1,
      kind: "hub-progressive-evidence-custody",
      source: {
        solverId: solver,
        promiseId,
        engineJobId: id,
        aoaDeg: n,
        engineCaseSlug: caseSlug,
        progressiveEvidence: {
          sequence: 1,
          reportContentSignature: sha("r"),
          pointContentSignature: signature,
        },
        remoteResultId: result,
        remoteResultAttemptId: attempt,
      },
      brokeredUploadId: upload,
      remote,
      canonical: {
        resultId: randomUUID(),
        resultAttemptId: randomUUID(),
        artifactId: randomUUID(),
        archiveId: randomUUID(),
      },
      boundAt: new Date().toISOString(),
    };
    const signed = signProgressiveEvidenceCustodyReceipt(receipt, token),
      storage = `jobs/${id}/cases/${caseSlug}/${base}/engine_evidence.tar.zst`;
    await db.execute(
      sql`INSERT INTO result_attempts VALUES(${attempt},${result},${id},${id},${caseSlug})`,
    );
    await db.execute(
      sql`INSERT INTO progressive_worker_evidence_attempts VALUES(${id},${attempt},${signature})`,
    );
    await db.execute(
      sql`INSERT INTO progressive_worker_hub_receipts VALUES(${id},${attempt},${signature},${JSON.stringify(receipt.canonical)}::jsonb)`,
    );
    await db.execute(
      sql`INSERT INTO progressive_worker_archive_receipts VALUES(${id},${signature},${upload},${JSON.stringify(signed)}::jsonb)`,
    );
    await db.execute(
      sql`INSERT INTO progressive_worker_archive_reclaims VALUES(${id},${signature},now())`,
    );
    await db.execute(sql`INSERT INTO solver_evidence_artifacts VALUES(${bundle},'engine_bundle',${result},${attempt},${id},${storage},${JSON.stringify({ evidenceBase: base })}::jsonb,${remote.storedSha256},${remote.storedByteSize},'application/zstd'),
      (${randomUUID()},'manifest',${result},${attempt},${id},${storage.replace("engine_evidence.tar.zst", "evidence_manifest.json")},'{}',${remote.manifestSha256},32,'application/json')`);
    await db.execute(
      sql`INSERT INTO remote_asset_references VALUES(${bundle},'evidence_artifact',${attempt},${result},${storage},${remote.storedSha256},${remote.storedByteSize},'application/zstd','remote_only',${JSON.stringify({ ...remote, brokeredUploadId: upload })}::jsonb,${receipt.canonical.resultId},${receipt.canonical.artifactId},${root + "/evidence-uploads/" + upload + "/download"})`,
    );
    objects.push({ attempt, upload, remote });
  }
  return objects;
}

it("rotates blocked and 409 jobs, authenticates every object before reclaim and keeps a partial receipt distinct from a full strip", async () => {
  await client.db.transaction(async (transaction) => {
    const db = transaction as unknown as DB;
    for (const def of tableDefinitions)
      await db.execute(sql.raw("CREATE TEMP TABLE " + def + " ON COMMIT DROP"));
    await db.execute(
      sql`INSERT INTO sync_api_settings VALUES(1,${solver},${token},${root})`,
    );
    await db.execute(
      sql`INSERT INTO sync_sweep_promises VALUES(${promiseId},${root},${solver})`,
    );
    const id = (n: number) =>
      "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
    const objects = new Map<
      string,
      { generation: string; storedSha256: string }
    >();
    for (let n = 0; n < 13; n++) {
      const group = await fixture(db, id(n), n >= 10 ? 2 : 1);
      for (const e of group) objects.set(e.upload, e.remote);
      if (n < 8)
        await db.execute(
          sql`INSERT INTO result_media(id,result_attempt_id,storage_key) VALUES(${randomUUID()},${group[0]!.attempt},'local-without-checksum')`,
        );
    }
    const calls: string[] = [],
      applied: string[] = [],
      fetched: string[] = [];
    const engine = {
      deleteJob: vi.fn(),
      stripJob: vi.fn(),
      reclaimClosedProgressiveFiles: vi.fn(
        async (job: string, _proofs: unknown[], plan?: string) => {
          calls.push(job);
          if (job === id(8)) throw new EngineError("locked", 409);
          if (plan) applied.push(job);
          return {
            job_id: job,
            state: plan ? "reclaimed" : "planned",
            plan: "a".repeat(64),
            files: 1,
            bytes: 64,
          };
        },
      ),
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const upload = new URL(String(url)).pathname.split("/").at(-2)!;
        const obj = objects.get(upload)!;
        fetched.push(upload);
        return new Response(upload, {
          headers: {
            "content-type": "application/zstd",
            "content-length": String(upload.length),
            "x-content-sha256": obj.storedSha256,
            "x-gcs-generation": obj.generation,
          },
        });
      });
    try {
      // No orphan, media row, or immutable receipt is fixed up to pass the gate.
      await db.execute(
        sql`INSERT INTO result_attempts VALUES(${randomUUID()},${randomUUID()},${id(9)},${id(9)},'extra')`,
      );
      expect(
        await stripClosedProgressiveJobs(
          db,
          engine as unknown as ClosedProgressiveBackend,
          clock,
          1,
          1,
          3000,
        ),
      ).toBe(0);
      expect(calls).toEqual([id(8)]);
      const restarted = Object.create(db) as DB;
      expect(
        await stripClosedProgressiveJobs(
          restarted,
          engine as unknown as ClosedProgressiveBackend,
          clock,
          1,
          1,
          3000,
        ),
      ).toBe(0);
      expect(calls).toEqual([id(8)]);
      expect(
        await stripClosedProgressiveJobs(
          restarted,
          engine as unknown as ClosedProgressiveBackend,
          clock,
          1,
          1,
          3000,
        ),
      ).toBe(1);
      expect(applied).toEqual([id(10)]);
      expect(new Set(fetched).size).toBe(2);
      fetchSpy.mockResolvedValueOnce(new Response("bad", { status: 409 }));
      expect(
        await stripClosedProgressiveJobs(
          restarted,
          engine as unknown as ClosedProgressiveBackend,
          clock,
          1,
          1,
          3000,
        ),
      ).toBe(0);
      expect(applied).toEqual([id(10)]);
      const [ok] = await db.execute(
        sql`SELECT stripped_at,strip_report FROM sim_jobs WHERE id=${id(10)}`,
      );
      expect(ok).toMatchObject({
        stripped_at: null,
        strip_report: {
          closedProgressiveFiles: {
            complete: true,
            bytes: 64,
            files: 1,
            planSha256: "a".repeat(64),
            verifiedArchives: 2,
          },
        },
      });
      const options = { now: clock, ageMs: 1, timeoutMs: 3000 };
      const api = engine as unknown as ClosedProgressiveBackend;
      const before = await closedProgressiveJob(db, api, id(12), {
        ...options,
        inspect: true,
      });
      expect(before.settled).toBe(false);
      expect(before.readbacks).toHaveLength(2);
      await expect(
        closedProgressiveJob(db, api, id(12), {
          ...options,
          expectedPlan: "b".repeat(64),
        }),
      ).rejects.toThrow("canary plan");
      expect(applied).toEqual([id(10)]);
      const originalFetch = fetchSpy.getMockImplementation()!;
      fetchSpy.mockImplementationOnce(async (...args) => {
        await db.execute(
          sql`INSERT INTO sim_jobs (id,status,parent_job_id) VALUES(${randomUUID()},'running',${id(12)}::uuid)`,
        );
        return originalFetch(...args);
      });
      const retained = await closedProgressiveJob(db, api, id(12), options);
      expect(retained.settled).toBe(false);
      expect(applied).toEqual([id(10)]);
      // One entire bounded page can be ineligible without hiding a later job.
      await db.execute(sql`INSERT INTO sim_jobs(id,engine_job_id,status,"finishedAt")
        SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'00000000-0000-4000-8000-'||lpad(i::text,12,'0'),'done','2025-01-01'
        FROM generate_series(20,90) i`);
      const late = await fixture(db, id(100), 1);
      objects.set(late[0]!.upload, late[0]!.remote);
      expect(
        await stripClosedProgressiveJobs(restarted, api, clock, 1, 8, 3000),
      ).toBe(0);
      expect(
        await stripClosedProgressiveJobs(restarted, api, clock, 1, 8, 3000),
      ).toBe(1);
      expect(applied).toEqual([id(10), id(100)]);
      expect(engine.deleteJob).not.toHaveBeenCalled();
      expect(engine.stripJob).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
}, 30000);
