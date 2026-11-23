import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { retentionTick, resetRetentionMemory } from "../src/retention";
import { createRequire } from "node:module";
import { preflightProgressiveArchive } from "../src/progressive-archive-reclaim";
import { recheckDeferredProgressiveArchive } from "../src/progressive-archive-readback-retry";
import { afterAll, expect, it, vi } from "vitest";
import {
  createClient,
  signProgressiveEvidenceCustodyReceipt,
  sealProgressiveRemoteExecution,
  type DB,
  type ProgressiveEvidenceCustodyReceipt,
} from "@aerodb/db";
import { EngineError, OPENCFD_2606_ENGINE, type EngineClient } from "@aerodb/engine-client";
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
  "sweeper_state(id int primary key,closed_progressive_retention_after_id uuid,disk_admission_blocked boolean)",
  "sync_api_settings(id int,remote_solver_registered_id uuid,remote_solver_auth_token text,upstream_base_url text)",
  "sync_sweep_promises(id uuid,source_base_url text,registered_solver_id uuid)",
];

async function fixture(db: DB, id: string, points: number, opts: {
  remote?: ProgressiveEvidenceCustodyReceipt["remote"]; base?: string;
} = {}) {
  const unit = {unitId:randomUUID(),token:randomUUID(),alpha:0,activeBudgetSeconds:900};
  const assignment = opts.base ? sealProgressiveRemoteExecution({solverId:solver,promiseId,
    scope:{executionContract:"progressive-cfd-v1",executionId:id,epochId:randomUUID(),generationId:randomUUID(),
      targetId:"a".repeat(64),recipeId:"b".repeat(64),stage:2,units:[unit],tokens:[unit.token]},
    request:{execution_id:id,expected_engine:{...OPENCFD_2606_ENGINE},expected_execution_pool:"test-pool",
      expected_solver_budget_version:2,expected_mesh_recovery_version:1,airfoil:{name:"normal retention fixture"},
      chord_lengths:[1],speeds:[30],aoa:{angles:[0]},solver:{warm_start:true},
      resources:{case_concurrency:1,case_solver_budget_seconds:900}}}) : undefined;
  const req = {remoteSolver:true,remoteProgressiveExecution:assignment ?? {},syncPromiseId:promiseId,upstreamBaseUrl:opts.base ?? root};
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
    const remote = opts.remote ?? {
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
      (${randomUUID()},'manifest',${result},${attempt},${id},${storage.replace("engine_evidence.tar.zst", "evidence_manifest.json")},'{}',${remote.manifestSha256},${remote.manifestByteSize},'application/json')`);
    await db.execute(
      sql`INSERT INTO remote_asset_references VALUES(${bundle},'evidence_artifact',${attempt},${result},${storage},${remote.storedSha256},${remote.storedByteSize},'application/zstd','remote_only',${JSON.stringify({ ...remote, brokeredUploadId: upload })}::jsonb,${receipt.canonical.resultId},${receipt.canonical.artifactId},${(opts.base ?? root) + "/evidence-uploads/" + upload + "/download"})`,
    );
    objects.push({ attempt, upload, remote, signed, assignment });
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
    await db.execute(sql`INSERT INTO sweeper_state(id) VALUES(1)`);
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
      await db.execute(sql`INSERT INTO progressive_worker_archive_reclaims (sim_job_id,point_content_signature,completed_at)
        SELECT id,'ineligible',now() FROM sim_jobs WHERE status='done' AND request_payload IS NULL`);
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

it("runs the default sweeper past eight held jobs, restores every member, and resumes post-read verification", async () => {
  const volume = await mkdtemp(join(tmpdir(),"automatic-closed-retention-"));
  const jobs = join(volume,"jobs");
  await mkdir(jobs);
  const schema = "auto_retention_" + randomUUID().replaceAll("-","");
  const originalRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
  process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
  const open = () => createClient({max:1,connection:{search_path:schema+",public",application_name:"automatic-retention-fixture"}});
  let connection = open();
  const owned = (i: number) => "00000000-0000-4000-a000-"+String(i).padStart(12,"0");
  const original = new Map<string, { path: string; remote: ProgressiveEvidenceCustodyReceipt["remote"]; hits: number; failPost: boolean }>();
  const historicalOwner=owned(9), bad=owned(10), good=owned(11), transferred=owned(12), oldHub=owned(13);
  const assignments=new Map<string,string>(), protectedJobs=new Set([historicalOwner]), ownerProbes=new Map<string,number>();
  const server = createServer(async (req,res) => {
    if (req.headers["x-xfoilfoam-solver-token"]!==token) {res.writeHead(403).end();return;}
    const owner = req.url?.match(/^\/api\/sync\/v1\/progressive-executions\/([a-f0-9-]+)\/historical-raw-archives\/retention-owner$/)?.[1];
    if (owner) {
      ownerProbes.set(owner,(ownerProbes.get(owner)??0)+1);
      if (owner===oldHub) { res.writeHead(404).end();return; }
      res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({version:1,executionId:owner,solverId:solver,promiseId,
        assignmentSignature:assignments.get(owner),historicalRaw:protectedJobs.has(owner)}));
      return;
    }
    const source = original.get(req.url?.split("/").at(-2) ?? "");
    if (!source || req.headers["x-xfoilfoam-solver-token"] !== token) { res.writeHead(403).end(); return; }
    source.hits++;
    if (source.path.endsWith(transferred+".tar.zst")) protectedJobs.add(transferred);
    if (source.failPost && source.hits===2) {res.writeHead(503).end("unavailable");return;}
    const bytes=await readFile(source.path);
    res.writeHead(200,{"content-type":"application/zstd","content-length":bytes.length,
      "x-content-sha256":source.remote.storedSha256,"x-gcs-generation":source.remote.generation}).end(bytes);
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();
  if (!address || typeof address==="string") throw Error("Archive server has no address");
  const upstream=`http://127.0.0.1:${address.port}/api/sync/v1`;
  const rootPath=fileURLToPath(new URL("../../../",import.meta.url));
  const python=process.env.AIRFOILFOAM_RETENTION_PYTHON || join(rootPath,".venv/bin/python");
  const sourceFixture=fileURLToPath(new URL("../test-support/automatic-retention-source.py",import.meta.url));
  const generate = (job: string,action: string,signed?: unknown) => JSON.parse(execFileSync(python,
    ["-B",sourceFixture,volume,job,action],{cwd:rootPath,env:{...process.env,PYTHONPATH:join(rootPath,"src")},input:signed?JSON.stringify(signed):""}).toString());
  const scratch="orphan-closed-scratch",historical="orphan-unreported-source",referenced="orphan-path-owner";
  const sourceFile=(job: string) => join(jobs,job,"cases/foil/transient_a0/log.pimpleFoam");
  const engine = {maintenanceJobs:vi.fn(async () => ({items:[scratch,historical,referenced].map(job_id=>({job_id,mtime_epoch:1,bytes:null}))})),
    maintenanceDisk:vi.fn(async()=>({used_pct:31})),deleteJob:vi.fn(()=>{throw Error("raw directory deletion was called")}),
    stripJob:vi.fn(()=>{throw Error("raw engine strip was called")})} as unknown as EngineClient;
  const captureErrors=vi.spyOn(console,"error");
  const tick=async (index:number,cap:number) => {
    await retentionTick(connection.db,engine,{mediaDir:volume,now:new Date(clock.getTime()+index*3600_000),
      stripMinAgeMs:1,stripMaxPerTick:cap,orphanMinAgeMs:1000});
  };
  try {
    await client.db.execute(sql.raw("CREATE SCHEMA "+schema));
    for (const def of tableDefinitions) await connection.db.execute(sql.raw("CREATE TABLE "+def));
    // Keep the fixture's positional columns while supplying other real columns
    // consulted by generic retention on the very same normal tick.
    for (const def of tableDefinitions) {
      const name=def.slice(0,def.indexOf("("));
      const missing=await connection.db.execute(sql`SELECT p.attname AS name,format_type(p.atttypid,p.atttypmod) AS type
        FROM pg_attribute p WHERE p.attrelid=to_regclass(${"public."+name}) AND p.attnum>0 AND NOT p.attisdropped AND NOT EXISTS(
          SELECT FROM pg_attribute f WHERE f.attrelid=to_regclass(${schema+"."+name}) AND f.attnum>0 AND NOT f.attisdropped AND f.attname=p.attname)`);
      for (const col of missing) await connection.db.execute(sql`ALTER TABLE ${sql.identifier(name)} ADD COLUMN ${sql.identifier(String(col.name))} ${sql.raw(String(col.type))}`);
    }
    await connection.db.execute(sql`INSERT INTO sweeper_state(id,disk_admission_blocked) VALUES(1,false)`);
    await connection.db.execute(sql`INSERT INTO sync_api_settings(id,remote_solver_registered_id,remote_solver_auth_token,upstream_base_url) VALUES(1,${solver},${token},${upstream})`);
    await connection.db.execute(sql`INSERT INTO sync_sweep_promises(id,source_base_url,registered_solver_id) VALUES(${promiseId},${upstream},${solver})`);
    for (let i=1;i<=8;i++) {
      const [point]=await fixture(connection.db,owned(i),1,{base:upstream});
      await connection.db.execute(sql`INSERT INTO result_media(id,result_attempt_id,storage_key) VALUES(${randomUUID()},${point!.attempt},${`jobs/${owned(i)}/unique.png`})`);
      await mkdir(join(jobs,owned(i)),{recursive:true});await writeFile(join(jobs,owned(i),"unique.png"),"locally retained bytes");
    }
    for (const id of [historicalOwner,bad,good,transferred,oldHub]) {
      const remote=generate(id,id===bad?"bad-member":"good") as ProgressiveEvidenceCustodyReceipt["remote"];
      const [point]=await fixture(connection.db,id,1,{remote,base:upstream});assignments.set(id,point!.assignment!.contentSignature);
      if (id!==historicalOwner) generate(id,"bind",point!.signed);
      await connection.db.execute(sql`UPDATE result_attempts SET regime='urans',status='failed',valid_for_polar=false,
        converged=false,cl=0.43,cd=0.018,cm=-0.03,evidence_payload='{"force_history":{"t":[0.01,0.02],"cl":[0.42,0.43],"cd":[0.02,0.018]}}'::jsonb WHERE id=${point!.attempt}`);
      original.set(point!.upload,{path:join(volume,id+".tar.zst"),remote,hits:0,failPost:id===good});
    }
    for (const id of [scratch,historical,referenced]) {
      await mkdir(join(jobs,id));await writeFile(join(jobs,id,"request.json"),"{}");
      await writeFile(join(jobs,id,"status.json"),JSON.stringify({job_id:id,state:"cancelled",completed_cases:0}));
      await writeFile(join(jobs,id,".execute.lock"),"");
    }
    await mkdir(join(jobs,historical,"cases/foil"),{recursive:true});
    await writeFile(join(jobs,historical,"cases/foil/coefficient.dat"),"unique finite coefficient history");
    await connection.db.execute(sql`INSERT INTO field_render_cache(storage_key) VALUES(${`jobs/${referenced}/status.json`})`);
    for(const id of [scratch,historical,referenced])await utimes(join(jobs,id),new Date(0),new Date(0));
    const science=async()=>connection.db.execute(sql`SELECT id,result_id,status,valid_for_polar,cl,cd,cm,evidence_payload::text AS original FROM result_attempts WHERE sim_job_id=${good}::uuid`);
    const initial=await science();
    const savedPython=process.env.AIRFOILFOAM_RETENTION_PYTHON;
    process.env.AIRFOILFOAM_RETENTION_PYTHON=join(volume,"uninstalled-verifier");
    try {
      resetRetentionMemory();await tick(0,8);
      expect(existsSync(join(jobs,scratch,"status.json"))).toBe(true);
      expect((await connection.db.execute(sql`SELECT closed_progressive_retention_after_id AS cursor FROM sweeper_state WHERE id=1`))[0]!.cursor).toBeNull();
      expect(engine.deleteJob).not.toHaveBeenCalled();expect(engine.stripJob).not.toHaveBeenCalled();
    } finally {
      if(savedPython===undefined)delete process.env.AIRFOILFOAM_RETENTION_PYTHON;else process.env.AIRFOILFOAM_RETENTION_PYTHON=savedPython;
    }
    resetRetentionMemory();await tick(0,8);
    expect((await connection.db.execute(sql`SELECT closed_progressive_retention_after_id AS cursor FROM sweeper_state WHERE id=1`))[0]!.cursor).toBe(owned(8));
    expect([...original.values()].every(x=>x.hits===0)).toBe(true);
    for(let i=1;i<=8;i++)expect(await readFile(join(jobs,owned(i),"unique.png"),"utf8")).toBe("locally retained bytes");
    expect(existsSync(join(jobs,scratch))).toBe(false);
    expect(existsSync(join(jobs,referenced,"status.json"))).toBe(true);
    expect(await readFile(join(jobs,historical,"cases/foil/coefficient.dat"),"utf8")).toBe("unique finite coefficient history");
    await connection.sql.end();connection=open();resetRetentionMemory();
    await tick(1,2);
    expect(await readFile(join(jobs,historicalOwner,"cases/foil/a0/evidence/engine_evidence.tar.zst"))).toEqual(await readFile(join(volume,historicalOwner+".tar.zst")));
    expect((await connection.db.execute(sql`SELECT strip_report#>>'{closedProgressiveScan,reason}' AS held FROM sim_jobs WHERE id=${historicalOwner}`))[0]!.held).toBe("historical-raw-owner");
    expect(existsSync(sourceFile(bad))).toBe(true);
    expect((await connection.db.execute(sql`SELECT strip_report#>>'{closedProgressiveScan,reason}' AS held FROM sim_jobs WHERE id=${bad}`))[0]!.held).toBe("archive-restore");
    await tick(2,1);
    const receipt=async()=> (await connection.db.execute(sql`SELECT stripped_at,strip_report->'closedProgressiveFiles' AS files FROM sim_jobs WHERE id=${good}::uuid`))[0]!;
    expect(existsSync(sourceFile(good))).toBe(false);
    expect(await receipt()).toMatchObject({stripped_at:null,files:{complete:false,files:2,automaticVerification:{state:"awaiting-readback"}}});
    // A different process can finish the outstanding post-read after the normal retry is due.
    await connection.sql.end();connection=open();resetRetentionMemory();
    await connection.db.execute(sql`UPDATE sim_jobs SET strip_report=jsonb_set(strip_report,'{closedProgressiveScan,retryAfter}',to_jsonb((clock_timestamp()-interval '1 second')::text)) WHERE id=${good}`);
    await tick(3,2);
    expect(existsSync(sourceFile(transferred))).toBe(true);
    expect(existsSync(sourceFile(oldHub))).toBe(true);
    expect((await connection.db.execute(sql`SELECT strip_report#>>'{closedProgressiveScan,reason}' AS held FROM sim_jobs WHERE id=${oldHub}`))[0]!.held).toBe("registered-owner-unavailable");
    expect(ownerProbes.get(transferred)).toBe(2);
    await tick(4,1); // genuinely empty tail wraps the persisted cursor
    await tick(5,1);
    expect(await receipt()).toMatchObject({stripped_at:null,files:{complete:true,files:2,verifiedArchives:1,automaticVerification:{state:"verified"}}});
    expect(await science()).toEqual(initial);
    expect(await readFile(join(jobs,good,"cases/foil/transient_a0/0.5/U"),"utf8")).toBe("unarchived original field");
    expect(await readFile(join(jobs,good,"cases/foil/transient_a0/1/p"),"utf8")).toBe("latest pressure");
    expect([...original.values()].map(x=>x.hits)).toEqual([0,1,3,1,0]);
    // A future closed execution can sort before the current durable cursor.
    const future=owned(0), remote=generate(future,"good") as ProgressiveEvidenceCustodyReceipt["remote"];
    const [late]=await fixture(connection.db,future,1,{remote,base:upstream});
    assignments.set(future,late!.assignment!.contentSignature);generate(future,"bind",late!.signed);
    await connection.db.execute(sql`UPDATE result_attempts SET regime='urans',status='failed',valid_for_polar=false WHERE id=${late!.attempt}`);
    original.set(late!.upload,{path:join(volume,future+".tar.zst"),remote,hits:0,failPost:false});
    await tick(6,1);await tick(7,1);await tick(8,1);
    expect(original.get(late!.upload)?.hits).toBe(2);
    expect(existsSync(sourceFile(future))).toBe(false);
    expect((await connection.db.execute(sql`SELECT stripped_at,strip_report->'closedProgressiveFiles' AS receipt FROM sim_jobs WHERE id=${future}`))[0])
      .toMatchObject({stripped_at:null,receipt:{complete:true,automaticVerification:{state:"verified"}}});
    expect(engine.deleteJob).not.toHaveBeenCalled();expect(engine.stripJob).not.toHaveBeenCalled();
    expect(captureErrors.mock.calls.flat().map(String).filter(v=>v.includes("Failed query")||v.includes("strip reaper failed"))).toEqual([]);
  } finally {
    captureErrors.mockRestore();resetRetentionMemory();
    if(originalRole===undefined)delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE=originalRole;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await connection.sql.end();
    await client.db.execute(sql.raw("DROP SCHEMA IF EXISTS "+schema+" CASCADE"));await rm(volume,{recursive:true,force:true});
  }
},90000);

