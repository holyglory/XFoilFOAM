import { sql } from "drizzle-orm";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { DB } from "@aerodb/db/client";
import { cancelledReportOwner } from "./cancelled-report-copies";
import {
  copyStoppedReportBatch,
  stoppedReportCopyKeys,
  type StoppedCopyReceipt,
} from "./shared-stopped-report-custody";
import { sharedReportTotals } from "./shared-report-totals";
import { HubReportObjects, sha256 } from "./shared-report-objects";

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
interface Cursor {
  after: number;
  frontier: string;
  complete: boolean;
}
interface PageLedger {
  members: Record<string, { signature: string; receipt: string }>;
}
async function read<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function write(file: string, value: unknown) {
  const folder = dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const tmp = join(folder, ".new-" + randomUUID());
  const f = await open(tmp, "wx", 0o600);
  try {
    try {
      await f.writeFile(JSON.stringify(value) + "\n");
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(tmp, file);
    const parent = await open(folder, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(tmp).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
async function ownerFrontier(db: DB, id: string) {
  const [o] =
    await db.execute(sql`SELECT d.content_signature AS assignment,st.proof_signature AS stop,
    (SELECT max(sequence)::text FROM progressive_remote_reports r WHERE r.sim_job_id=job.id) AS last,
    (SELECT max(sequence)::text FROM progressive_remote_progress_receipts p WHERE p.sim_job_id=job.id) AS applied,
    (SELECT count(*)::int FROM progressive_remote_evidence_receipts e WHERE e.sim_job_id=job.id) AS scientific,
    (SELECT count(*)::int FROM progressive_remote_diagnostic_receipts e WHERE e.sim_job_id=job.id) AS diagnostic
    FROM sim_jobs job JOIN progressive_remote_dispatches d ON d.sim_job_id=job.id JOIN sync_sweep_promises promise ON promise.id=d.promise_id
    JOIN progressive_cfd_execution_stops st ON st.sim_job_id=job.id AND st.engine_job_id=job.engine_job_id
    WHERE job.id=${id}::uuid AND ${cancelledReportOwner}`);
  return o?.last ? sha256(JSON.stringify(o)) : null;
}
async function preserveReceipt(root: string, receipt: StoppedCopyReceipt) {
  const text = JSON.stringify(receipt),
    hash = sha256(text),
    name = join(root, "receipts", hash + ".json");
  await write(name, receipt);
  return hash;
}

/** A crash after upload leaves warm SQL or a real committed catalog row. A
 * preserved SQL source can skip a repeated cloud transfer only with its actual
 * write/readback receipt. No local checkpoint is ever trusted to release SQL. */
export async function advanceSharedReportOwner(
  db: DB,
  objects: HubReportObjects,
  dir: string,
  id: string,
) {
  if (!uuid.test(id) || !isAbsolute(dir))
    throw new Error("Invalid stopped report owner or receipt path");
  const frontier = await ownerFrontier(db, id);
  if (!frontier) return { complete: true, changed: 0 };
  const root = join(dir, id),
    cursorFile = join(root, "cursor.json");
  const prior = await read<Cursor>(cursorFile);
  if (prior?.complete && prior.frontier === frontier)
    return { complete: true, changed: 0 };
  const after = prior?.frontier === frontier ? prior.after : 0;
  const keys = await stoppedReportCopyKeys(db, id, after);
  if (!keys.length) {
    const totals = await sharedReportTotals(db, root, id);
    await write(join(root, "totals.json"), totals);
    console.info(
      JSON.stringify({ component: "stopped-report-cloud-totals", ...totals }),
    );
    await write(cursorFile, { after, frontier, complete: true });
    return { complete: true, changed: 0 };
  }
  if (keys.some((k) => k.mode === "missing"))
    throw new Error("Stopped source inventory or applied progress is missing");
  let changed = 0;
  for (const mode of ["preserve", "release"] as const) {
    const ledgerFile = join(root, "windows", String(after) + ".json");
    const ledger = (await read<PageLedger>(ledgerFile)) ?? { members: {} };
    const requested = keys.filter((k) => k.mode === mode);
    const remaining = [];
    const known = new Map<string, StoppedCopyReceipt>();
    for (const k of requested) {
      const saved = ledger.members[k.sequence];
      if (
        mode === "preserve" &&
        saved?.signature === k.signature &&
        /^[a-f0-9]{64}$/.test(saved.receipt)
      ) {
        let evidence = known.get(saved.receipt);
        if (!evidence) {
          const stored = await read<StoppedCopyReceipt>(
            join(root, "receipts", saved.receipt + ".json"),
          );
          if (stored && sha256(JSON.stringify(stored)) === saved.receipt) {
            evidence = stored;
            known.set(saved.receipt, stored);
          }
        }
        if (
          evidence?.mode === "preserve" &&
          evidence.owner.executionId === id &&
          evidence.members.some(
            (m) => m.sequence === k.sequence && m.signature === k.signature,
          )
        )
          continue;
      }
      remaining.push(k);
    }
    if (remaining.length) {
      if (changed) return { complete: false, changed };
      const receipt = await copyStoppedReportBatch(
        db,
        objects,
        id,
        remaining,
        mode,
        {
          beforeCommit: (committed) =>
            write(
              join(root, "sql-releases", committed.object.sha256 + ".json"),
              committed,
            ),
          beforePublish: async (verified) => {
            await write(
              join(root, "verified", verified.object.sha256 + ".json"),
              verified,
            );
          },
        },
      );
      const hash = await preserveReceipt(root, receipt);
      for (const m of receipt.members)
        ledger.members[m.sequence] = { signature: m.signature, receipt: hash };
      await write(ledgerFile, ledger);
      remaining.splice(0, receipt.members.length);
      changed += receipt.members.length;
      console.info(
        JSON.stringify({
          component: "stopped-report-cloud-copy",
          job: id,
          mode,
          receipt: hash,
          members: receipt.members.length,
          attached: receipt.released,
          rssBytes: process.memoryUsage.rss(),
          peakRssBytes: process.resourceUsage().maxRSS * 1024,
          manifestBytes: receipt.object.size,
          resultBytesSubmitted: receipt.resultBytesSubmitted,
          sqlReportFieldBytesReleased:
            receipt.storedReportFieldsBefore - receipt.storedReportFieldsAfter,
        }),
      );
      if (remaining.length) return { complete: false, changed };
    }
  }
  await write(cursorFile, {
    after: keys.at(-1)!.sequence,
    frontier,
    complete: false,
  });
  return { complete: false, changed };
}

export async function runSharedStoppedReportStorage(
  db: DB,
  signal: AbortSignal,
) {
  const scope =
    process.env.AIRFOILFOAM_STOPPED_SHARED_REPORT_SCOPE?.trim() || "all";
  const bucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
  if (
    scope === "off" ||
    !bucket ||
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver"
  )
    return;
  const directory =
    process.env.AIRFOILFOAM_STOPPED_SHARED_REPORT_RECEIPTS ||
    "/data/airfoilfoam/report-archives/shared-result-v1";
  const api =
    process.env.AIRFOILFOAM_HUB_REPORT_API_URL || "http://node-api:4000";
  if ((scope !== "all" && !uuid.test(scope)) || !isAbsolute(directory)) {
    console.error(
      "[stopped-report-cloud-copy] Invalid scope or durable receipt path",
    );
    return;
  }
  const store = new HubReportObjects(
    bucket,
    process.env.AIRFOILFOAM_REPORT_ARCHIVE_PREFIX ?? "progressive-reports/v1",
  );
  let after: string | null = null,
    queue: string[] = [];
  let worked = false,
    verifiedUntil = 0;
  while (!signal.aborted) {
    let wait = 500;
    try {
      if (Date.now() >= verifiedUntil) {
        const [ready] =
          await db.execute(sql`SELECT attempt_evidence_verified_hub() AS hub,EXISTS(SELECT FROM pg_constraint
          WHERE conrelid='progressive_report_archive_bundles'::regclass AND conname='progressive_report_archive_bundles_archive_format_check'
          AND pg_get_constraintdef(oid) LIKE '%shared-result-v1%') AS format`);
        if (!ready?.hub || !ready.format)
          throw new Error(
            "Verified hub or shared-result migration is unavailable",
          );
        const health = await fetch(new URL("/health", api), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
          redirect: "error",
        });
        const v = health.ok
          ? ((await health.json()) as {
              service?: string;
              hubReportArchiveFormats?: string[];
            })
          : null;
        if (
          v?.service !== "aerodb-api" ||
          !v.hubReportArchiveFormats?.includes("shared-result-v1")
        )
          throw new Error(
            "Serving hub API has not enabled shared-result reads",
          );
        if (!verifiedUntil)
          console.info(
            JSON.stringify({
              component: "stopped-report-cloud-scan",
              scope,
              verifiedApi: true,
              rssBytes: process.memoryUsage.rss(),
            }),
          );
        verifiedUntil = Date.now() + 30_000;
      }
      if (!queue.length) {
        if (scope === "all") {
          const page: { key: string; ready: boolean }[] = await db.execute<{
            key: string;
            ready: boolean;
          }>(sql`WITH candidates AS MATERIALIZED (SELECT id FROM sim_jobs
            WHERE status='cancelled' AND "ingestedAt" IS NULL ${after ? sql`AND id>${after}::uuid` : sql``} ORDER BY id LIMIT 64)
            SELECT c.id AS key, CASE WHEN (${cancelledReportOwner}) THEN true ELSE false END AS ready
            FROM candidates c JOIN sim_jobs job ON job.id=c.id LEFT JOIN progressive_remote_dispatches d ON d.sim_job_id=c.id
            LEFT JOIN sync_sweep_promises promise ON promise.id=d.promise_id ORDER BY c.id`);
          after = page.length ? String(page.at(-1)!.key) : null;
          queue = page
            .filter((r) => r.ready === true)
            .map((r) => String(r.key));
          if (!after) {
            wait = worked ? 250 : 600_000;
            worked = false;
          }
        } else queue = [scope];
      }
      const id = queue[0];
      if (id) {
        const result = await advanceSharedReportOwner(db, store, directory, id);
        queue.shift();
        if (!result.complete) worked = true;
        if (scope !== "all" && result.complete) wait = 600_000;
        else if (result.changed) wait = 250;
      }
    } catch (e) {
      console.error(
        "[stopped-report-cloud-copy]",
        queue[0],
        e instanceof Error ? e.message : String(e),
      );
      queue.shift();
      wait = 30_000;
    }
    try {
      await delay(wait, undefined, { signal });
    } catch (e) {
      if (!signal.aborted) throw e;
    }
  }
}
