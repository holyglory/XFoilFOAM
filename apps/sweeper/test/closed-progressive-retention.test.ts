import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { preflightProgressiveArchive } from "../src/progressive-archive-reclaim";
import { recheckDeferredProgressiveArchive } from "../src/progressive-archive-readback-retry";
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
  "results(id uuid,sim_job_id uuid,current_result_attempt_id uuid)",
  "sim_precalc_obligation_attempts(obligation_id uuid,result_attempt_id uuid)",
  "sim_precalc_obligations(id uuid,state text)",
  "sim_urans_verify_queue(latest_result_attempt_id uuid,state text,last_outcome text)",
  "result_attempts(id uuid,result_id uuid,sim_job_id uuid,engine_job_id text,engine_case_slug text,aoa_deg double precision,cl double precision,cd double precision,cm double precision,status text,regime text,evidence_payload jsonb DEFAULT '{}',airfoil_id uuid)",
  "result_media(id uuid,result_attempt_id uuid,storage_key text,sha256 text,byte_size bigint,mime_type text,result_id uuid,engine_url text,field text,kind text,role text,evidence_sha256 text,color_scale_id uuid,scale_vmin float8,scale_vmax float8,color_scale_version int,scale_policy text)",
  "result_media_storage_bindings(result_media_id uuid,blob_id uuid,local_storage_key text)",
  'result_media_blobs(id uuid,backend text,"verifiedAt" timestamptz,sha256 text,byte_size bigint,mime_type text)',
  "progressive_worker_evidence_attempts(sim_job_id uuid,result_attempt_id uuid,point_content_signature text)",
  "progressive_worker_hub_receipts(sim_job_id uuid,result_attempt_id uuid,point_content_signature text,receipt jsonb)",
  "progressive_worker_archive_receipts(sim_job_id uuid,point_content_signature text,brokered_upload_id uuid,receipt jsonb)",
  "progressive_worker_archive_reclaims(sim_job_id uuid,point_content_signature text,completed_at timestamptz)",
  "solver_evidence_artifacts(id uuid,kind text,result_id uuid,result_attempt_id uuid,engine_job_id text,storage_key text,metadata jsonb,sha256 text,byte_size bigint,mime_type text)",
  "remote_asset_references(local_row_id uuid,local_kind text,result_attempt_id uuid,result_id uuid,local_storage_key text,sha256 text,byte_size bigint,mime_type text,availability text,metadata jsonb,remote_result_id text,remote_artifact_id text,remote_download_url text,cached_storage_key text)",
  "airfoils(id uuid,slug text)",
  "field_color_scales(id uuid,vmin float8,vmax float8,scale_policy text,version int,status text)",
  "field_render_cache(storage_key text)",
  "result_media_storage_uploads(result_media_id uuid)",
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

