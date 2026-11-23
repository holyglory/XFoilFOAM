import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    for (const kind of ["pending", "pending", "ordinary"] as const) {
      await withArchiveFixture(
        db,
        "remote",
        async (f) => {
          if (kind === "pending")
            await f.db
              .execute(sql`UPDATE sim_jobs SET status='cancelled',engine_state='failed',"ingestedAt"=NULL,
          error='Scheduling promise became inactive; evidence delivery remains unresolved' WHERE id=${f.executionId}::uuid`);
          originals.push(f);
        },
        {
          serviceAcceptance: kind,
          normalized: true,
          reportCount: kind === "ordinary" ? 3 : 36,
        },
      );
    }
    const apiSamples = await Promise.all(
      originals.map((f) =>
        download(f.executionId, 3, f.reports[2].contentSignature),
      ),
    );
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
      expect(a.registeredSqlMembers).toBe(34);
      expect(a.uniqueResultGenerations).toBe(2);
      expect(a.verifiedMembers).toBe(36);
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
        await download(f.executionId, 3, f.reports[2].contentSignature),
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
          await download(f.executionId, 2, f.reports[1].contentSignature),
          await download(f.executionId, 36, f.reports[35].contentSignature),
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
        await download(f.executionId, 2, f.reports[1].contentSignature),
      ).toBe(ownerReads[i][0]);
      expect(
        await download(f.executionId, 36, f.reports[35].contentSignature),
      ).toBe(ownerReads[i][1]);
      const total = await sharedReportTotals(
        db.db,
        join(dir, f.executionId),
        f.executionId,
      );
      expect(total.registeredSqlMembers).toBe(36);
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
