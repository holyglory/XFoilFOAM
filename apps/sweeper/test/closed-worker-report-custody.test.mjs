import { createClient } from "@aerodb/db/client";
import { retainedReportInventory } from "@aerodb/db/retained-solver-reports";
import { LegacyOriginSigner } from "@aerodb/db/legacy-report-signature";
import {
  parseReportJson,
  readProgressiveReportArchiveText,
} from "@aerodb/db/progressive-report-archive";
import { CRC32C } from "@google-cloud/storage";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, expect, it, vi } from "vitest";
import { runClosedReportPeer } from "../src/closed-worker-report-peer.mjs";
import { ProgressiveReportArchiveStore } from "../src/progressive-report-archive-store.ts";
import {
  withArchiveFixture,
  archiveFixtureAttemptIdentity,
  insertHubArchiveFixtureAttempt,
  LARGE_REPORT_INTEGER,
} from "./progressive-report-archive-fixture.ts";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());
it.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [false, false, true],
  [true, true, false, true],
])(
  "restores signed native-only reports without changing points, normalized=%s grouped=%s laterWitness=%s sparse=%s",
  async (normalized, grouped, laterWitness, sparse = false) => {
    if (process.env.PROGRESSIVE_REPORT_ARCHIVE_DISPOSABLE_DB !== "1")
      throw new Error("Disposable governed PostgreSQL required");
    await withArchiveFixture(
      client,
      "worker",
      async (f) => {
        const db = f.db,
          id = f.executionId,
          origin = f.reports[laterWitness ? 3 : 1],
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
        const comparison = { api: new Map(), sweeper: new Map(), hub: new Map() };
        const run = (op, fields = {}, connection = db) =>
          runClosedReportPeer(
            connection,
            { op, key, scope, shareResults: !!(normalized && grouped), streamNativePageReads: !!(normalized && grouped), ...fields },
            op === "read" ? comparison[fields.reader]
              : op === "source" ? comparison.sweeper
              : op === "cloud" || op === "hub" ? comparison.hub : undefined,
          );
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
          await expect(run("source")).rejects.toThrow("settled native science");
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
          expect(source.anchors[0].sequence).toBe(origin.sequence);
          expect(target.text).toContain(LARGE_REPORT_INTEGER);
          // Two independent database roles on one disposable PG. Roll the hub snapshot back before HZ writes.
          const nativeIdentity = await archiveFixtureAttemptIdentity(db,workerAttempt,hubAttempt);
          expect(nativeIdentity).toMatchObject([{material_domain:false,hub_attempt_present:false}]);
          const asHub = async (work, subject = { key, source, row: target }) => {
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
                await insertHubArchiveFixtureAttempt(tx,id,workerAttempt,hubAttempt);
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
                await expect(run("hub", { key: subject.key, source: subject.source }, tx)).rejects.toThrow(
                  "every settled scientific source",
                );
                await tx.execute(sql`INSERT INTO progressive_remote_evidence_receipts(sim_job_id,sequence,point_content_signature,result_attempt_id,remote_result_attempt_id,remote_result_id)
            VALUES(${id}::uuid,${origin.sequence},${point},${hubAttempt}::uuid,${workerAttempt}::uuid,${result}::uuid)`);
                state.value = await work(tx);
                await insertRemote(subject.row);
                await expect(run("hub", { key: subject.key, source: subject.source }, tx)).rejects.toThrow(
                  "already owns this sequence",
                );
                throw rollback;
              }),
            ).rejects.toBe(rollback);
            expect(await archiveFixtureAttemptIdentity(db,workerAttempt,hubAttempt)).toEqual(nativeIdentity);
            vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
            return state.value;
          };
          const scientific = await asHub((tx) => run("hub", { source }, tx));
          const cloudObjects = new Map();
          const upload = async (url, init) => {
              expect(init.method).toBe("POST");
              puts++;
              const chunks = [];
              for await (const chunk of init.body) chunks.push(chunk);
              packed = Buffer.concat(chunks);
              const crc = new CRC32C();
              crc.update(packed);
              const receipt = {
                  bucket,
                  objectKey: `progressive-reports/v1/worker/${id}/${sha(packed)}.jsonl.gz`,
                  generation: "1795450558982963001",
                  archiveFormat: new URL(url).searchParams.get("format") ?? "jsonl",
                  compression: "gzip",
                  mimeType: "application/gzip",
                  storedByteSize: packed.length,
                  storedSha256: sha(packed),
                  crc32c: crc.toString(),
                  verifiedAt: new Date().toISOString(),
              };
              cloudObjects.set(receipt.objectKey, { pin: receipt, bytes: packed });
              return new Response(JSON.stringify(receipt));
          };
          vi.stubGlobal("fetch", vi.fn(upload));
          if (grouped) {
            const keys = [
              key,
              {
                executionId: id,
                sequence: f.reports[sparse ? 4 : 3].sequence,
                signature: f.reports[sparse ? 4 : 3].contentSignature,
              },
            ];
            const native = await run("source", {
              items: keys.map((key) => ({ key })),
            });
            for (const [i, k] of keys.entries()) {
              const stored = f.reports.find(row => row.sequence === k.sequence);
              const tokens = new Map();
              const parsed = parseReportJson(stored.text, tokens);
              const exact = retainedReportInventory(parsed, k.signature);
              expect(native.rows[i].resultMeta).toEqual({ sha256: sha(tokens.get("result")), byteSize: Buffer.byteLength(tokens.get("result")) });
              expect(native.rows[i].source.facts).toMatchObject({
                sha256: sha(stored.text), byteSize: Buffer.byteLength(stored.text), inventory: exact.signature,
              });
              expect(native.rows[i].source.facts.points.map(p => p.signature)).toEqual(exact.sources.map(p => p.point_content_signature));
            }
            expect(native.rows[0].source.facts.inventory).not.toBe(native.rows[1].source.facts.inventory);
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
            if (!sparse) {
              // Show the two real, signed fixture members as existing registrations
              // on each independent role, then restore the warm fixture to settle it.
              const occupied = async (connection, check) => {
                const rollback = new Error("finish registered-member lookup");
                await expect(connection.transaction(async tx => {
                  await tx.execute(sql`CREATE TEMP TABLE progressive_report_archive_members
                    (LIKE public.progressive_report_archive_members INCLUDING CONSTRAINTS INCLUDING DEFAULTS) ON COMMIT DROP`);
                  for (const [i, pin] of publication.pins.entries()) {
                    await tx.execute(sql`INSERT INTO progressive_report_archive_members
                      (bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
                      VALUES (gen_random_uuid(),${i === 0 ? "remote" : "worker"},${id}::uuid,${pin.sequence},
                              'report',${pin.signature},${pin.reportSha256},${pin.reportByteSize})`);
                  }
                  await check(tx);
                  throw rollback;
                })).rejects.toBe(rollback);
              };
              await occupied(db, async tx => {
                const next = await run("discover-worker", { after: { executionId: id, sequence: 2 }, limit: 2 }, tx);
                expect(next.keys).toEqual([]);
                expect(next.last).toEqual(found.last);
                for (const key of keys) {
                  await expect(run("source", { key }, tx)).rejects.toThrow("Use the existing archive registration");
                }
              });
              await asHub(tx => occupied(tx, async inner => {
                expect((await run("discover-hub", { keys }, inner)).keys).toEqual([]);
                for (const item of items) {
                  await expect(run("hub", item, inner)).rejects.toThrow("already owns this sequence");
                }
              }));
            }

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
              vi.fn(async (url, init) => {
                if (init?.method === "POST") return upload(url, init);
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
                const found = cloudObjects.get(decodeURIComponent(u.pathname.split("/o/")[1]));
                if (!found) return new Response(null, { status: 404 });
                const { pin: physical, bytes: body } = found;
                expect(u.searchParams.get("generation")).toBe(physical.generation);
                if (u.searchParams.get("alt") === "media") {
                  downloaded++;
                  const bytes = Buffer.from(body);
                  if (corrupt) bytes[bytes.length - 1] ^= 1;
                  return new Response(bytes);
                }
                return new Response(
                  JSON.stringify({
                    bucket,
                    name: physical.objectKey,
                    generation: physical.generation,
                    size: String(body.length),
                    crc32c: physical.crc32c,
                    contentType: "application/gzip",
                    metadata: {
                      sourceKind: "worker",
                      executionId: id,
                      sourceInstanceId: worker,
                      solverId: owner.solverId,
                      archiveFormat: physical.archiveFormat,
                      sha256: physical.storedSha256,
                      byteSize: String(body.length),
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
            if (normalized) {
              const altered = pinned.map((member, index) => index === 0 ? member : {
                ...member, pin: { ...member.pin, reportSha256: "f".repeat(64) },
              });
              await expect(run("read", { items: altered, reader: "api", committed: false })).rejects.toThrow();
              await expect(run("read", { items: [pinned[0], pinned[0]], reader: "sweeper", committed: false })).rejects.toThrow();
            }
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
            // The sparse case starts with a pre-upgrade full page and an empty dictionary index.
            const released = (await run("settle", { items: actions, shareResults: !sparse && normalized })).rows;
            expect(released.map((r) => r.outcome)).toEqual([
              "retired",
              "retired",
            ]);
            expect(new Set(released.map((r) => r.bundle)).size).toBe(1);
            // Corrupt the same physical generation after the comparison basis has been saved.
            // Even a warmed ordinary reader must fail until its actual signed bytes are restored.
            const generationPath = join(
              volume,
              head.storedSha256.slice(0, 2),
              head.storedSha256 + ".jsonl.gz",
            );
            const bad = Buffer.from(packed);
            bad[bad.length - 1] ^= 1;
            await writeFile(generationPath, bad);
            await expect(
              run("read", { items: pinned, reader: "api", committed: true }),
            ).rejects.toThrow();
            await writeFile(generationPath, packed);
            if (sparse) {
              const untouched = await db.execute(
                sql`SELECT archived_at,archive_bundle_id FROM progressive_worker_reports WHERE sim_job_id=${id}::uuid AND sequence=4`,
              );
              expect(untouched[0]).toEqual({
                archived_at: null,
                archive_bundle_id: null,
              });
            }
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
            if (sparse) {
              // The first page archived 3 and 5. Reopen its physical result for the later visit to 4.
              const next = f.reports[3], k = { executionId: id, sequence: next.sequence, signature: next.contentSignature };
              const { source: original } = await run("source", { key: k });
              const subject = { key: k, source: original, row: next };
              const hubProof = await asHub(tx => run("hub", { key: k, source: original }, tx), subject);
              const pin = await run("publish", { key: k, source: original, hub: hubProof });
              expect(pin.archiveFormat).toBe("worker-result-ref-v1");
              const manifest = JSON.parse(gunzipSync(cloudObjects.get(pin.objectKey).bytes));
              expect(manifest.anchor.member).toMatchObject({ generation: head.generation,
                storedSha256: head.storedSha256, signature: keys[0].signature, sequence: keys[0].sequence });
              const fields = { key: k, pin, source: original, hub: hubProof };
              const cloud = await asHub(async tx => {
                const first = cloudObjects.get(head.objectKey);
                cloudObjects.delete(head.objectKey);
                await expect(run("cloud", { ...fields, hubAccount: account }, tx)).rejects.toThrow();
                cloudObjects.set(head.objectKey, first);
                return run("cloud", { ...fields, hubAccount: account }, tx);
              }, subject);
              expect(cloud.generationDownloads).toBe(2);
              const api = await run("read", { ...fields, reader: "api" });
              const sweeper = await run("read", { ...fields, reader: "sweeper" });
              const commit = () => run("settle", { ...fields, cloud, api, sweeper });
              const originalBytes = cloudObjects.get(head.objectKey).bytes;
              const corruptAnchor = Buffer.from(originalBytes); corruptAnchor[corruptAnchor.length - 1] ^= 1;
              await writeFile(generationPath, corruptAnchor);
              // A saved pair of product proofs cannot release the SQL body if its real reader now fails.
              await expect(commit()).rejects.toThrow();
              const [warm] = await db.execute(sql`SELECT resolve_progressive_report(report,result_payload_hash)::text AS text,archived_at
                FROM progressive_worker_reports WHERE sim_job_id=${id}::uuid AND sequence=${k.sequence}`);
              expect(warm).toEqual({ text: next.text, archived_at: null });
              await writeFile(generationPath, originalBytes);
              expect((await commit()).outcome).toBe("retired");
              for (const reader of ["api","sweeper"])
                expect((await run("read", { ...fields, reader, committed: true })).committed).toBe(true);
              expect((await commit()).outcome).toBe("already_retired");
              expect(await archiveFixtureAttemptIdentity(db,workerAttempt,hubAttempt)).toEqual(nativeIdentity);
              await db.execute(sql`SET CONSTRAINTS progressive_report_worker_result_fk IMMEDIATE`);
              const dictionary = await db.execute(sql`SELECT sequence,witness_sequence FROM progressive_worker_report_result_anchors
                WHERE sim_job_id=${id}::uuid`);
              expect(dictionary.map(r => [Number(r.sequence),Number(r.witness_sequence)])).toEqual([[3,4]]);
              expect(cloudObjects.size).toBe(2);

              const siblings = f.reports.slice(5, 7);
              const nextKeys = siblings.map(row => ({ executionId: id, sequence: row.sequence, signature: row.contentSignature }));
              const group = (op, items, fields = {}, connection = db) =>
                run(op, { key: nextKeys[0], items, ...fields }, connection);
              const src = (await group("source", nextKeys.map(key => ({ key })))).rows;
              const copies = nextKeys.map((key,i) => ({ key, source: src[i].source }));
              const witness = { ...copies[0], row: siblings[0] };
              const evidence = (await asHub(tx => group("hub", copies, {}, tx), witness)).rows;
              const receipt = await group("publish", copies.map((v,i) => ({ ...v, hub: evidence[i] })));
              const bound = copies.map((v,i) => ({ ...v, pin: receipt.pins[i] }));
              expect(bound.map(v => v.pin.archiveFormat)).toEqual(["worker-result-ref-v1","worker-result-ref-v1"]);
              const cloudReads = await asHub(tx => group("cloud", bound, { hubAccount: account }, tx), witness);
              expect(cloudReads.generationDownloads).toBe(2);
              const apiReads = (await group("read", bound, { reader: "api" })).rows;
              const sweepReads = (await group("read", bound, { reader: "sweeper" })).rows;
              const actions = bound.map((v,i) => ({ ...v, hub: evidence[i], cloud: cloudReads.rows[i],
                api: apiReads[i], sweeper: sweepReads[i] }));
              const stale = [actions[0], { ...actions[1], api: { ...actions[1].api, at: "2000-01-01T00:00:00Z" } }];
              await expect(group("settle", stale)).rejects.toThrow("Fresh independent read");
              expect((await db.execute(sql`SELECT archived_at FROM progressive_worker_reports WHERE sim_job_id=${id}::uuid
                AND sequence IN (6,7)`)).map(x=>x.archived_at)).toEqual([null,null]);
              expect((await group("settle", actions)).rows.map(x=>x.outcome)).toEqual(["retired","retired"]);
              for (const reader of ["api","sweeper"])
                expect((await group("read", bound, { reader, committed: true })).rows.map(x=>x.pin))
                  .toEqual(receipt.pins);
              expect((await group("settle", actions)).rows.map(x=>x.outcome)).toEqual(["already_retired","already_retired"]);
              expect(await archiveFixtureAttemptIdentity(db,workerAttempt,hubAttempt)).toEqual(nativeIdentity);
            }
            return;
          }
          const pin = await run("publish", { source, hub: scientific });
          const cloudRead = vi
            .spyOn(ProgressiveReportArchiveStore.prototype, "read")
            .mockImplementation((i) =>
              readProgressiveReportArchiveText(Readable.from([packed]), i),
            );
          const sign = vi.spyOn(LegacyOriginSigner.prototype, "matches");
          const cloud = await asHub(async (tx) => {
            const first = await run("cloud", { source, pin }, tx);
            const firstSigner = sign.mock.contexts.at(-1);
            const repeat = await run("cloud", { source, pin }, tx);
            expect(sign.mock.contexts.at(-1)).toBe(firstSigner);
            expect(repeat.pin).toEqual(first.pin);
            expect(repeat.science).toEqual(first.science);
            // A separately named physical version can legitimately contain
            // identical bytes. It still starts a new authenticated page.
            const nextVersion = { ...pin, generation: String(BigInt(pin.generation) + 1n) };
            await run("cloud", { source, pin: nextVersion }, tx);
            expect(sign.mock.contexts.at(-1)).not.toBe(firstSigner);
            cloudRead.mockResolvedValueOnce(target.text + " ");
            await expect(run("cloud", { source, pin: nextVersion }, tx)).rejects.toThrow();
            cloudRead.mockResolvedValueOnce(target.text.slice(0, -1) + ', "sequence": 3}');
            await expect(run("cloud", { source, pin }, tx)).rejects.toThrow();
            cloudRead.mockResolvedValueOnce(target.text.replace(LARGE_REPORT_INTEGER, LARGE_REPORT_INTEGER + "1"));
            await expect(run("cloud", { source, pin }, tx)).rejects.toThrow();
            return repeat;
          });
          expect(cloudRead).toHaveBeenCalledWith(pin);
          sign.mockRestore();
          expect(cloudRead).toHaveBeenCalledTimes(6);
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
      { normalized, settled: false, reportCount: sparse ? 8 : 5 },
    );
  },
  30000,
);