it.each(["rans", "urans"])("keeps %s point-owned images and checks every route, legend and working-file reference", async (regime) => {
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
    const id = randomUUID(),
      media = randomUUID(),
      foil = randomUUID(),
      scale = randomUUID();
    const [item] = await fixture(db, id, 1);
    const [owner] = await db.execute(
      sql`SELECT result_id FROM result_attempts WHERE id=${item!.attempt}::uuid`,
    );
    const rid = String(owner!.result_id);
    await db.execute(
      sql`UPDATE result_attempts SET airfoil_id=${foil},regime=${regime},status='done' WHERE id=${item!.attempt}`,
    );
    await db.execute(
      sql`INSERT INTO results(id,sim_job_id,current_result_attempt_id) VALUES(${rid},${id},${item!.attempt})`,
    );
    await db.execute(sql`INSERT INTO airfoils VALUES(${foil},'real-foil')`);
    const field = "pressure",
      nativePath = "cases/foil/a0/images/pressure.png",
      scaledPath = "cases/foil/a0/evidence/scaled_media/default_v1_zoom2/v8/pressure.png";
    const registered = regime === "urans" ? nativePath : scaledPath;
    const registeredBytes = regime === "urans" ? "engine" : "scaled";
    const locals = [
      { path: nativePath, sha256: sha("engine"), byteSize: 6 },
      { path: scaledPath, sha256: sha("scaled"), byteSize: 6 },
    ];
    if (regime === "urans")
      locals.push({ path: scaledPath.replace("/v8/", "/v7/"), sha256: sha("oldpng"), byteSize: 6 });
    const candidate = "cases/foil/postProcessing/forceCoeffs/0/coefficient.dat";
    const workingPaths = regime === "urans"
      ? [...Array.from({ length: 4112 }, (_, i) => `cases/foil/transient_a0/${i + 1}/U`), candidate]
      : [candidate];
    const legend = {
      mode: "track",
      vmin: -1,
      vmax: 1,
      policy: "linear",
      version: 1,
      status: "active",
    };
    await db.execute(
      sql`INSERT INTO field_color_scales VALUES(${scale},-1,1,'linear',1,'active')`,
    );
    await db.execute(sql`INSERT INTO result_media(id,result_id,result_attempt_id,storage_key,kind,role,field,mime_type,sha256,byte_size,evidence_sha256,color_scale_id)
      VALUES(${media},${rid},${item!.attempt},${`jobs/${id}/${registered}`},'image','instantaneous',${field},'image/png',${sha(registeredBytes)},6,${item!.remote.manifestSha256},${scale})`);
    let applied = 0,
      brokenPath = false,
      wrongLegend = false,
      swapped = false,
      missingOriginal = false;
    const routes: string[] = [];
    const native: ClosedProgressiveBackend = {
      async reclaimClosedProgressiveFiles(job, manifests, plan, readbacks) {
        expect(job).toBe(id);
        expect(manifests[0]?.keepMedia?.map((row) => row.id)).toEqual([media]);
        expect(manifests[0]?.regime).toBe(regime === "urans" ? "urans" : undefined);
        if (plan) {
          expect(readbacks?.[0]?.brokeredUploadId).toBe(item!.upload);
          applied++;
        }
        return {
          job_id: id,
          state: plan ? "reclaimed" : "planned",
          replayed: !plan && applied > 0,
          plan: "c".repeat(64),
          files: workingPaths.length,
          bytes: 32,
          mediaFiles: missingOriginal ? locals.slice(1) : locals,
          workingPaths,
          plannedAllocatedBytes: 4096,
        };
      },
    };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const u = new URL(String(input));
        const path = u.pathname;
        routes.push(path);
        if (path.endsWith("/download"))
          return new Response(item!.upload, {
            headers: {
              "content-type": "application/zstd",
              "content-length": String(item!.upload.length),
              "x-content-sha256": item!.remote.storedSha256,
              "x-gcs-generation": item!.remote.generation,
            },
          });
        if (path.endsWith("/sim"))
          return Response.json({
            resultId: rid,
            media: {
              [swapped ? "vorticity" : "pressure"]: {
                kind: "image",
                url: `/api/result-media/${media}`,
                scale: wrongLegend ? { ...legend, vmax: 2 } : legend,
              },
            },
          });
        const value = path === `/api/result-media/${media}` ? registeredBytes :
          path.endsWith(nativePath) ? "engine" : path.includes("/v7/") ? "oldpng" : "scaled";
        if (brokenPath && path.startsWith("/api/media/"))
          return new Response("broken", {
            headers: { "content-type": "image/png", "content-length": "6" },
          });
        return new Response(value, {
          headers: { "content-type": "image/png", "content-length": "6" },
        });
      });
    const opts = { now: clock, ageMs: 1, timeoutMs: 3000, keepMedia: true };
    try {
      await expect(
        closedProgressiveJob(db, native, id, {
          ...opts,
          keepMedia: false,
          inspect: true,
        }),
      ).rejects.toThrow(/unbound|eligibility|ownership/);
      const preview = await closedProgressiveJob(db, native, id, {
        ...opts,
        inspect: true,
      });
      expect(preview.mediaSha256).toMatch(/^[0-9a-f]{64}$/);
      for (const expected of [
        `/api/result-media/${media}`,
        `/jobs/${id}/files/${nativePath}`,
        `/api/media/jobs/${id}/${scaledPath}`,
        "/api/airfoils/real-foil/sim",
      ])
        expect(routes).toContain(expected);
      if (regime === "urans") {
        expect(routes).toContain(`/api/media/jobs/${id}/${scaledPath.replace("/v8/", "/v7/")}`);
        locals.push({ path: scaledPath.replace("pressure.png", "foreign.png"), sha256: sha("scaled"), byteSize: 6 });
        await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(/incomplete/);
        locals.pop();
      }
      missingOriginal = true;
      await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(
        /inventory is incomplete/,
      );
      missingOriginal = false;
      brokenPath = true;
      await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(
        /different bytes/,
      );
      brokenPath = false;
      swapped = true;
      await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(
        /legend|field/,
      );
      swapped = false;
      wrongLegend = true;
      await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(
        /legend/,
      );
      wrongLegend = false;
      await db.execute(
        sql`INSERT INTO field_render_cache VALUES(${`jobs/${id}/${candidate}`})`,
      );
      await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(
        /reference/,
      );
      await db.execute(sql`DELETE FROM field_render_cache`);
      await db.execute(
        sql`INSERT INTO result_media(id,storage_key) VALUES(${randomUUID()},${`jobs/${id}/foreign.png`})`,
      );
      await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(
        /exact current-job/,
      );
      await db.execute(
        sql`DELETE FROM result_media WHERE result_attempt_id IS NULL`,
      );
      expect(applied).toBe(0);
      const result = await closedProgressiveJob(db, native, id, {
        ...opts,
        expectedPlan: preview.plan.plan!,
        expectedMediaSha256: preview.mediaSha256,
      });
      expect(result.settled).toBe(true);
      expect(applied).toBe(1);
      const post = await closedProgressiveJob(db, native, id, {
        ...opts,
        inspect: true,
        verifyCompleted: true,
        expectedPlan: preview.plan.plan!,
        expectedMediaSha256: preview.mediaSha256,
      });
      expect(post.mediaSha256).toBe(preview.mediaSha256);
      expect(post.plan.mediaFiles).toEqual(preview.plan.mediaFiles);
      const [saved] = await db.execute(
        sql`SELECT strip_report->'closedProgressiveFiles' AS receipt FROM sim_jobs WHERE id=${id}`,
      );
      expect(saved!.receipt).toMatchObject({
        mediaSha256: preview.mediaSha256,
        verifiedArchives: 1,
      });
    } finally {
      spy.mockRestore();
    }
  });
}, 30000);

