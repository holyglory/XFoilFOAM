import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
import {
  runRegisteredReportCli,
  type ReportConnector,
} from "../src/registered-worker-report-cli";
import type { DB } from "@aerodb/db/client";
import {
  parseReportJson,
  reportJsonObject,
  reportTextIdentity,
} from "@aerodb/db/progressive-report-archive";
import { retainedReportInventory } from "@aerodb/db/retained-solver-reports";
import { CRC32C } from "@google-cloud/storage";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, vi } from "vitest";
import { readWorkerReportArchiveText } from "../src/report-archive-broker-client";
import { releaseUpstreamReadableVolume } from "../src/worker-report-volume-cleanup";
import {
  ExistingHubReportStore,
  hubReportLink,
} from "../src/registered-worker-report-hub";
import {
  nativeReportOwner,
  type HubReportLink,
} from "../src/registered-worker-report-read";
import { registeredReportRequest } from "../src/registered-worker-report-rpc";
import {
  archiveSha256,
  archiveSnapshot,
  type ArchiveFixture,
  LARGE_REPORT_INTEGER,
} from "./progressive-report-archive-fixture";

export async function registeredWorkerRoundtrip(f: ArchiveFixture) {
  const { db, executionId: id } = f,
    anchor = f.reports[1]!,
    target = f.reports[2]!;
  const upstream = "https://registered-report.invalid/api/sync/v1",
    volume = await mkdtemp(join(tmpdir(), "hz-linked-report-"));
  vi.stubEnv("AIRFOILFOAM_REPORT_VOLUME_DIR", volume);
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
  const key = {
    executionId: id,
    sequence: target.sequence,
    signature: target.contentSignature,
  };
  const inv = retainedReportInventory(
    reportJsonObject(parseReportJson(target.text)),
    key.signature,
  );
  expect(inv.sourceCount).toBe(1);
  const point = String(inv.sources[0]!.point_content_signature);
  const workerInstance = randomUUID(),
    hubInstance = randomUUID();
  const nativeAttempt = f.attemptId!,
    hubAttempt = randomUUID();
  const [attempt] = await db.execute(
    sql`SELECT result_id FROM result_attempts WHERE id=${nativeAttempt}::uuid`,
  );
  const nativeResult = String(attempt!.result_id);
  const ownerSolver = JSON.parse(target.text).solverId;
  try {
    await db.execute(
      sql`UPDATE sync_sweep_promises SET source_base_url=${upstream} WHERE id=${f.promiseId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sim_jobs SET request_payload=request_payload||jsonb_build_object('upstreamBaseUrl',${upstream}::text) WHERE id=${id}::uuid`,
    );
    await db.execute(
      sql`UPDATE registered_remote_solvers SET instance_id=${workerInstance} WHERE id=${ownerSolver}::uuid`,
    );
    await db.execute(sql`INSERT INTO sync_api_settings(id,instance_id,remote_solver_registered_id,upstream_base_url,remote_solver_auth_token,remote_solver_enabled)
      VALUES(1,${workerInstance}::uuid,${ownerSolver}::uuid,${upstream},'disposable-link-reader',true) ON CONFLICT(id) DO UPDATE
      SET instance_id=excluded.instance_id,remote_solver_registered_id=excluded.remote_solver_registered_id,upstream_base_url=excluded.upstream_base_url,
      remote_solver_auth_token=excluded.remote_solver_auth_token,remote_solver_enabled=true,remote_solver_transfer_paused=false`);
    await db.execute(
      sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp() WHERE sim_job_id=${id}::uuid`,
    );
    const owner = await nativeReportOwner(db, id);
    const account = "disposable@fixture.iam.gserviceaccount.com",
      bucket = "disposable-registered-hub-report";
    const generation = "1795380355397132441";
    const line = (r: typeof target, signature = r.contentSignature) =>
      JSON.stringify({
        sourceKind: "remote",
        kind: "report",
        executionId: id,
        sequence: r.sequence,
        contentSignature: signature,
        reportSha256: reportTextIdentity(r.text).sha256,
        reportByteSize: Buffer.byteLength(r.text),
      }).slice(0, -1) +
      ',"report":' +
      r.text +
      "}";
    const packed = gzipSync([line(anchor), line(target)].join("\n") + "\n"),
      sha = archiveSha256(packed),
      crc = new CRC32C();
    crc.update(packed);
    const objectKey = `progressive-reports/v1/remote/${id}/${sha}.jsonl.gz`;
    vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", bucket);
    let link!: HubReportLink, restored!: Buffer;
    const rollback = new Error("finish independent hub snapshot");
    await expect(
      db.transaction(async (t) => {
        const hub = t as unknown as DB;
        vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
        await hub.execute(
          sql`UPDATE sync_api_settings SET instance_id=${hubInstance}::uuid WHERE id=1`,
        );
        await hub.execute(
          sql`UPDATE result_attempts SET id=${hubAttempt}::uuid WHERE id=${nativeAttempt}::uuid`,
        );
        await hub.execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
        SELECT id,${f.promiseId}::uuid,${owner.solverId}::uuid,1,${owner.assignmentSignature},request_payload->'remoteProgressiveExecution' FROM sim_jobs WHERE id=${id}::uuid`);
        await hub.execute(sql`INSERT INTO progressive_remote_reports(sim_job_id,sequence,content_signature,report) SELECT sim_job_id,sequence,content_signature,report
        FROM progressive_worker_reports WHERE sim_job_id=${id}::uuid`);
        for (const r of [anchor, target]) {
          const inventory = retainedReportInventory(
            reportJsonObject(parseReportJson(r.text)),
            r.contentSignature,
          );
          await hub.execute(sql`INSERT INTO progressive_remote_report_inventories(sim_job_id,sequence,report_content_signature,inventory_signature,source_count)
          VALUES(${id}::uuid,${r.sequence},${r.contentSignature},${inventory.signature},1)`);
          await hub.execute(sql`INSERT INTO progressive_remote_report_sources(sim_job_id,sequence,point_content_signature,aoa_deg,case_slug)
          VALUES(${id}::uuid,${r.sequence},${point},0,'archive-case')`);
          await hub.execute(
            sql`INSERT INTO progressive_remote_progress_receipts(sim_job_id,sequence,content_signature) VALUES(${id}::uuid,${r.sequence},${r.contentSignature})`,
          );
        }
        await hub.execute(sql`INSERT INTO progressive_remote_evidence_receipts(sim_job_id,sequence,point_content_signature,result_attempt_id,remote_result_attempt_id,remote_result_id)
        VALUES(${id}::uuid,${anchor.sequence},${point},${hubAttempt}::uuid,${nativeAttempt}::uuid,${nativeResult}::uuid)`);
        const [b] =
          await hub.execute(sql`INSERT INTO progressive_report_archive_bundles(source_kind,sim_job_id,bucket,object_key,generation,stored_sha256,
        stored_byte_size,crc32c,member_count,first_sequence,last_sequence,verified_at)
        VALUES('remote',${id}::uuid,${bucket},${objectKey},${generation},${sha},${packed.length},${crc.toString()},2,2,3,clock_timestamp()) RETURNING id`);
        for (const r of [anchor, target]) {
          await hub.execute(sql`INSERT INTO progressive_report_archive_members(bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
          VALUES(${b!.id}::uuid,'remote',${id}::uuid,${r.sequence},'report',${r.contentSignature},${reportTextIdentity(r.text).sha256},${Buffer.byteLength(r.text)})`);
          await hub.execute(sql`UPDATE progressive_remote_reports SET archive_bundle_id=${b!.id}::uuid,archived_at=now(),
          report=progressive_report_compact_header(report) WHERE sim_job_id=${id}::uuid AND sequence=${r.sequence}`);
        }
        link = (await hubReportLink(hub, owner, key))!;
        expect(link.hubBundle).toBe(b!.id);
        expect(link.anchors[0]?.hubAttempt).not.toBe(nativeAttempt);
        await expect(
          hubReportLink(hub, { ...owner, workerInstance: randomUUID() }, key),
        ).rejects.toThrow("dispatch");
        const cloud = vi.fn<typeof fetch>(async (url) => {
          const u = new URL(String(url));
          if (u.host === "metadata.google.internal")
            return new Response(
              u.pathname.endsWith("/email")
                ? account
                : JSON.stringify({
                    access_token: "fixture",
                    token_type: "Bearer",
                  }),
              { headers: { "Metadata-Flavor": "Google" } },
            );
          expect(u.origin).toBe("https://storage.googleapis.com");
          expect(u.searchParams.get("generation")).toBe(generation);
          return u.searchParams.get("alt") === "media"
            ? new Response(new Uint8Array(packed))
            : Response.json({
                bucket,
                name: objectKey,
                generation,
                size: String(packed.length),
                crc32c: crc.toString(),
                contentType: "application/gzip",
                metadata: {
                  sha256: sha,
                  byteSize: String(packed.length),
                  executionId: id,
                  sourceKind: "remote",
                  archiveFormat: "jsonl",
                },
              });
        });
        restored = await new ExistingHubReportStore(
          bucket,
          account,
          cloud,
        ).restore(link);
        expect(restored).toEqual(packed);
        const denied = new ExistingHubReportStore(
          bucket,
          account,
          async (url) =>
            String(url).startsWith("https:")
              ? new Response(null, { status: 403 })
              : cloud(url),
        );
        await expect(denied.restore(link)).rejects.toMatchObject({
          category: "denied",
          retryable: false,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
    expect(
      await db.execute(
        sql`SELECT FROM progressive_remote_dispatches WHERE sim_job_id=${id}::uuid`,
      ),
    ).toHaveLength(0);
    const state = () =>
      registeredReportRequest(db, { operation: "state", link });
    expect(await state()).toBe("science_not_settled");
    await db.execute(
      sql`INSERT INTO progressive_worker_evidence_receipts(sim_job_id,sequence,content_signature) VALUES(${id}::uuid,2,${anchor.contentSignature})`,
    );
    await db.execute(
      sql`INSERT INTO progressive_worker_evidence_attempts(sim_job_id,sequence,point_content_signature,result_attempt_id) VALUES(${id}::uuid,2,${point},${nativeAttempt}::uuid)`,
    );
    await db.execute(sql`INSERT INTO progressive_worker_hub_receipts(sim_job_id,sequence,point_content_signature,result_attempt_id,receipt)
      VALUES(${id}::uuid,2,${point},${nativeAttempt}::uuid,${JSON.stringify({ resultId: nativeResult, resultAttemptId: hubAttempt })}::jsonb)`);
    expect(await state()).toBe("ready");
    const before = await archiveSnapshot(f);
    const at = new Date().toISOString();
    const stage = (bytes = restored) =>
      registeredReportRequest(db, {
        operation: "stage",
        link,
        bytes: bytes.toString("base64"),
        cloudAt: at,
      });
    await expect(stage(Buffer.from("bad gzip"))).rejects.toThrow();
    expect(await stage()).toBe("staged");
    expect(await stage()).toBe("staged");
    expect(
      await db.execute(
        sql`SELECT FROM progressive_worker_reports WHERE sim_job_id=${id}::uuid AND sequence=3 AND archived_at IS NULL`,
      ),
    ).toHaveLength(1);
    const reader = (consumer: string, committed: boolean) =>
      registeredReportRequest(db, {
        operation: "read",
        link,
        reader: consumer,
        committed,
      });
    const api = await reader("api", false);
    if (!api || typeof api !== "object")
      throw new Error("Missing API reader proof");
    const retire = (apiProof: unknown) =>
      registeredReportRequest(db, {
        operation: "retire",
        link,
        api: apiProof,
        cloudAt: at,
      });
    await expect(retire({ ...api, generation: "1" })).rejects.toThrow(
      "proof differs",
    );
    await expect(
      readWorkerReportArchiveText(db, { ...link.pin, generation: "1" }),
    ).rejects.toThrow("binding");
    await expect(
      readWorkerReportArchiveText(db, link.pin, { upstreamOnly: true }),
    ).rejects.toThrow("volume");
    const frozen = join(volume, "frozen.json"),
      accountFile = join(volume, "account"),
      directory = join(volume, "controller");
    await writeFile(accountFile, account, { mode: 0o600 });
    await writeFile(
      frozen,
      JSON.stringify({
        version: 1,
        sourceInstance: workerInstance,
        solverId: ownerSolver,
        measuredAt: at,
        executions: [
          {
            executionId: id,
            reportAfter: 8,
            reportHighWater: 9,
            reports: 1,
            conflicts: 0,
            conflictHighWater: 0,
          },
        ],
      }),
    );
    const shared = [
      "--directory=" + directory,
      "--scope=" + frozen,
      "--hub-account-file=" + accountFile,
      "--hz-host=worker",
      "--hub-host=hub",
      "--hz-api=node-api",
      "--hz-sweeper=sweeper",
      "--hub-sweeper=sweeper",
    ];
    const one = [
      "one",
      ...shared,
      "--job=" + id,
      "--seq=3",
      "--signature=" + key.signature,
    ];
    let lost = true,
      drift = false,
      commits = 0,
      cloudReads = 0,
      scans = 0;
    const connect: ReportConnector = (host, container, write) => ({
      close: async () => {},
      ask: async (message) => {
        const m = message as Record<string, any>;
        if (m.operation === "hello")
          return {
            role: host === "hub" ? "hub" : "remote-solver",
            instance: host === "hub" ? hubInstance : workerInstance,
            solver: ownerSolver,
            build: m.build,
          };
        if (host === "hub") {
          expect(write).toBeFalsy();
          if (m.operation === "scan") {
            scans++;
            return {
              keys: [key, { ...key, sequence: 9 }],
              after: { job: id, seq: 9 },
            };
          }
          if (m.operation === "describe")
            return drift
              ? { ...link, pin: { ...link.pin, generation: "9" } }
              : link;
          expect(m.operation).toBe("restore");
          expect(m.expected).toEqual(link);
          cloudReads++;
          return {
            packed: restored.toString("base64"),
            at: new Date().toISOString(),
          };
        }
        expect(Boolean(write)).toBe(["stage", "retire"].includes(m.operation));
        if (m.operation === "read")
          expect(container).toBe(m.reader === "api" ? "node-api" : "sweeper");
        if (m.operation === "filter") expect(m.keys).toEqual([key]);
        const value = await registeredReportRequest(db, m);
        if (m.operation === "retire" && value === "retired") {
          commits++;
          if (lost) {
            lost = false;
            throw new HistoryOperationError("ssh", "transport", true);
          }
        }
        return value;
      },
    });
    await runRegisteredReportCli(one, connect);
    const plan = JSON.parse(
      await readFile(join(directory, id + ".3.plan.json"), "utf8"),
    );
    expect(plan.pin.generation).toBe(generation);
    expect(commits).toBe(0);
    const checkpoint = async () =>
      JSON.parse(
        await readFile(
          join(directory, "registered-report-progress.json"),
          "utf8",
        ),
      );
    await expect(
      runRegisteredReportCli([...one, "--apply"], connect),
    ).rejects.toMatchObject({ category: "transport" });
    expect((await checkpoint()).pending.link).toEqual(link);
    expect(commits).toBe(1);
    drift = true;
    await expect(
      runRegisteredReportCli([...one, "--apply"], connect),
    ).rejects.toThrow("Pending hub member");
    expect((await checkpoint()).pending.link).toEqual(link);
    drift = false;
    await runRegisteredReportCli([...one, "--apply"], connect);
    expect((await checkpoint()).pending).toBeNull();
    const receipt = JSON.parse(
      await readFile(join(directory, id + ".3.json"), "utf8"),
    );
    expect(receipt.proof.originalSha256).toBe(link.pin.reportSha256);
    expect(receipt.api.generation).toBe(generation);
    expect(receipt.sweeper.generation).toBe(generation);
    expect(cloudReads).toBe(3);
    expect(commits).toBe(1);
    await runRegisteredReportCli(["pass", ...shared, "--apply"], connect);
    expect(scans).toBe(1);
    expect((await checkpoint()).after).toEqual({ job: id, seq: 9 });
    expect(cloudReads).toBe(3);
    expect(await stage()).toBe("already_retired");
    expect(await retire(api)).toBe("already_retired");
    expect(await reader("api", true)).toMatchObject({
      generation,
      sha256: link.pin.reportSha256,
    });
    expect(await reader("sweeper", true)).toMatchObject({
      generation,
      sha256: link.pin.reportSha256,
    });
    const text = await readWorkerReportArchiveText(db, link.pin);
    expect(text).toBe(target.text);
    expect(text).toContain(LARGE_REPORT_INTEGER);
    expect(
      await releaseUpstreamReadableVolume(
        db,
        link.pin,
        AbortSignal.timeout(3000),
      ),
    ).toBe(false);
    const file = join(volume, sha.slice(0, 2), sha + ".jsonl.gz");
    expect(await readFile(file)).toEqual(packed);
    const corrupted = Buffer.from(packed);
    corrupted[corrupted.length - 1]! ^= 1;
    await writeFile(file, corrupted);
    await expect(reader("api", true)).rejects.toThrow();
    const after = await archiveSnapshot(f);
    for (const k of [
      "result_attempts",
      "results",
      "promise",
      "progressive_worker_evidence_attempts",
      "progressive_worker_hub_receipts",
    ])
      expect(after[k]).toEqual(before[k]);
    expect(
      await db.execute(
        sql`SELECT FROM progressive_worker_reports WHERE sim_job_id=${id}::uuid AND archived_at IS NOT NULL`,
      ),
    ).toHaveLength(1);
    expect(
      await db.execute(
        sql`SELECT FROM progressive_worker_evidence_receipts WHERE sim_job_id=${id}::uuid AND sequence=3`,
      ),
    ).toHaveLength(0);
  } finally {
    await rm(volume, { recursive: true, force: true });
  }
}
