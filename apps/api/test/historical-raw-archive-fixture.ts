import { Readable } from "node:stream";
import { transferHistoricalRawArchive } from "../../sweeper/src/historical-raw-archive";
import { CRC32C, Storage, type Bucket } from "@google-cloud/storage";
import { EngineClient } from "@aerodb/engine-client";
import {
  analysisContentHash,
  progressiveReportedPointSources,
  storeProgressiveRemoteReport,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import { env } from "../src/env";
import { withProgressiveSyncApi } from "./progressive-polar-import-fixture";
import { progressiveArchiveManifestBytes as manifest } from "../../../packages/db/test/progressive-archive-data";
import { progressiveRemoteEvidenceResult } from "../../../packages/db/test/progressive-remote-evidence-fixture";
import { applyProgressiveRemoteProgress } from "../../sweeper/src/progressive-remote-progress";

const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const generation = "18446744073709551615";

async function verifyDeployedMigrations(db: DB) {
  const root = new URL("../../../", import.meta.url);
  const required = JSON.parse(
    await readFile(
      new URL("scripts/deploy/historical-raw-archive-manifest.json", root),
      "utf8",
    ),
  ) as {
    journal: string;
    migrations: { idx: number; tag: string; when: number; sha256: string }[];
  };
  const journal = JSON.parse(
    await readFile(new URL(required.journal, root), "utf8"),
  ) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  expect(required.migrations.map((m) => [m.idx, m.tag])).toEqual([
    [219, "0219_hub_shared_report_objects"],
    [220, "0220_historical_raw_archive_custody"],
  ]);
  for (const migration of required.migrations) {
    const { idx, tag, when } = migration;
    expect(
      journal.entries.filter(
        (e) => e.idx === idx || e.tag === tag || e.when === when,
      ),
    ).toEqual([expect.objectContaining({ idx, tag, when })]);
    expect(
      sha(await readFile(new URL(`packages/db/migrations/${tag}.sql`, root))),
    ).toBe(migration.sha256);
  }
  expect(required.migrations[0].when).toBeLessThan(required.migrations[1].when);
  const rows =
    await db.execute(sql`SELECT hash,created_at::text AS key FROM drizzle.__drizzle_migrations
    WHERE created_at IN (${required.migrations[0].when}::bigint,${required.migrations[1].when}::bigint) ORDER BY id`);
  expect(Array.from(rows)).toEqual(
    required.migrations.map((m) => ({ hash: m.sha256, key: String(m.when) })),
  );
  const [schema] =
    await db.execute(sql`SELECT EXISTS(SELECT FROM pg_constraint WHERE
    conrelid='public.progressive_report_archive_bundles'::regclass AND conname='progressive_report_archive_bundles_archive_format_check'
    AND pg_get_constraintdef(oid) LIKE '%shared-result-v1%') AS shared,
    EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.progressive_historical_raw_archives'::regclass
      AND tgname='historical_raw_archive_immutable' AND tgenabled='O') AS custody`);
  expect(schema).toEqual({ shared: true, custody: true });
}

export async function verifyHistoricalRawArchive(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  await verifyDeployedMigrations(db);
  const dir = await mkdtemp(join(tmpdir(), "closed-raw-test-"));
  const prevRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE,
    prevBucket = env.evidenceBucket;
  const rollback = new Error("rollback historical raw fixture");
  await writeFile(join(dir, "forceCoeffs.dat"), "0 0.4 0.03 0\n");
  await writeFile(join(dir, "evidence_manifest.json"), manifest);
  const tar = execFileSync("tar", [
    "-C",
    dir,
    "-cf",
    "-",
    "forceCoeffs.dat",
    "evidence_manifest.json",
  ]);
  const bytes = execFileSync("zstd", ["-q", "-10", "-c"], { input: tar });
  const crc = new CRC32C();
  crc.update(bytes);
  const key =
    "solver-evidence/v1/sha256/" +
    sha(bytes).slice(0, 2) +
    "/" +
    sha(bytes) +
    ".tar.zst";
  let cloud: { bytes: Buffer; metadata: Record<string, unknown> } | undefined;
  let uploads = 0,
    reads = 0,
    failRead = false;
  const missing = () =>
    Object.assign(new Error("fixture object missing"), { code: 404 });
  const storage = vi.spyOn(Storage.prototype, "bucket").mockImplementation(
    () =>
      ({
        upload: async (
          path: string,
          opts: {
            destination: string;
            preconditionOpts: unknown;
            metadata: Record<string, unknown>;
          },
        ) => {
          expect(opts.destination).toBe(key);
          expect(opts.preconditionOpts).toEqual({ ifGenerationMatch: 0 });
          if (cloud)
            throw Object.assign(new Error("immutable object exists"), {
              code: 412,
            });
          cloud = {
            bytes: await readFile(path),
            metadata: {
              ...opts.metadata,
              size: String(bytes.length),
              generation,
              crc32c: crc.toString(),
              timeCreated: new Date().toISOString(),
            },
          };
          uploads++;
        },
        file: (k: string) => {
          const interceptors: {
            request(o: unknown): { qs: { generation: string } };
          }[] = [];
          return {
            interceptors,
            createReadStream: (options: unknown) => {
              expect(options).toEqual({
                validation: "crc32c",
                decompress: false,
              });
              if (
                !cloud ||
                k !== key ||
                interceptors[0]?.request({
                  uri: "https://fixture.invalid",
                  qs: {},
                }).qs.generation !== generation
              )
                throw missing();
              return Readable.from([cloud.bytes]);
            },
            getMetadata: async () => {
              if (
                k !== key ||
                !cloud ||
                (interceptors.length &&
                  interceptors[0].request({
                    uri: "https://fixture.invalid",
                    qs: {},
                  }).qs.generation !== generation)
              )
                throw missing();
              return [cloud.metadata];
            },
          };
        },
      }) as unknown as Bucket,
  );
  // The object network is doubled. Read all compressed and uncompressed bytes and each real tar member.
  const engine = vi
    .spyOn(EngineClient.prototype, "verifyRemoteEvidenceManifest")
    .mockImplementation(async (req) => {
      if (!cloud || failRead) throw new Error("failed pinned reread");
      expect(req.remote.generation).toBe(generation);
      expect(sha(cloud.bytes)).toBe(req.remote.storedSha256);
      expect(cloud.bytes.length).toBe(req.remote.storedSize);
      const decoded = execFileSync("zstd", ["-q", "-dc"], {
        input: cloud.bytes,
      });
      expect(sha(decoded)).toBe(req.remote.tarSha256);
      expect(decoded.length).toBe(req.remote.tarSize);
      const original = execFileSync(
        "tar",
        ["-xOf", "-", "evidence_manifest.json"],
        { input: decoded },
      );
      expect(original.toString("base64")).toBe(req.manifestBase64);
      expect(sha(original)).toBe(req.manifestSha256);
      for (const f of JSON.parse(original.toString()).files) {
        const member = execFileSync("tar", ["-xOf", "-", f.path], {
          input: decoded,
        });
        expect(sha(member)).toBe(f.sha256);
        expect(member.length).toBe(f.byteSize);
      }
      reads++;
      return { state: "verified", ...req };
    });
  try {
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
    env.evidenceBucket = "historical-raw-fixture";
    await db
      .transaction(async (tx) => {
        const cx = tx as unknown as DB,
          job = envelope.scope.executionId;
        const result = progressiveRemoteEvidenceResult(envelope);
        result.state = "completed";
        const point = result.polars[0].attempts![0];
        const base = "a0/evidence";
        const meta = { evidenceBase: base, bundledFileCount: 1 };
        point.evidence_artifacts = [
          {
            kind: "manifest",
            path: base + "/evidence_manifest.json",
            mime_type: "application/json",
            sha256: sha(manifest),
            byte_size: manifest.length,
            metadata: meta,
          },
          {
            kind: "engine_bundle",
            path: base + "/engine_evidence.tar.zst",
            mime_type: "application/zstd",
            sha256: sha(bytes),
            byte_size: bytes.length,
            metadata: {
              ...meta,
              archiveFormat: "tar+zstd",
              compression: "zstd",
              storageBackend: "volume",
              localEvidenceDisposition: "volume",
              uncompressedTarSha256: sha(tar),
              uncompressedTarByteSize: tar.length,
              zstdLevel: 10,
            },
          },
        ];
        const undeclared = {
          ...point,
          aoa_deg: envelope.scope.units[1].alpha,
          evidence_artifacts: [],
        };
        result.polars[0].attempts!.push(undeclared);
        const report: ProgressiveRemoteReport = {
          version: 1,
          solverId: envelope.solverId,
          promiseId: envelope.promiseId,
          executionId: job,
          assignmentSignature: envelope.contentSignature,
          sequence: 1,
          status: {
            job_id: job,
            state: "completed",
            total_cases: envelope.scope.units.length,
            completed_cases: 2,
          },
          result,
          stopProof: {
            version: 1,
            job_id: job,
            execution_stopped: true,
            producer_stopped: true,
            namespace_verified: true,
            remaining: [],
            observed_at: new Date().toISOString(),
            error: null,
            fence: "terminal_result",
            ownership_basis: "recorded_execution_namespace",
          },
        };
        await storeProgressiveRemoteReport(cx, {
          executionId: job,
          solverId: envelope.solverId,
          promiseId: envelope.promiseId,
          report,
        });
        await applyProgressiveRemoteProgress(cx, job);
        const [s] = await cx.execute(
          sql`UPDATE registered_remote_solvers SET auth_token_hash=${sha("owner")} WHERE id=${envelope.solverId}::uuid RETURNING instance_id`,
        );
        const owner = {
            id: envelope.solverId,
            instanceId: String(s.instance_id),
            authTokenHash: sha("owner"),
          },
          foreign = {
            id: randomUUID(),
            instanceId: randomUUID(),
            authTokenHash: sha("foreign"),
          };
        await cx.execute(
          sql`UPDATE sync_sweep_promises SET source_instance_id=${s.instance_id},request_payload=coalesce(request_payload,'{}')||${JSON.stringify({ solverId: owner.id })}::jsonb WHERE id=${envelope.promiseId}::uuid`,
        );
        await cx.execute(sql`INSERT INTO registered_remote_solvers(id,instance_id,instance_name,cpu_capacity,cpu_budget,max_active_polar_promises,auth_token_hash)
          VALUES (${foreign.id}::uuid,${foreign.instanceId},'isolated foreign historical worker',1,1,1,${foreign.authTokenHash})`);
        await withProgressiveSyncApi(cx, async (app) => {
          await cx.execute(
            sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`,
          );
          const allowPush = (value: boolean) =>
            cx.execute(
              sql`UPDATE sync_api_permissions SET can_push=${value} WHERE data_type='evidence_artifacts'`,
            );
          await allowPush(true);
          const url = `/api/sync/v1/progressive-executions/${job}/historical-raw-archives/1/${progressiveReportedPointSources(result)[0].contentSignature}`;
          const query = {
            reportSignature: analysisContentHash(report),
            storedSha256: sha(bytes),
            manifestSha256: sha(manifest),
          };
          const plan = () =>
            app.inject({
              method: "POST",
              url: url + "/plan",
              query,
              headers: { "x-xfoilfoam-solver-token": "owner" },
            });
          expect((await plan()).statusCode).toBe(409);
          await cx.execute(
            sql`UPDATE progressive_cfd_attempts SET outcome='cancelled',finished_at=now() WHERE sim_job_id=${job}::uuid`,
          );
          await cx.execute(
            sql`UPDATE sim_jobs SET status='cancelled',engine_state='completed',"ingestedAt"=NULL WHERE id=${job}::uuid`,
          );
          await cx.execute(
            sql`UPDATE sync_sweep_promises SET status='expired' WHERE id=${envelope.promiseId}::uuid`,
          );
          const hubBase = "https://registered-history.invalid/api/sync/v1";
          await cx.execute(sql`UPDATE sync_api_settings SET upstream_base_url=${hubBase},remote_solver_registered_id=${owner.id}::uuid,
        remote_solver_auth_token='owner',instance_id=${owner.instanceId},remote_solver_transfer_paused=false WHERE id=1`);
          await cx.execute(
            sql`UPDATE sim_jobs SET request_payload=request_payload||${JSON.stringify(
              {
                remoteSolver: true,
                syncPromiseId: envelope.promiseId,
                upstreamBaseUrl: hubBase,
                remoteProgressiveExecution: envelope,
              },
            )}::jsonb WHERE id=${job}::uuid`,
          );
          await cx.execute(
            sql`UPDATE sync_sweep_promises SET source_base_url=${hubBase} WHERE id=${envelope.promiseId}::uuid`,
          );
          await cx.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,acknowledged_at)
        VALUES(${job}::uuid,1,${analysisContentHash(report)},${JSON.stringify(report)}::jsonb,now())`);
          const science = () =>
            cx.execute(sql`SELECT (SELECT to_jsonb(j) FROM sim_jobs j WHERE id=${job}::uuid) job,
        (SELECT to_jsonb(p) FROM sync_sweep_promises p WHERE id=${envelope.promiseId}::uuid) promise,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY token) FROM progressive_cfd_attempts a WHERE sim_job_id=${job}::uuid) attempts,
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM sync_sweep_promise_points p WHERE promise_id=${envelope.promiseId}::uuid) points,
        (SELECT count(*) FROM progressive_remote_evidence_receipts WHERE sim_job_id=${job}::uuid) receipts,
        (SELECT count(*) FROM progressive_remote_diagnostic_receipts WHERE sim_job_id=${job}::uuid) diagnostics,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM result_attempts a WHERE sim_job_id=${job}::uuid) scientific_rows,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY sequence) FROM progressive_remote_reports r WHERE sim_job_id=${job}::uuid) hub_reports,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY sequence) FROM progressive_worker_reports r WHERE sim_job_id=${job}::uuid) worker_reports,
        (SELECT jsonb_agg(to_jsonb(i) ORDER BY sequence) FROM progressive_remote_report_inventories i WHERE sim_job_id=${job}::uuid) inventories,
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY sequence,point_content_signature) FROM progressive_remote_report_sources s WHERE sim_job_id=${job}::uuid) sources,
        (SELECT jsonb_agg(to_jsonb(g) ORDER BY sequence) FROM progressive_remote_progress_receipts g WHERE sim_job_id=${job}::uuid) progress,
        (SELECT to_jsonb(s) FROM progressive_cfd_execution_stops s WHERE sim_job_id=${job}::uuid) stop,
        (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]') FROM progressive_polar_models m) models,
        (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM result_classifications c) classifications,
        (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]') FROM sync_brokered_evidence_uploads b WHERE engine_job_id=${job}::text) ordinary_uploads`);
          const before = await science();
          const put = (payload: Buffer, principal = "owner") =>
            app.inject({
              method: "PUT",
              url,
              query,
              headers: {
                "x-xfoilfoam-solver-token": principal,
                "content-type": "application/zstd",
                "content-length": String(payload.length),
              },
              payload,
            });
          const verify = (
            pin = generation,
            body = manifest,
            principal = "owner",
          ) =>
            app.inject({
              method: "POST",
              url: url + "/verify",
              query,
              headers: { "x-xfoilfoam-solver-token": principal },
              payload: {
                generation: pin,
                manifestBase64: body.toString("base64"),
              },
            });
          const planned = await plan();
          expect(planned.statusCode, planned.body).toBe(200);
          expect(planned.json().generation).toBeNull();
          await allowPush(false);
          expect((await put(bytes)).statusCode).toBe(403);
          await allowPush(true);
          expect((await put(bytes, "foreign")).statusCode).toBe(409);
          expect((await put(Buffer.alloc(bytes.length))).statusCode).toBe(409);
          expect((await put(bytes.subarray(1))).statusCode).toBe(409);
          expect(uploads).toBe(0);
          // The authenticated principal cannot redirect another signed source to these same bytes.
          expect(
            (
              await app.inject({
                method: "POST",
                url: url + "/plan",
                query: { ...query, reportSignature: sha("other report") },
                headers: { "x-xfoilfoam-solver-token": "owner" },
              })
            ).statusCode,
          ).toBe(409);
          expect(
            (
              await app.inject({
                method: "POST",
                url: url + "/plan",
                query: { ...query, storedSha256: sha("other body") },
                headers: { "x-xfoilfoam-solver-token": "owner" },
              })
            ).statusCode,
          ).toBe(409);
          await cx.execute(
            sql`UPDATE registered_remote_solvers SET auth_token_hash=${sha("rotated")} WHERE id=${owner.id}::uuid`,
          );
          expect((await plan()).statusCode).toBe(401);
          await cx.execute(
            sql`UPDATE registered_remote_solvers SET auth_token_hash=${owner.authTokenHash} WHERE id=${owner.id}::uuid`,
          );
          const ref = {
            executionId: job,
            sequence: 1,
            pointSignature:
              progressiveReportedPointSources(result)[0].contentSignature,
            ...query,
          };
          let fileReads = 0;
          let missingOriginal = false;
          const registeredNetwork: typeof fetch = async (input, init = {}) => {
            const u = new URL(String(input));
            if (u.origin !== new URL(hubBase).origin) {
              expect(
                new Headers(init.headers).has("x-xfoilfoam-solver-token"),
              ).toBe(false);
              const allowed = `/jobs/${job}/files/cases/${point.case_slug}/${base}/`;
              expect([
                allowed + "engine_evidence.tar.zst",
                allowed + "evidence_manifest.json",
              ]).toContain(u.pathname);
              if (missingOriginal && u.pathname.endsWith(".zst"))
                return new Response(null, { status: 404 });
              const b = u.pathname.endsWith(".zst") ? bytes : manifest;
              fileReads++;
              return new Response(new Uint8Array(b), {
                headers: { "content-length": String(b.length) },
              });
            }
            expect(
              new Headers(init.headers).get("x-xfoilfoam-solver-token"),
            ).toBe("owner");
            const h = Object.fromEntries(new Headers(init.headers).entries());
            let payload: Buffer | string | undefined;
            if (init.body instanceof Readable) {
              const parts: Buffer[] = [];
              for await (const b of init.body) parts.push(Buffer.from(b));
              payload = Buffer.concat(parts);
            } else if (typeof init.body === "string") payload = init.body;
            process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
            try {
              const response = await app.inject({
                method: init.method as "POST" | "PUT",
                url: u.pathname + u.search,
                headers: h,
                payload,
              });
              return new Response(response.rawPayload.toString(), {
                status: response.statusCode,
              });
            } finally {
              process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
            }
          };
          const worker = async (execute: boolean) => {
            process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
            try {
              return await transferHistoricalRawArchive(
                cx,
                ref,
                execute,
                registeredNetwork,
              );
            } finally {
              process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
            }
          };
          expect(await worker(false)).toMatchObject({
            state: "planned",
            generation: null,
          });
          expect(fileReads).toBe(0);
          missingOriginal = true;
          await expect(worker(true)).rejects.toThrow(
            "Exact original engine file is unavailable",
          );
          expect(uploads).toBe(0);
          missingOriginal = false;
          failRead = true;
          await expect(worker(true)).rejects.toThrow("HTTP 409");
          expect(fileReads).toBe(3);
          failRead = false;
          expect((await put(bytes)).json()).toMatchObject({
            state: "stored",
            generation,
          });
          expect(uploads).toBe(1);
          expect((await verify("1")).statusCode).toBe(409);
          expect(
            (await verify(generation, Buffer.alloc(manifest.length)))
              .statusCode,
          ).toBe(409);
          expect(
            (await verify(generation, manifest, "foreign")).statusCode,
          ).toBe(409);
          failRead = true;
          expect((await verify()).statusCode).toBe(409);
          failRead = false;
          expect(
            (
              await cx.execute(
                sql`SELECT count(*)::int n FROM progressive_historical_raw_archives WHERE sim_job_id=${job}::uuid`,
              )
            )[0].n,
          ).toBe(0);
          const download = (
            ownerToken: string,
            pin = generation,
            target = url,
          ) =>
            app.inject({
              method: "GET",
              url: target + "/generations/" + pin,
              headers: { "x-xfoilfoam-solver-token": ownerToken },
            });
          expect((await download("owner")).statusCode).toBe(409);
          const saved = await verify();
          expect(saved.statusCode, saved.body).toBe(200);
          expect(saved.json()).toMatchObject({
            state: "registered",
            generation,
            stored_sha256: sha(bytes),
            manifest_sha256: sha(manifest),
            solver_id: owner.id,
          });
          const { verifyHistoricalWorkerRestore } =
            await import("./historical-raw-worker-restore-fixture");
          await verifyHistoricalWorkerRestore(
            app,
            cx,
            job,
            point.case_slug!,
            point.aoa_deg,
            manifest,
            bytes,
            saved.json(),
          );
          const listed = await app.inject({
            method: "GET",
            url: `/api/sync/v1/progressive-executions/${job}/historical-raw-archives/receipts`,
            headers: { "x-xfoilfoam-solver-token": "owner" },
          });
          expect(listed.statusCode, listed.body).toBe(200);
          expect(listed.json().receipts).toHaveLength(1);
          const reopened = await download("owner");
          expect(reopened.statusCode, reopened.body).toBe(200);
          expect(sha(reopened.rawPayload)).toBe(sha(bytes));
          expect(reopened.headers["x-gcs-generation"]).toBe(generation);
          expect(reopened.headers["x-content-sha256"]).toBe(sha(bytes));
          expect((await download("foreign")).statusCode).toBe(409);
          expect((await download("owner", "7")).statusCode).toBe(409);
          expect((await download("invalid")).statusCode).toBe(401);
          expect((await verify()).json()).toEqual(saved.json());
          expect(reads).toBe(2);
          const reused = await worker(true);
          expect(reused).toMatchObject({
            ...saved.json(),
            uploadedBytes: 0,
            wholeVerifiedBytes: bytes.length,
          });
          expect(fileReads).toBe(4);
          expect(reads).toBe(3);
          expect(uploads).toBe(1);
          const missingSignature = progressiveReportedPointSources(result).find(
            (s) => s.point.aoa_deg === undeclared.aoa_deg,
          )!.contentSignature;
          const missingUrl =
            url.slice(0, url.lastIndexOf("/") + 1) + missingSignature;
          const [present] =
            await cx.execute(sql`SELECT count(*)::int AS n FROM progressive_remote_report_sources
            WHERE sim_job_id=${job}::uuid AND sequence=1 AND point_content_signature=${missingSignature}`);
          expect(present.n).toBe(1);
          // This point really exists in the signed report. Its sibling's uploaded file cannot become its evidence.
          for (const suffix of ["/plan", "/verify"]) {
            const denied = await app.inject({
              method: "POST",
              url: missingUrl + suffix,
              query,
              headers: { "x-xfoilfoam-solver-token": "owner" },
              payload:
                suffix === "/verify"
                  ? { generation, manifestBase64: manifest.toString("base64") }
                  : undefined,
            });
            expect(denied.statusCode).toBe(409);
          }
          const [receiptCount] = await cx.execute(
            sql`SELECT count(*)::int n FROM progressive_historical_raw_archives WHERE sim_job_id=${job}::uuid`,
          );
          expect(receiptCount.n).toBe(1);
          expect(
            (await download("owner", generation, missingUrl)).statusCode,
          ).toBe(409);
          const storedObject = cloud!;
          cloud = undefined;
          expect((await plan()).statusCode).toBe(409);
          expect((await put(bytes)).statusCode).toBe(409);
          expect(uploads).toBe(1);
          cloud = storedObject;
          const wrong = Buffer.from(cloud.bytes);
          wrong[0] ^= 1;
          cloud.bytes = wrong;
          const corruptRead = await download("owner");
          expect(corruptRead.statusCode).toBe(409);
          expect(corruptRead.headers["x-gcs-generation"]).toBeUndefined();
          expect((await verify()).statusCode).toBe(409);
          cloud.bytes = bytes;
          expect((await verify()).json()).toEqual(saved.json());
          expect(sha(await readFile(join(dir, "evidence_manifest.json")))).toBe(
            sha(manifest),
          );
          expect(await readFile(join(dir, "forceCoeffs.dat"), "utf8")).toBe(
            "0 0.4 0.03 0\n",
          );
          expect(await science()).toEqual(before);
          await expect(
            cx.transaction((n) =>
              n.execute(
                sql`UPDATE progressive_historical_raw_archives SET generation='17' WHERE sim_job_id=${job}::uuid`,
              ),
            ),
          ).rejects.toThrow();
        });
        throw rollback;
      })
      .then(
        () => {
          throw new Error("Historical raw fixture unexpectedly committed");
        },
        (error) => {
          if (error !== rollback) throw error;
        },
      );
  } finally {
    storage.mockRestore();
    engine.mockRestore();
    env.evidenceBucket = prevBucket;
    if (prevRole === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = prevRole;
    await rm(dir, { recursive: true, force: true });
  }
}
