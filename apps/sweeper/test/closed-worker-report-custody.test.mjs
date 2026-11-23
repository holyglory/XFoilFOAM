import { createClient } from "@aerodb/db/client";
import { retainedReportInventory } from "@aerodb/db/retained-solver-reports";
import {
  parseReportJson,
  readProgressiveReportArchiveText,
} from "@aerodb/db/progressive-report-archive";
import { CRC32C } from "@google-cloud/storage";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, expect, it, vi } from "vitest";
import { runClosedReportPeer } from "../src/closed-worker-report-peer.mjs";
import { ProgressiveReportArchiveStore } from "../src/progressive-report-archive-store.ts";
import {
  withArchiveFixture,
  LARGE_REPORT_INTEGER,
} from "./progressive-report-archive-fixture.ts";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());
it.each([
  [false, false],
  [true, false],
  [false, true],
])(
  "restores a signed source-only original and conserves earlier native and hub science, normalized=%s, grouped=%s",
  async (normalized, grouped) => {
    if (process.env.PROGRESSIVE_REPORT_ARCHIVE_DISPOSABLE_DB !== "1")
      throw new Error("Disposable governed PostgreSQL required");
    await withArchiveFixture(
      client,
      "worker",
      async (f) => {
        const db = f.db,
          id = f.executionId,
          origin = f.reports[1],
          target = f.reports[2];
        const key = {
          executionId: id,
          sequence: target.sequence,
          signature: target.contentSignature,
        };
        const owner = JSON.parse(target.text),
          worker = randomUUID(),
          hub = randomUUID(),
          hubAttempt = randomUUID();
        const workerAttempt = f.attemptId,
          [{ result_id: result }] = await db.execute(
            sql`SELECT result_id FROM result_attempts WHERE id=${workerAttempt}::uuid`,
          );
        const point = retainedReportInventory(
          parseReportJson(target.text),
          key.signature,
        ).sources[0].point_content_signature;
        const scope = {
          sha256: "1".repeat(64),
          solverId: owner.solverId,
          sourceInstance: worker,
          range: null,
        };
        const upstream = "https://source-report-fixture.invalid/api/sync/v1",
          bucket = "source-report-test";
        const volume = await mkdtemp(join(tmpdir(), "closed-report-"));
        const run = (op, fields = {}, connection = db) =>
          runClosedReportPeer(connection, { op, key, scope, ...fields });
        const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
        let packed,
          puts = 0;
        try {
          vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
          vi.stubEnv("AIRFOILFOAM_REPORT_VOLUME_DIR", volume);
          vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", bucket);
          await db.execute(
            sql`UPDATE sync_sweep_promises SET source_base_url=${upstream} WHERE id=${f.promiseId}::uuid`,
          );
          await db.execute(
            sql`UPDATE sim_jobs SET request_payload=request_payload||jsonb_build_object('upstreamBaseUrl',${upstream}::text) WHERE id=${id}::uuid`,
          );
          await db.execute(
            sql`UPDATE registered_remote_solvers SET instance_id=${worker} WHERE id=${owner.solverId}::uuid`,
          );
          await db.execute(sql`INSERT INTO sync_api_settings(id,instance_id,remote_solver_registered_id,upstream_base_url,remote_solver_auth_token,remote_solver_enabled)
        VALUES(1,${worker}::uuid,${owner.solverId}::uuid,${upstream},'disposable-source-only-token',true) ON CONFLICT(id) DO UPDATE SET
        instance_id=excluded.instance_id,remote_solver_registered_id=excluded.remote_solver_registered_id,upstream_base_url=excluded.upstream_base_url,
        remote_solver_auth_token=excluded.remote_solver_auth_token,remote_solver_enabled=true,remote_solver_transfer_paused=false`);
          await db.execute(
            sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp() WHERE sim_job_id=${id}::uuid`,
          );
          await expect(
            run("source", {
              scope: {
                ...scope,
                range: {
                  executionId: id,
                  reportAfter: 1,
                  reportHighWater: key.sequence,
                },
              },
            }),
          ).rejects.toThrow("Frozen sequence");
          await expect(run("source")).rejects.toThrow("earlier native science");
          await db.execute(
            sql`INSERT INTO progressive_worker_evidence_receipts(sim_job_id,sequence,content_signature) VALUES(${id}::uuid,${origin.sequence},${origin.contentSignature})`,
          );
          await db.execute(
            sql`INSERT INTO progressive_worker_evidence_attempts(sim_job_id,sequence,point_content_signature,result_attempt_id) VALUES(${id}::uuid,${origin.sequence},${point},${workerAttempt}::uuid)`,
          );
          await db.execute(sql`INSERT INTO progressive_worker_hub_receipts(sim_job_id,sequence,point_content_signature,result_attempt_id,receipt) VALUES(${id}::uuid,
        ${origin.sequence},${point},${workerAttempt}::uuid,${JSON.stringify({ resultId: result, resultAttemptId: hubAttempt })}::jsonb)`);
          const initial = await run("source"),
            source = initial.source;
          expect(source.facts.sha256).toBe(sha(target.text));
          expect(source.anchors[0].workerStatus).toBe("failed");
          expect(target.text).toContain(LARGE_REPORT_INTEGER);
          // Two independent database roles on one disposable PG. Roll the hub snapshot back before HZ writes.
          const asHub = async (work) => {
            const rollback = new Error("finish hub role"),
              state = {};
            await expect(
              db.transaction(async (tx) => {
                vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
                await tx.execute(
                  sql`UPDATE sync_api_settings SET instance_id=${hub}::uuid WHERE id=1`,
                );
                // This rollback-only snapshot represents the hub, which has no native worker receipts.
                await tx.execute(
                  sql`DELETE FROM progressive_worker_hub_receipts WHERE sim_job_id=${id}::uuid`,
                );
                await tx.execute(
                  sql`DELETE FROM progressive_worker_evidence_attempts WHERE sim_job_id=${id}::uuid`,
                );
                await tx.execute(
                  sql`UPDATE result_attempts SET id=${hubAttempt}::uuid WHERE id=${workerAttempt}::uuid`,
                );
                await tx.execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
            SELECT id,${f.promiseId}::uuid,${owner.solverId}::uuid,1,${owner.assignmentSignature},request_payload->'remoteProgressiveExecution' FROM sim_jobs WHERE id=${id}::uuid`);
                const insertRemote = async (row) => {
                  await tx.execute(sql`INSERT INTO progressive_remote_reports(sim_job_id,sequence,content_signature,report)
              VALUES(${id}::uuid,${row.sequence},${row.contentSignature},${row.text}::jsonb)`);
                };
                await insertRemote(origin);
                const inventory = retainedReportInventory(
                  parseReportJson(origin.text),
                  origin.contentSignature,
                );
                await tx.execute(sql`INSERT INTO progressive_remote_report_inventories(sim_job_id,sequence,report_content_signature,inventory_signature,source_count)
            VALUES(${id}::uuid,${origin.sequence},${origin.contentSignature},${inventory.signature},1)`);
                await tx.execute(
                  sql`INSERT INTO progressive_remote_progress_receipts(sim_job_id,sequence,content_signature) VALUES(${id}::uuid,${origin.sequence},${origin.contentSignature})`,
                );
                await tx.execute(sql`INSERT INTO progressive_remote_report_sources(sim_job_id,sequence,point_content_signature,aoa_deg,case_slug)
            VALUES(${id}::uuid,${origin.sequence},${point},0,'archive-case')`);
                await expect(run("hub", { source }, tx)).rejects.toThrow(
                  "every earlier scientific source",
                );
                await tx.execute(sql`INSERT INTO progressive_remote_evidence_receipts(sim_job_id,sequence,point_content_signature,result_attempt_id,remote_result_attempt_id,remote_result_id)
            VALUES(${id}::uuid,${origin.sequence},${point},${hubAttempt}::uuid,${workerAttempt}::uuid,${result}::uuid)`);
                state.value = await work(tx);
                await insertRemote(target);
                await expect(run("hub", { source }, tx)).rejects.toThrow(
                  "already owns this sequence",
                );
                throw rollback;
              }),
            ).rejects.toBe(rollback);
            vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
            return state.value;
          };
          const scientific = await asHub((tx) => run("hub", { source }, tx));
          vi.stubGlobal(
            "fetch",
            vi.fn(async (url, init) => {
              expect(init.method).toBe("POST");
              puts++;
              const chunks = [];
              for await (const chunk of init.body) chunks.push(chunk);
              packed = Buffer.concat(chunks);
              const crc = new CRC32C();
              crc.update(packed);
              return new Response(
                JSON.stringify({
                  bucket,
                  objectKey: `progressive-reports/v1/worker/${id}/${sha(packed)}.jsonl.gz`,
                  generation: "1795450558982963001",
                  archiveFormat: "jsonl",
                  compression: "gzip",
                  mimeType: "application/gzip",
                  storedByteSize: packed.length,
                  storedSha256: sha(packed),
                  crc32c: crc.toString(),
                  verifiedAt: new Date().toISOString(),
                }),
              );
            }),
          );
          if (grouped) {
            const keys = [
              key,
              {
                executionId: id,
                sequence: f.reports[3].sequence,
                signature: f.reports[3].contentSignature,
              },
            ];
            const native = await run("source", {
              items: keys.map((key) => ({ key })),
            });
            const items = keys.map((key, i) => ({
              key,
              source: native.rows[i].source,
            }));
            const hubs = (await asHub((tx) => run("hub", { items }, tx))).rows;
            const found = await run("discover-worker", {
              after: { executionId: id, sequence: 2 },
              limit: 2,
            });
            expect(found.keys.map((k) => k.sequence)).toEqual([3, 4]);
            const absent = await asHub((tx) =>
              run("discover-hub", { keys }, tx),
            );
            expect(absent.keys).toEqual(keys);
            const publication = await run("publish", {
              items: items.map((item, i) => ({ ...item, hub: hubs[i] })),
            });
            expect(publication.deltaMembers).toBe(1);
            const pinned = items.map((v, i) => ({
                ...v,
                pin: publication.pins[i],
              })),
              head = pinned[0].pin;
            let corrupt = false,
              downloaded = 0;
            const account = "disposable@fixture.iam.gserviceaccount.com";
            vi.stubGlobal(
              "fetch",
              vi.fn(async (url) => {
                if (String(url).startsWith("http://metadata.google.internal/"))
                  return new Response(
                    String(url).endsWith("/email")
                      ? account
                      : JSON.stringify({
                          access_token: "fixture",
                          token_type: "Bearer",
                        }),
                    { headers: { "Metadata-Flavor": "Google" } },
                  );
                const u = new URL(url);
                expect(u.searchParams.get("generation")).toBe(head.generation);
                if (u.searchParams.get("alt") === "media") {
                  downloaded++;
                  const bytes = Buffer.from(packed);
                  if (corrupt) bytes[bytes.length - 1] ^= 1;
                  return new Response(bytes);
                }
                return new Response(
                  JSON.stringify({
                    bucket,
                    name: head.objectKey,
                    generation: head.generation,
                    size: String(packed.length),
                    crc32c: head.crc32c,
                    contentType: "application/gzip",
                    metadata: {
                      sourceKind: "worker",
                      executionId: id,
                      sourceInstanceId: worker,
                      solverId: owner.solverId,
                      archiveFormat: "jsonl",
                      sha256: head.storedSha256,
                      byteSize: String(packed.length),
                    },
                  }),
                );
              }),
            );
            const cloudRead = (tx) =>
              run("cloud", { items: pinned, hubAccount: account }, tx);
            const cloud = (
              await asHub(async (tx) => {
                corrupt = true;
                await expect(cloudRead(tx)).rejects.toThrow();
                corrupt = false;
                return cloudRead(tx);
              })
            ).rows;
            const api = (
              await run("read", {
                items: pinned,
                reader: "api",
                committed: false,
              })
            ).rows;
            const sweeper = (
              await run("read", {
                items: pinned,
                reader: "sweeper",
                committed: false,
              })
            ).rows;
            const actions = pinned.map((item, i) => ({
              ...item,
              hub: hubs[i],
              cloud: cloud[i],
              api: api[i],
              sweeper: sweeper[i],
            }));
            const wrong = actions.map((item, i) =>
              i !== 1
                ? item
                : {
                    ...item,
                    api: { ...item.api, pin: { ...item.pin, generation: "2" } },
                  },
            );
            await expect(run("settle", { items: wrong })).rejects.toThrow(
              "different member or generation",
            );
            const warm = await db.execute(
              sql`SELECT archived_at FROM progressive_worker_reports WHERE sim_job_id=${id}::uuid AND sequence IN(3,4)`,
            );
            expect(warm.map((r) => r.archived_at)).toEqual([null, null]);
            const released = (await run("settle", { items: actions })).rows;
            expect(released.map((r) => r.outcome)).toEqual([
              "retired",
              "retired",
            ]);
            expect(new Set(released.map((r) => r.bundle)).size).toBe(1);
            for (const reader of ["sweeper", "api"])
              expect(
                (
                  await run("read", { items: pinned, reader, committed: true })
                ).rows.map((r) => r.committed),
              ).toEqual([true, true]);
            expect(
              (await run("settle", { items: actions })).rows.map(
                (r) => r.outcome,
              ),
            ).toEqual(["already_retired", "already_retired"]);
            expect(puts).toBe(1);
            expect(downloaded).toBe(2);
            return;
          }
          const pin = await run("publish", { source, hub: scientific });
          const cloudRead = vi
            .spyOn(ProgressiveReportArchiveStore.prototype, "read")
            .mockImplementation((i) =>
              readProgressiveReportArchiveText(Readable.from([packed]), i),
            );
          const cloud = await asHub((tx) => run("cloud", { source, pin }, tx));
          expect(cloudRead).toHaveBeenCalledWith(pin);
          const api = await run("read", { source, pin, reader: "api" }),
            sweeper = await run("read", { source, pin, reader: "sweeper" });
          const fields = { source, pin, hub: scientific, cloud, api, sweeper };
          await expect(
            run("settle", {
              ...fields,
              cloud: { ...cloud, at: "2000-01-01T00:00:00Z" },
            }),
          ).rejects.toThrow("Fresh independent read");
          await expect(
            run("settle", {
              ...fields,
              api: { ...api, pin: { ...pin, generation: "2" } },
            }),
          ).rejects.toThrow("different member or generation");
          const [warm] = await db.execute(
            sql`SELECT archived_at FROM progressive_worker_reports WHERE sim_job_id=${id}::uuid AND sequence=${key.sequence}`,
          );
          expect(warm.archived_at).toBeNull();
          const settlement = await run("settle", fields);
          expect(settlement.outcome).toBe("retired");
          const [committedRow] =
            await db.execute(sql`SELECT pg_column_size(report) AS stored FROM progressive_worker_reports
            WHERE sim_job_id=${id}::uuid AND sequence=${key.sequence}`);
          expect(settlement.stored).toBe(committedRow.stored);
          for (const reader of ["api", "sweeper"])
            expect(
              (await run("read", { source, pin, reader, committed: true }))
                .committed,
            ).toBe(true);
          expect((await run("settle", fields)).outcome).toBe("already_retired");
          expect(puts).toBe(1);
        } finally {
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
          vi.unstubAllEnvs();
          await rm(volume, { recursive: true, force: true });
        }
      },
      { normalized, settled: false, reportCount: 5 },
    );
  },
  30000,
);