it("binds an explicitly empty URANS image set to its normal per-job proof", async () => {
  await client.db.transaction(async (tx) => {
    const db = tx as unknown as DB;
    for (const definition of tableDefinitions)
      await db.execute(sql.raw("CREATE TEMP TABLE " + definition + " ON COMMIT DROP"));
    await db.execute(sql`INSERT INTO sync_api_settings VALUES(1,${solver},${token},${root})`);
    await db.execute(sql`INSERT INTO sync_sweep_promises VALUES(${promiseId},${root},${solver})`);
    const id = randomUUID();
    const [point] = await fixture(db, id, 1);
    const opts = { inspect: true, keepMedia: true, now: clock, ageMs: 1, timeoutMs: 3000 };
    let stray = true;
    const native: ClosedProgressiveBackend = {
      async reclaimClosedProgressiveFiles(job, manifests) {
        expect(manifests).toHaveLength(1);
        expect(manifests[0]).toMatchObject({ regime: "urans", keepMedia: [] });
        return { job_id: job, state: "planned", plan: "e".repeat(64), files: 1, bytes: 32,
          workingPaths: ["cases/foil/transient_a0/log.pimpleFoam"],
          mediaFiles: stray ? [{path: "cases/foil/a0/images/pressure.png", byteSize: 1, sha256: sha("p")}] : [],
        };
      },
    };
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(new URL(String(input)).pathname).toBe(`/api/sync/v1/evidence-uploads/${point!.upload}/download`);
      return new Response(point!.upload, {headers: {"content-type": "application/zstd",
        "content-length": String(point!.upload.length), "x-content-sha256": point!.remote.storedSha256,
        "x-gcs-generation": point!.remote.generation}});
    });
    try {
      await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(/no registered instantaneous/);
      await db.execute(sql`UPDATE result_attempts SET regime='urans' WHERE id=${point!.attempt}`);
      await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(/inventory is incomplete/);
      expect(spy).not.toHaveBeenCalled();
      stray = false;
      const proof = await closedProgressiveJob(db, native, id, opts);
      expect(proof.mediaSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(proof.plan.mediaFiles).toEqual([]);
      expect(proof.readbacks).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
}, 30000);

it("reschedules only one deferred point after an exact registered read, preserving concurrent claims", async () => {
  await client.db.transaction(async (tx) => {
    const db = tx as unknown as DB;
    for (const definition of tableDefinitions)
      await db.execute(sql.raw("CREATE TEMP TABLE " + definition + " ON COMMIT DROP"));
    await db.execute(sql`ALTER TABLE sync_api_settings ADD remote_solver_transfer_paused boolean DEFAULT false`);
    await db.execute(sql`ALTER TABLE progressive_worker_archive_reclaims ADD claim_token uuid,ADD claim_expires_at timestamptz,
      ADD attempt_count int, ADD retry_after timestamptz,ADD last_error text,ADD reclaimed_bytes bigint`);
    await db.execute(sql`INSERT INTO sync_api_settings VALUES(1,${solver},${token},${root})`);
    await db.execute(sql`INSERT INTO sync_sweep_promises VALUES(${promiseId},${root},${solver})`);
    const job = randomUUID(), [point] = await fixture(db,job,1);
    const target = {jobId:job,pointSignature:sha(point!.attempt),uploadId:point!.upload,attemptCount:11};
    await db.execute(sql`UPDATE progressive_worker_archive_reclaims SET completed_at=NULL,reclaimed_bytes=NULL,
      attempt_count=11,retry_after=clock_timestamp()+interval '4 hours',last_error='Progressive archive readback returned HTTP 503'`);
    const signal = AbortSignal.timeout(6000);let corrupt = true, takeClaim = false;
    const spy = vi.spyOn(globalThis,"fetch").mockImplementation(async (url,opts) => {
      expect(String(url)).toBe(root+"/evidence-uploads/"+point!.upload+"/download");
      expect(new Headers(opts?.headers).get("x-xfoilfoam-solver-token")).toBe(token);
      if (takeClaim) await db.execute(sql`UPDATE progressive_worker_archive_reclaims SET claim_token=${randomUUID()},
        claim_expires_at=clock_timestamp()+interval '30 minutes'`);
      return new Response(corrupt ? "x".repeat(point!.upload.length) : point!.upload, {headers:{
        "content-type":"application/zstd","content-length":String(point!.upload.length),
        "x-content-sha256":point!.remote.storedSha256,"x-gcs-generation":point!.remote.generation}});
    });
    try {
      expect((await recheckDeferredProgressiveArchive(db,{...target,uploadId:randomUUID()},signal)).status).toBe("unchanged");
      expect(spy).not.toHaveBeenCalled();
      await expect(recheckDeferredProgressiveArchive(db,target,signal)).rejects.toThrow(/byte proof/);
      corrupt=false;takeClaim=true;
      expect((await recheckDeferredProgressiveArchive(db,target,signal)).status).toBe("unchanged");
      const [race]=await db.execute(sql`SELECT retry_after>clock_timestamp()+interval '3 hours' AS deferred,claim_token IS NOT NULL AS held,completed_at FROM progressive_worker_archive_reclaims`);
      expect(race).toMatchObject({deferred:true,held:true,completed_at:null});
      takeClaim=false;
      await db.execute(sql`UPDATE progressive_worker_archive_reclaims SET claim_token=NULL,claim_expires_at=NULL`);
      expect(await recheckDeferredProgressiveArchive(db,target,signal)).toMatchObject({status:"rescheduled",storedSha256:point!.remote.storedSha256,generation:point!.remote.generation});
      expect((await recheckDeferredProgressiveArchive(db,target,signal)).status).toBe("unchanged");
      const [scheduled]=await db.execute(sql`SELECT retry_after<=clock_timestamp() AS due,attempt_count,completed_at,claim_token,reclaimed_bytes FROM progressive_worker_archive_reclaims`);
      expect(scheduled).toMatchObject({due:true,attempt_count:11,completed_at:null,claim_token:null,reclaimed_bytes:null});
    } finally { spy.mockRestore(); }
  });
}, 30000);

it("lets a delayed archive response finish inside the proof deadline and restores the previous HTTP dispatcher", async () => {
  const resolver = createRequire(
    new URL("../../../packages/engine-client/package.json", import.meta.url),
  );
  const undici = resolver("undici");
  const location = new URL(
    "../../../scripts/deploy/hz-closed-job-node.mjs",
    import.meta.url,
  );
  const { withReadbackTransport } = await import(
    /* @vite-ignore */ location.href
  );
  const previous = undici.getGlobalDispatcher();
  const short = new undici.Agent({ headersTimeout: 50, bodyTimeout: 50 });
  const body = Buffer.from("authenticated compressed archive fixture");
  const remote = {
    generation: "18446744073709551614",
    storedSha256: createHash("sha256").update(body).digest("hex"),
    storedByteSize: body.length,
  } as ProgressiveEvidenceCustodyReceipt["remote"];
  const download = `/api/sync/v1/evidence-uploads/${randomUUID()}/download`;
  const busyBody = JSON.stringify({
    code: "sync_capacity_busy",
    retryAfterMs: 1000,
  });
  const admission = { reject: true, remaining: 1, hits: 0, corrupt: false };
  const globalFetch = globalThis.fetch;
  const server = createServer((req, res) => {
    if (req.headers["x-xfoilfoam-solver-token"] !== "fixture-token") {
      res.writeHead(403).end();
      return;
    }
    if (req.url === download) {
      admission.hits++;
      if (admission.remaining > 0) {
        admission.remaining--;
        const message = admission.reject
          ? busyBody
          : JSON.stringify({ error: "different archive owner" });
        res
          .writeHead(503, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(message),
            "retry-after": "1",
          })
          .end(message);
        return;
      }
    }
    const send = setTimeout(
      () => {
        res.writeHead(200, {
          "content-type": "application/zstd",
          "content-length": body.length,
          "x-content-sha256": remote.storedSha256,
          "x-gcs-generation": remote.generation,
        });
        res.end(
          req.url === "/corrupt" || (req.url === download && admission.corrupt)
            ? Buffer.alloc(body.length)
            : body,
        );
      },
      req.url === "/slow" ? 1800 : 0,
    );
    res.once("close", () => clearTimeout(send));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Missing local archive server");
    const read = (path: string, timeout: number) =>
      preflightProgressiveArchive(
        `http://127.0.0.1:${address.port}${path}`,
        "fixture-token",
        remote,
        AbortSignal.timeout(timeout),
      );
    undici.setGlobalDispatcher(short);
    await expect(read("/slow", 6000)).rejects.toMatchObject({
      cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
    });
    const busy = vi.fn();
    const started = Date.now();
    await withReadbackTransport(undici, () => read(download, 5000), busy);
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    expect(admission.hits).toBe(2);
    expect(busy).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toBe(globalFetch);
    admission.remaining = 1;
    await expect(
      withReadbackTransport(undici, () => read(download, 75)),
    ).rejects.toThrow("admission deadline");
    expect(admission.hits).toBe(3);
    admission.reject = false;
    admission.remaining = 1;
    await expect(
      withReadbackTransport(undici, () => read(download, 5000)),
    ).rejects.toThrow("HTTP 503");
    expect(admission.hits).toBe(4);
    admission.corrupt = true;
    await expect(
      withReadbackTransport(undici, () => read(download, 5000)),
    ).rejects.toThrow("complete byte proof");
    expect(admission.hits).toBe(5);
    expect(globalThis.fetch).toBe(globalFetch);
    await withReadbackTransport(undici, () => read("/slow", 6000));
    expect(undici.getGlobalDispatcher()).toBe(short);
    await expect(
      withReadbackTransport(undici, () => read("/slow", 75)),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(undici.getGlobalDispatcher()).toBe(short);
    await expect(
      withReadbackTransport(undici, () => read("/corrupt", 6000)),
    ).rejects.toThrow(/complete byte proof/);
    expect(undici.getGlobalDispatcher()).toBe(short);
    // The ordinary point-reclaim service calls the reader directly.
    undici.setGlobalDispatcher(previous);
    admission.reject = true;
    admission.remaining = 1;
    admission.corrupt = false;
    const directStart = admission.hits;
    await read(download, 5000);
    expect(admission.hits - directStart).toBe(2);
    admission.remaining = 1;
    admission.corrupt = true;
    await expect(read(download, 5000)).rejects.toThrow(/complete byte proof/);
    expect(admission.hits - directStart).toBe(4);
    admission.reject = false;
    admission.remaining = 1;
    await expect(read(download, 5000)).rejects.toThrow("HTTP 503");
    expect(admission.hits - directStart).toBe(5);
  } finally {
    undici.setGlobalDispatcher(previous);
    await short.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
