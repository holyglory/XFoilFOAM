import { CancelledReportCopyPriority, nextCancelledReportCopies, selectCancelledReportCopyPage } from "../src/cancelled-report-copies";
import { archiveProgressiveReportBatch } from "../src/progressive-report-archive-service";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "@aerodb/db/client";
import {
  withArchiveFixture,
  type ArchiveFixture,
} from "./progressive-report-archive-fixture";
import { startReportObjectServer } from "./shared-report-gcs-server";
import { sharedReportTotals } from "../src/shared-report-totals";
import { stoppedReportCopyKeys } from "../src/shared-stopped-report-custody";
import { STALE_HZ_RESET_REASON } from "@aerodb/db/progressive-remote-stale-recovery";

it("runs the stock recurring hub storage worker and serves both archive formats through the live retained-report API", async () => {
  expect(process.env.PROGRESSIVE_REPORT_ARCHIVE_DISPOSABLE_DB).toBe("1");
  const db = createClient({ max: 2 });
  const emulator = await startReportObjectServer();
  const dir = await mkdtemp(join(tmpdir(), "hub-stopped-report-service-"));
  const originals: ArchiveFixture[] = [];
  process.env.ADMIN_PASSWORD = randomUUID();
  process.env.ADMIN_SESSION_SECRET = randomUUID() + randomUUID();
  process.env.STORAGE_EMULATOR_HOST = emulator.url;
  process.env.AIRFOILFOAM_EVIDENCE_BUCKET = "shared-fixture";
  const { buildServer } = await import("../../api/src/server");
  const { installApiReportArchiveReader } =
    await import("../../api/src/progressive-report-archive-reader");
  await installApiReportArchiveReader();
  const app = await buildServer();
  const host = await app.listen({ host: "127.0.0.1", port: 0 });
  let child: ReturnType<typeof fork> | undefined;
  let logs = "",
    errors = "";
  const eventLines: string[] = [];
  let portReady = false;
  const lastLogs = () =>
    errors.slice(-1200) +
    " " +
    logs.slice(-1200) +
    " " +
    emulator.requests.slice(-5).join(" ");
  async function until(check: () => Promise<boolean>, ms = 90000) {
    const end = Date.now() + ms;
    do {
      if (await check()) return;
      if (child?.exitCode != null)
        throw Error(
          "Report storage worker exited " + child.exitCode + " " + lastLogs(),
        );
      await wait(100);
    } while (Date.now() < end);
    throw Error("Stock service did not reach expectation " + lastLogs());
  }
  const start = (anchors = true) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIRFOILFOAM_HUB_REPORT_API_URL: host,
      AIRFOILFOAM_STOPPED_REPORT_ANCHOR_SCOPE: anchors ? "all" : "off",
      AIRFOILFOAM_STOPPED_SHARED_REPORT_RECEIPTS: dir,
      STORAGE_EMULATOR_HOST: emulator.url,
      LOG_LEVEL: "error",
      NODE_OPTIONS: "--max-old-space-size=512",
    };
    delete env.AIRFOILFOAM_STOPPED_SHARED_REPORT_SCOPE;
    child = fork(
      fileURLToPath(
        new URL("../src/report-storage-worker.ts", import.meta.url),
      ),
      [],
      {
        env,
        execArgv: ["--import", "tsx"],
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.stdout!.on("data", (b) => {
      logs += b.toString();
      eventLines.push(b.toString());
    });
    child.stderr!.on("data", (b) => {
      errors += b.toString();
    });
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill("SIGTERM");
      const guard = setTimeout(() => child?.kill("SIGKILL"), 6500);
      try {
        await done;
      } finally {
        clearTimeout(guard);
      }
    }
    child = undefined;
  };
  const download = async (j: string, s: number, sig: string) => {
    const r = await fetch(
      host + "/api/admin/retained-reports/" + j + "/" + s + "?signature=" + sig,
      { headers: { cookie: auth } },
    );
    expect(r.status, (await r.clone().text()).slice(0, 160)).toBe(200);
    expect(r.headers.get("x-content-sha256")).toBe(sig);
    return await r.text();
  };
  const login = await fetch(host + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "admin@airfoils.pro",
      password: process.env.ADMIN_PASSWORD,
    }),
  });
  const auth = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  try {
    expect(login.status).toBe(200);
    const health = (await (await fetch(host + "/health")).json()) as {
      hubReportArchiveFormats: string[];
    };
    expect(health.hubReportArchiveFormats).toContain("shared-result-v1");
    portReady = true;
    for (const [order, kind] of (
      ["pending", "pending", "ordinary"] as const
    ).entries()) {
      await withArchiveFixture(
        db,
        "remote",
        async (f) => {
          if (kind === "pending")
            await f.db
              .execute(sql`UPDATE sim_jobs SET status='cancelled',engine_state='failed',"ingestedAt"=NULL,
          error='Scheduling promise became inactive; evidence delivery remains unresolved' WHERE id=${f.executionId}::uuid`);
          if (order === 1) {
            const keys = () => stoppedReportCopyKeys(f.db, f.executionId, 0, 1);
            await f.db.execute(sql`UPDATE sim_jobs SET error=${STALE_HZ_RESET_REASON} WHERE id=${f.executionId}::uuid`);
            await expect(keys()).rejects.toThrow("Stopped report owner");
            await f.db.execute(sql`UPDATE sync_sweep_promises p SET status='cancelled',"cancelledAt"=clock_timestamp(),
              response_payload=jsonb_build_object('authoritativeLeaseLoss',true,'remoteCancellation',
                jsonb_build_object('disposition','operator_release','reason',${STALE_HZ_RESET_REASON}::text))
              FROM progressive_remote_dispatches d WHERE d.sim_job_id=${f.executionId}::uuid AND p.id=d.promise_id`);
            await f.db.execute(sql`INSERT INTO sync_sweep_promise_points (promise_id,airfoil_id,simulation_preset_revision_id,aoa_deg,status)
              SELECT p.id,p.airfoil_id,p.simulation_preset_revision_id,7,'active' FROM sync_sweep_promises p
              JOIN progressive_remote_dispatches d ON d.promise_id=p.id WHERE d.sim_job_id=${f.executionId}::uuid`);
            await expect(keys()).rejects.toThrow("Stopped report owner");
            await f.db.execute(sql`UPDATE sync_sweep_promise_points s SET status='cancelled' FROM progressive_remote_dispatches d
              WHERE d.sim_job_id=${f.executionId}::uuid AND s.promise_id=d.promise_id`);
            expect(await keys()).toHaveLength(1);
            await f.db.execute(sql`UPDATE sync_sweep_promises p SET response_payload=jsonb_set(p.response_payload,
              '{remoteCancellation,reason}','"different operator decision"') FROM progressive_remote_dispatches d
              WHERE d.sim_job_id=${f.executionId}::uuid AND p.id=d.promise_id`);
            await expect(keys()).rejects.toThrow("Stopped report owner");
            await f.db.execute(sql`UPDATE sync_sweep_promises p SET response_payload=jsonb_set(p.response_payload,
              '{remoteCancellation,reason}',to_jsonb(${STALE_HZ_RESET_REASON}::text)) FROM progressive_remote_dispatches d
              WHERE d.sim_job_id=${f.executionId}::uuid AND p.id=d.promise_id`);
          }
          originals.push(f);
        },
        {
          serviceAcceptance: kind,
          normalized: true,
          reportCount: kind === "ordinary" ? 3 : order === 0 ? 75 : 36,
          nullPrefix: order === 0 ? 66 : 1,
        },
      );
    }
    // The 512-key lookahead must stop at the 32nd scientific source,
    // even when an uninspected 33rd source is present in the same window.
    const fullWindow = await nextCancelledReportCopies(db.db, {
      executionId: originals[1].executionId,
      sequence: 0,
    });
    expect(fullWindow.sequences).toEqual([]);
    expect(fullWindow.after).toEqual({
      executionId: originals[1].executionId,
      sequence: 33,
    });
    // None of these pending rows has a scientific receipt. The ordinary
    // writer can rule them out ahead of its expensive raw-ownership check.
    const ordinaryWindow = await nextCancelledReportCopies(db.db, {
      executionId: originals[1].executionId, sequence: 0,
    }, true);
    expect(ordinaryWindow.sequences).toEqual([]);
    expect(ordinaryWindow.after).not.toBeNull();
    expect(ordinaryWindow.after!.executionId !== originals[1].executionId ||
      ordinaryWindow.after!.sequence >= originals[1].reports.at(-1)!.sequence).toBe(true);
    // Both pages carry real stored scientific identities. A scheduling hint
    // alone cannot retire a pending row or supply its missing raw receipt.
    const waiting = originals[0].executionId, continuing = originals[1].executionId;
    const waitingKeys = (await stoppedReportCopyKeys(db.db, waiting, 0, 32, true)).slice(0, 2);
    const continuingKeys = await stoppedReportCopyKeys(db.db, continuing, 0, 32, true);
    const signedOffers = new CancelledReportCopyPriority();
    signedOffers.offer(continuing, continuingKeys);
    expect(signedOffers.take()?.executionId).toBe(continuing);
    signedOffers.offer(waiting, waitingKeys);
    signedOffers.offer(continuing, continuingKeys);
    const cursor = {executionId: continuing, sequence: 0};
    const chronological = await selectCancelledReportCopyPage(db.db, cursor, signedOffers);
    expect(chronological.preferred).toBeUndefined();
    const selected = await selectCancelledReportCopyPage(db.db, chronological.after, signedOffers);
    expect(selected.preferred?.executionId).toBe(waiting);
    expect(selected.after).toEqual(chronological.after);
    expect(selected.sequences).toEqual(waitingKeys.map(k => k.sequence));
    expect(await archiveProgressiveReportBatch(db.db, "remote", waiting, async () => {
      throw new Error("An unreceipted priority hint reached the cloud writer");
    }, selected.sequences, new Map(waitingKeys.map(k => [k.sequence,k.signature])))).toBe(0);
    expect(signedOffers.take()).toBeUndefined();
    expect(signedOffers.take()?.executionId).toBe(continuing);
    // One owner's full signed offer can be the exact chronological window.
    // Keep the two other owners with a signed source instead of counting the same bytes twice.
    const third = originals[2].executionId;
    const [thirdKey] = await db.db.execute<{sequence: number; signature: string; storedBytes: number}>(sql`
      SELECT sequence::int, content_signature AS signature, pg_column_size(report)::int AS "storedBytes"
      FROM progressive_remote_reports WHERE sim_job_id=${third}::uuid ORDER BY sequence DESC LIMIT 1`);
    expect(continuingKeys.reduce((n, k) => n + k.storedBytes, 0)).toBeGreaterThan(thirdKey!.storedBytes);
    const competing = new CancelledReportCopyPriority();
    competing.offer(continuing, continuingKeys);
    competing.observeChronological(continuing, continuingKeys.map(k => k.sequence));
    competing.offer(waiting, waitingKeys);
    competing.offer(third, [thirdKey!]);
    const first = competing.take()!;
    expect(competing.take()).toBeUndefined();
    const other = competing.take()!;
    expect(new Set([first.executionId, other.executionId])).toEqual(new Set([waiting, third]));
    expect(first.keys).toEqual(first.executionId === waiting ? waitingKeys : [thirdKey!]);
    expect(other.keys).toEqual(other.executionId === waiting ? waitingKeys : [thirdKey!]);
    const physicalRead = (f: ArchiveFixture) => {
      const first = f.reports.findIndex((r) => r.payloadHash !== null);
      return f.reports[first + 1];
    };
    const firstPhysical = (f: ArchiveFixture) =>
      f.reports.find((r) => r.payloadHash !== null)!;
    const apiSamples = await Promise.all(
      originals.map((f) =>
        download(
          f.executionId,
          physicalRead(f).sequence,
          physicalRead(f).contentSignature,
        ),
      ),
    );
    // An interrupted optional seek hint must leave the ordinary stock writer
    // and readers operating on their normal catalogue and source checks.
    await writeFile(join(dir, "ordinary-chronological.json"), "{");
    start(false);
    await until(async () => {
      const rows =
        await db.sql`SELECT count(*)::int n FROM progressive_report_archive_members m
      JOIN progressive_report_archive_bundles b ON b.id=m.bundle_id WHERE b.archive_format='shared-result-v1'`;
      return Number(rows[0].n) >= 66;
    });
    await until(async () =>
      originals
        .slice(0, 2)
        .every((f) =>
          logs.includes(
            '"component":"stopped-report-cloud-totals","job":"' +
              f.executionId +
              '"',
          ),
        ),
    );
    expect(errors).toContain("reading chronological report checkpoint");
    const ids = originals.map((f) => f.executionId);
    const [row] = await db.sql.unsafe(
      `SELECT (SELECT count(*)::int FROM progressive_remote_evidence_receipts WHERE sim_job_id=ANY($1::uuid[])) AS receipts,
      (SELECT count(*)::int FROM sim_jobs WHERE id=ANY($2::uuid[]) AND ("ingestedAt" IS NOT NULL OR status<>'cancelled' OR ingest_lease_token IS NOT NULL)) AS reopened`,
      [ids, ids.slice(0, 2)],
    );
    expect(row).toEqual({ receipts: 0, reopened: 0 });
    const order = logs
      .split("\n")
      .filter((s) => s.includes('"component":"stopped-report-cloud-copy"'))
      .map((s) => JSON.parse(s));
    const both = order.filter((x) => x.mode === "release").map((x) => x.job);
    expect(new Set(both.slice(0, 2))).toEqual(new Set(ids.slice(0, 2)));
    const [priority] =
      await db.sql`SELECT a.archived_at < b.archived_at AS physical_first
      FROM progressive_remote_reports a JOIN progressive_remote_reports b ON b.sim_job_id=a.sim_job_id
      WHERE a.sim_job_id=${ids[0]} AND a.sequence=68 AND b.sequence=65`;
    expect(priority.physical_first).toBe(true);
    const counts = [];
    for (const f of originals.slice(0, 2)) {
      const a = await sharedReportTotals(
        db.db,
        join(dir, f.executionId),
        f.executionId,
      );
      const readback = JSON.parse(
        await readFile(join(dir, f.executionId, "totals.json"), "utf8"),
      );
      expect(a.registeredSqlMembers).toBe(f.reports.length - 2);
      expect(a.uniqueResultGenerations).toBe(2);
      expect(a.verifiedMembers).toBe(f.reports.length);
      expect(a.sqlReportFieldBytesReleased).toBe(
        readback.sqlReportFieldBytesReleased,
      );
      counts.push(a);
    }
    await until(async () => {
      const [r] =
        await db.sql`SELECT b.archive_format f FROM progressive_remote_reports s JOIN progressive_report_archive_bundles b ON b.id=s.archive_bundle_id WHERE s.sim_job_id=${ids[2]} AND s.sequence=3`;
      return r?.f === "jsonl";
    });
    for (const [i, f] of originals.entries())
      expect(
        await download(
          f.executionId,
          physicalRead(f).sequence,
          physicalRead(f).contentSignature,
        ),
      ).toBe(apiSamples[i]);
    // Upgrade an existing 0219 checkpoint. The two original anchors already
    // reside in pinned manifests and remain fully warm until both readers pass.
    await stop();
    const beforeAnchorObjects = emulator.objects.size;
    const priorScienceKeys = [...emulator.objects.keys()]
      .filter((k) => k.includes("/results/"))
      .sort();
    const ownerReads = await Promise.all(
      originals
        .slice(0, 2)
        .map(async (f) => [
          await download(
            f.executionId,
            firstPhysical(f).sequence,
            firstPhysical(f).contentSignature,
          ),
          await download(
            f.executionId,
            f.reports.at(-1)!.sequence,
            f.reports.at(-1)!.contentSignature,
          ),
        ]),
    );
    start();
    await until(async () => {
      const [r] = await db.sql.unsafe(
        "SELECT count(*)::int n FROM progressive_remote_reports WHERE sim_job_id=ANY($1::uuid[]) AND archived_at IS NULL",
        [ids.slice(0, 2)],
      );
      return Number(r.n) === 0;
    });
    const anchorTotals = [];
    for (const [i, f] of originals.slice(0, 2).entries()) {
      expect(
        await download(
          f.executionId,
          firstPhysical(f).sequence,
          firstPhysical(f).contentSignature,
        ),
      ).toBe(ownerReads[i][0]);
      expect(
        await download(
          f.executionId,
          f.reports.at(-1)!.sequence,
          f.reports.at(-1)!.contentSignature,
        ),
      ).toBe(ownerReads[i][1]);
      const total = await sharedReportTotals(
        db.db,
        join(dir, f.executionId),
        f.executionId,
      );
      expect(total.registeredSqlMembers).toBe(f.reports.length);
      expect(total.protectedResultBytesReleased).toBeGreaterThan(0);
      anchorTotals.push(total);
    }
    expect(
      [...emulator.objects.keys()]
        .filter((k) => k.includes("/results/"))
        .sort(),
    ).toEqual(priorScienceKeys);
    expect(emulator.objects.size).toBe(beforeAnchorObjects);
    const [protectedRows] = await db.sql.unsafe(
      "SELECT count(*)::int n FROM progressive_report_result_payloads WHERE content_hash=ANY($1::text[])",
      [
        originals
          .slice(0, 2)
          .flatMap((f) => f.reports.map((m) => m.payloadHash).filter(Boolean)),
      ],
    );
    expect(protectedRows.n).toBe(0);
    await stop();
    const objects = emulator.objects.size,
      media = emulator.media.length;
    logs = "";
    start();
    await until(
      async () => logs.includes('"component":"stopped-report-cloud-scan"'),
      20000,
    );
    await wait(700);
    expect(emulator.objects.size).toBe(objects);
    expect(emulator.media.length).toBe(media);
    const result = {
      counts,
      anchorTotals,
      objects,
      peakRssBytes: Math.max(...order.map((r) => r.peakRssBytes)),
      realService: true,
      realHttp: true,
      portReady,
      restartMediaReads: emulator.media.length - media,
    };
    console.info("Shared report daemon acceptance", JSON.stringify(result));
  } finally {
    await stop();
    await app.close();
    await db.sql.end();
    await emulator.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 180000);