it.each(["rans", "urans", "superseded-urans"])("keeps %s point-owned images and checks every route, legend and working-file reference", async (scenario) => {
  const superseded = scenario === "superseded-urans";
  const regime = superseded ? "urans" : scenario;
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
    const pickedAttempt = randomUUID(), pickedJob = randomUUID(), pickedMedia = randomUUID();
    if (superseded) {
      await db.execute(sql`INSERT INTO result_attempts(id,result_id,sim_job_id,engine_job_id,airfoil_id,regime)
        VALUES(${pickedAttempt},${rid},${pickedJob},${pickedJob},${foil},'urans')`);
      await db.execute(sql`INSERT INTO result_media(id,result_id,result_attempt_id,storage_key,kind,role,field,mime_type,sha256,byte_size,color_scale_id)
        VALUES(${pickedMedia},${rid},${pickedAttempt},${`jobs/${pickedJob}/${nativePath}`},'image','instantaneous',${field},'image/png',${sha("newpng")},6,${scale})`);
      await db.execute(sql`UPDATE results SET current_result_attempt_id=${pickedAttempt} WHERE id=${rid}`);
    }
    let priorStatus = 404, wrongPriorError = false, pickedUsesOldMedia = false, corruptPicked = false;
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
        const prior = u.searchParams.get("resultAttemptId") === item!.attempt;
        if (path.endsWith("/sim") && prior && priorStatus !== 200)
          return Response.json({error: wrongPriorError ? "unknown route" : "no solved OpenFOAM result for this point"}, {status: priorStatus});
        if (path.endsWith("/sim"))
          return Response.json({
            resultId: rid,
            media: {
              [swapped ? "vorticity" : "pressure"]: {
                kind: "image",
                url: `/api/result-media/${superseded && !prior && !pickedUsesOldMedia ? pickedMedia : media}`,
                scale: wrongLegend ? { ...legend, vmax: 2 } : legend,
              },
            },
          });
        const value = path === `/api/result-media/${pickedMedia}` ? (corruptPicked ? "broken" : "newpng") :
          path === `/api/result-media/${media}` ? registeredBytes :
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
      if (superseded) {
        expect(routes).toContain(`/api/result-media/${pickedMedia}`);
        pickedUsesOldMedia = true;
        await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(/link or color legend/);
        pickedUsesOldMedia = false;
        corruptPicked = true;
        await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(/different bytes/);
        corruptPicked = false;
        wrongPriorError = true;
        await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(/changed owner/);
        wrongPriorError = false;
        priorStatus = 403;
        await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(/unavailable/);
        priorStatus = 200;
        await expect(closedProgressiveJob(db, native, id, { ...opts, expectedMediaSha256: preview.mediaSha256 })).rejects.toThrow(/differ from the pinned proof/);
        priorStatus = 404;
        await db.execute(sql`UPDATE result_media SET result_id=${randomUUID()} WHERE id=${pickedMedia}`);
        await expect(closedProgressiveJob(db, native, id, opts)).rejects.toThrow(/exact current-job/);
        await db.execute(sql`UPDATE result_media SET result_id=${rid} WHERE id=${pickedMedia}`);
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

it.each([false,true])("keeps an unreported solver readable and records only its signed siblings as released (linked continuation %s)", async (linked) => {
  await client.db.transaction(async (tx) => {
    const db = tx as unknown as DB;
    for (const definition of tableDefinitions)
      await db.execute(sql.raw("CREATE TEMP TABLE " + definition + " ON COMMIT DROP"));
    await db.execute(sql`ALTER TABLE sync_sweep_promises ADD status text`);
    await db.execute(sql`ALTER TABLE sync_api_settings ADD remote_solver_transfer_paused boolean DEFAULT false`);
    await db.execute(sql`INSERT INTO sync_api_settings VALUES(1,${solver},${token},${root})`);
    await db.execute(sql`INSERT INTO sync_sweep_promises VALUES(${promiseId},${root},${solver},'cancelled')`);
    const id = randomUUID();
    const [signed] = await fixture(db, id, 1);
    await db.execute(sql`UPDATE sim_jobs SET status='cancelled' WHERE id=${id}`);
    await db.execute(sql`UPDATE result_attempts SET regime='urans' WHERE id=${signed!.attempt}`);
    const child = randomUUID(), childCase = "foil_a12", childPromise = randomUUID();
    if (linked) {
      const foil = randomUUID(), revision = randomUUID();
      await db.execute(sql`ALTER TABLE sim_jobs ADD airfoil_id uuid,ADD simulation_preset_revision_id uuid,ADD engine_state text`);
      await db.execute(sql`UPDATE sim_jobs SET airfoil_id=${foil},simulation_preset_revision_id=${revision},engine_state='cancelled' WHERE id=${id}`);
      await db.execute(sql`INSERT INTO sync_sweep_promises VALUES(${childPromise},${root},${solver},'expired')`);
      const req={syncPromiseId:childPromise,upstreamBaseUrl:root,engineRequest:{continue_from:{engine_job_id:id,case_slug:"foil"}}};
      await db.execute(sql`INSERT INTO sim_jobs(id,status,engine_job_id,engine_state,airfoil_id,simulation_preset_revision_id,request_payload)
        VALUES(${child},'cancelled',${child},'failed',${foil},${revision},${JSON.stringify(req)}::jsonb)`);
    }
    const directory = "cases/foil/transient_a1";
    const sample = { path: directory + "/postProcessing/forces/0/coefficient.dat", sha256: sha("0.1 0.03"), byteSize: 8 };
    const kept = { directory, treeSha256: "a".repeat(64), entries: 6, files: 2, byteSize: 80, allocatedBytes: 8192, sample, ...(linked?{linkedContinuation:{jobId:child,caseSlug:childCase,sharedFiles:2,otherLinks:3,pathSetSha256:"d".repeat(64)}}:{}) };
    const unit = {unitId:randomUUID(),token:randomUUID(),alpha:0,activeBudgetSeconds:900};
    const envelope = sealProgressiveRemoteExecution({solverId:solver,promiseId,scope:{executionContract:"progressive-cfd-v1",
      executionId:id,epochId:randomUUID(),generationId:randomUUID(),targetId:"a".repeat(64),recipeId:"b".repeat(64),stage:2,
      units:[unit],tokens:[unit.token]},request:{execution_id:id,expected_engine:{...OPENCFD_2606_ENGINE},expected_execution_pool:"test-pool",
        expected_solver_budget_version:2,expected_mesh_recovery_version:1,airfoil:{name:"closed-source-fixture"},chord_lengths:[1],speeds:[30],
        aoa:{angles:[0]},solver:{warm_start:true},resources:{case_concurrency:1,case_solver_budget_seconds:900}}});
    await db.execute(sql`UPDATE sim_jobs SET request_payload=request_payload||${JSON.stringify({remoteSolver:true,remoteProgressiveExecution:envelope})}::jsonb WHERE id=${id}`);
    await db.execute(sql`ALTER TABLE progressive_worker_reports ADD sequence bigint,ADD content_signature text,ADD assignment_signature text`);
    await db.execute(sql`UPDATE progressive_worker_reports SET sequence=1,content_signature=${sha("report")},assignment_signature=${envelope.contentSignature}`);
    let applied = 0, broken = false, overlap = false, childBusyAfterFetch = false;
    let hubState = "active", hubJob = "cancelled", stopped = true, hubSequence = 1, foreign = false, http = 200, resumeOnDownload = false;
    let changeAfterRead: "report" | "envelope" | null = null, sawDownload = false;
    const originalRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
    const backend: ClosedProgressiveBackend = {
      async reclaimClosedProgressiveFiles(job, manifests, expected, objects) {
        expect(manifests).toHaveLength(1);
        expect(manifests[0]).toMatchObject({ directory: "cases/foil/a0/evidence", regime: "urans" });
        if (expected) {
          expect(objects?.map(o => o.brokeredUploadId)).toEqual([signed!.upload]);
          applied++;
        }
        return { job_id: job, state: expected ? "reclaimed" : "planned", replayed: applied > 0,
          plan: "5".repeat(64), files: 1, bytes: 30, mediaFiles: [],
          workingPaths: [overlap ? sample.path : "cases/foil/transient_a0/log.pimpleFoam"], preservedSolver: kept };
      },
    };
    const routes: string[] = [];
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url,init) => {
      const path = new URL(String(url)).pathname;
      routes.push(path);
      if (path === `/api/sync/v1/progressive-executions/${id}`) {
        expect(new Headers(init?.headers).get("x-xfoilfoam-solver-token")).toBe(token);
        if (sawDownload && changeAfterRead === "report")
          await db.execute(sql`UPDATE progressive_worker_reports SET content_signature=${sha("different stop")}`);
        if (sawDownload && changeAfterRead === "envelope")
          await db.execute(sql`UPDATE sim_jobs SET request_payload=jsonb_set(request_payload,
            '{remoteProgressiveExecution,request,airfoil,name}','"changed after the registered read"') WHERE id=${id}`);

        if (http !== 200) return Response.json({error:"unavailable"}, {status:http});
        return Response.json({assignment:{envelope:foreign?{...envelope,promiseId:randomUUID()}:envelope,
          receivedSequence:hubSequence,executionStopped:stopped,job:{status:hubJob,engineState:"cancelled"},promise:{id:promiseId,status:hubState}},
          continuation:{kind:"stop"}});
      }
      if (path.endsWith("/download")) {
        sawDownload = true;
        if (resumeOnDownload) hubState="active";
        if (childBusyAfterFetch) await db.execute(sql`UPDATE sim_jobs SET status='ingesting',ingest_lease_token=${randomUUID()},ingest_lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=${child}`);
        return new Response(signed!.upload, {headers: {"content-type":"application/zstd","content-length":String(signed!.upload.length),
          "x-content-sha256":signed!.remote.storedSha256,"x-gcs-generation":signed!.remote.generation}});
      }
      expect(path.endsWith(sample.path)).toBe(true);
      return new Response(broken ? "different" : "0.1 0.03", {headers:{"content-length":"8"}});
    });
    const options = {now:clock,ageMs:1,timeoutMs:3000,keepMedia:true,preserveSolver:directory,...(linked?{linkedContinuation:child+"/"+childCase}:{})};
    try {
      const preview = await closedProgressiveJob(db,backend,id,{...options,inspect:true});
      const pinned = {...options, expectedPlan:preview.plan.plan!,expectedMediaSha256:preview.mediaSha256,expectedScientificSha256:preview.scientificSha256};
      expect(routes).toContain(`/jobs/${id}/files/${sample.path}`);
      expect(routes).toContain(`/api/media/jobs/${id}/${sample.path}`);
      await expect(closedProgressiveJob(db,backend,id,{...options,inspect:true,preserveSolver:undefined,linkedContinuation:undefined})).rejects.toThrow(/Unexpected preserved|continuation links differ/);
      await expect(closedProgressiveJob(db,backend,id,{...options,inspect:true,preserveSolver:"cases/foil/transient_a0"})).rejects.toThrow(/next unreported/);
      await expect(closedProgressiveJob(db,backend,id,options)).rejects.toThrow(/exact plan/);
      overlap = true;
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow(/inventory differs/);
      overlap = false;broken = true;
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow();
      broken = false;
      await db.execute(sql`UPDATE sync_sweep_promises SET status='active' WHERE id=${promiseId}`);
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow(/active ownership/);
      hubState="cancelled";hubJob="ingesting";
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow(/active ownership/);
      hubJob="cancelled";stopped=false;
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow(/active ownership/);
      stopped=true;hubSequence=2;
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow(/active ownership/);
      hubSequence=1;http=403;
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow(/HTTP 403/);
      http=200;foreign=true;
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow(/stored assignment/);
      foreign=false;
      await db.execute(sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true`);
      const readsBeforePause=routes.length;
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow(/paused/);
      expect(routes).toHaveLength(readsBeforePause);
      await db.execute(sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=false`);
      const stalePreview=await closedProgressiveJob(db,backend,id,{...options,inspect:true});
      expect(stalePreview.registeredTerminalPromiseSha256).toMatch(/^[a-f0-9]{64}$/);
      const bound={...pinned,expectedRegisteredStopSha256:stalePreview.registeredTerminalPromiseSha256!};
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow(/pinned read-only proof/);
      await expect(closedProgressiveJob(db,backend,id,{...bound,expectedRegisteredStopSha256:"0".repeat(64)})).rejects.toThrow(/pinned read-only proof/);
      resumeOnDownload=true;
      await expect(closedProgressiveJob(db,backend,id,bound)).rejects.toThrow(/active ownership/);
      resumeOnDownload=false;hubState="cancelled";
      for (const change of ["report","envelope"] as const) {
        sawDownload=false;changeAfterRead=change;
        expect((await closedProgressiveJob(db,backend,id,bound)).settled).toBe(false);
        await db.execute(sql`UPDATE progressive_worker_reports SET content_signature=${sha("report")}`);
        await db.execute(sql`UPDATE sim_jobs SET request_payload=jsonb_set(request_payload,'{remoteProgressiveExecution}',${JSON.stringify(envelope)}::jsonb)
          WHERE id=${id}`);
      }
      changeAfterRead=null;
      await db.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=NULL`);
      await expect(closedProgressiveJob(db,backend,id,pinned)).rejects.toThrow(/acknowledged stop/);
      await db.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp()`);
      expect(applied).toBe(0);
      if (linked) {
        await expect(closedProgressiveJob(db,backend,id,{...bound,linkedContinuation:randomUUID()+"/"+childCase})).rejects.toThrow(/does not own/);
        await expect(closedProgressiveJob(db,backend,id,{...bound,linkedContinuation:child+"/wrong"})).rejects.toThrow(/links differ/);
        await db.execute(sql`UPDATE sim_jobs SET request_payload=jsonb_set(request_payload,'{engineRequest,continue_from,engine_job_id}',to_jsonb(${randomUUID()}::text)) WHERE id=${child}`);
        await expect(closedProgressiveJob(db,backend,id,bound)).rejects.toThrow(/does not own/);
        await db.execute(sql`UPDATE sim_jobs SET request_payload=jsonb_set(request_payload,'{engineRequest,continue_from,engine_job_id}',to_jsonb(${id}::text)) WHERE id=${child}`);
        childBusyAfterFetch=true;
        await expect(closedProgressiveJob(db,backend,id,bound)).rejects.toThrow(/busy/);
        childBusyAfterFetch=false;
        await db.execute(sql`UPDATE sim_jobs SET status='cancelled',ingest_lease_token=NULL,ingest_lease_expires_at=NULL WHERE id=${child}`);
        expect(applied).toBe(0);
      }
      const settled=await closedProgressiveJob(db,backend,id,bound);
      expect(settled.settled).toBe(true);
      expect(settled.registeredTerminalPromise).toMatchObject({promiseId,executionId:id,solverId:solver,receivedSequence:1,
        assignmentSignature:envelope.contentSignature,stoppedReportSignature:sha("report"),promiseState:"cancelled"});
      const [unchanged]=await db.execute(sql`SELECT status FROM sync_sweep_promises WHERE id=${promiseId}`);
      expect(unchanged!.status).toBe("active");
      await db.execute(sql`UPDATE sync_sweep_promises SET status='cancelled' WHERE id=${promiseId}`);
      hubSequence=2;
      await expect(closedProgressiveJob(db,backend,id,{...bound,inspect:true,verifyCompleted:true})).rejects.toThrow(/active ownership/);
      hubSequence=1;
      const after = await closedProgressiveJob(db,backend,id,{...bound,inspect:true,verifyCompleted:true});
      expect(after.registeredTerminalPromiseSha256).toBe(stalePreview.registeredTerminalPromiseSha256);
      expect(after.plan.preservedSolver).toEqual(kept);
      const [job] = await db.execute(sql`SELECT stripped_at,strip_report FROM sim_jobs WHERE id=${id}`);
      expect(job!.stripped_at).toBeNull();
      expect(job!.strip_report).toMatchObject({closedProgressiveSiblingFiles:{complete:true,outcome:"signed-sibling-working-files",preservedSolver:kept}});
      expect(job!.strip_report).not.toHaveProperty("closedProgressiveFiles");
      expect(applied).toBe(1);
    } finally {
      fetcher.mockRestore();
      if (originalRole === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
      else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = originalRole;
    }
  });
},30000);

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
