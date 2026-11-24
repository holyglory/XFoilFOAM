import { sql } from "drizzle-orm";
import { isAbsolute, join } from "node:path";
import { readReceipt as read, writeReceipt as write, stoppedReportArchivePrefix, stoppedReportReceiptDirectory } from "./stopped-report-receipt-files";
import { setTimeout as delay } from "node:timers/promises";
import type { DB } from "@aerodb/db/client";
import { cancelledReportOwner, type CancelledReportCopyPriority } from "./cancelled-report-copies";
import {
  copyStoppedReportBatch,
  offerStoppedReportCopyWindows,
  stoppedReportCopyKeys,
  type StoppedCopyReceipt,
} from "./shared-stopped-report-custody";
import {
  retireNextPreservedAnchor,
  type AnchorWalk,
} from "./stopped-report-anchor-retirement";
import { sharedReportTotals } from "./shared-report-totals";
import { HubReportObjects, sha256 } from "./shared-report-objects";

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
interface Cursor {
  scientificAfter?: number;
  scientificComplete?: boolean;
  ordinaryNext?: boolean;
  after: number;
  frontier: string;
  complete: boolean;
}
interface PageLedger {
  members: Record<string, { signature: string; receipt: string }>;
}
export async function stoppedReportOwnerFrontier(db: DB, id: string) {
  const [o] =
    await db.execute(sql`SELECT d.content_signature AS assignment,st.proof_signature AS stop,
    (SELECT max(sequence)::text FROM progressive_remote_reports r WHERE r.sim_job_id=job.id) AS last,
    (SELECT max(sequence)::text FROM progressive_remote_progress_receipts p WHERE p.sim_job_id=job.id) AS applied,
    receipts.scientific,
    (SELECT count(*)::int FROM progressive_remote_diagnostic_receipts e WHERE e.sim_job_id=job.id) AS diagnostic,
    receipts.latest
    FROM sim_jobs job JOIN progressive_remote_dispatches d ON d.sim_job_id=job.id JOIN sync_sweep_promises promise ON promise.id=d.promise_id
    JOIN progressive_cfd_execution_stops st ON st.sim_job_id=job.id AND st.engine_job_id=job.engine_job_id
    CROSS JOIN LATERAL (SELECT count(*)::int AS scientific, max(e.sequence) AS latest
      FROM progressive_remote_evidence_receipts e WHERE e.sim_job_id=job.id) receipts
    WHERE job.id=${id}::uuid AND ${cancelledReportOwner}`);
  if (!o?.last) return null;
  // The extra seek hint is outside the durable frontier hash used by existing cursors.
  const { latest, ...facts } = o;
  const sequence = Number(latest);
  return { frontier: sha256(JSON.stringify(facts)),
    latestReceipt: Number.isSafeInteger(sequence) && sequence > 0 && sequence < Number(o.last) ? sequence : null };
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
  eligibleAnchors = false,
  priority?: CancelledReportCopyPriority,
) {
  if (!uuid.test(id) || !isAbsolute(dir))
    throw new Error("Invalid stopped report owner or receipt path");
  const owner = await stoppedReportOwnerFrontier(db, id);
  if (!owner) return { complete: true, changed: 0 };
  const { frontier } = owner;
  const root = join(dir, id),
    cursorFile = join(root, "cursor.json");
  const prior = await read<Cursor>(cursorFile);
  const anchorFile = join(root, "anchor-walk.json");
  const hooks = {
    beforeCommit: (r: StoppedCopyReceipt) =>
      write(join(root, "sql-releases", r.object.sha256 + ".json"), r),
    beforePublish: async (r: StoppedCopyReceipt) => {
      const file = join(root, "verified", r.object.sha256 + ".json");
      // Retrying after a crash between readback and SQL commit must still find
      // the previously preserved original, even when the page pin is reused.
      if (
        r.mode === "anchor" &&
        (await read<StoppedCopyReceipt>(file))?.mode === "preserve"
      )
        return;
      await write(file, r);
    },
  };
  const state = eligibleAnchors
    ? await read<AnchorWalk & { regular: boolean; frontier: string }>(
        anchorFile,
      )
    : null;
  if (
    eligibleAnchors &&
    (!state?.regular || prior?.complete) &&
    (!state?.finishedAt ||
      state.frontier !== frontier ||
      Date.now() - state.finishedAt >= 600_000)
  ) {
    const step = await retireNextPreservedAnchor(
      db,
      objects,
      root,
      id,
      state?.frontier === frontier ? state : { after: "", finishedAt: 0 },
      hooks,
    );
    await write(anchorFile, { ...step.walk, frontier, regular: true });
    if (step.receipt) {
      const r = step.receipt,
        hash = await preserveReceipt(root, r);
      if (prior?.complete)
        await write(cursorFile, { ...prior, complete: false });
      console.info(
        JSON.stringify({
          component: "stopped-report-cloud-copy",
          job: id,
          mode: r.mode,
          receipt: hash,
          members: r.members.length,
          attached: r.released,
          manifestBytes: r.object.size,
          resultBytesSubmitted: r.resultBytesSubmitted,
          sqlReportFieldBytesReleased:
            r.storedReportFieldsBefore - r.storedReportFieldsAfter,
          releasedReferenceBytes: r.releasedReferenceBytes,
          releasedProtectedResults: r.releasedProtectedResults,
          rssBytes: process.memoryUsage.rss(),
          peakRssBytes: process.resourceUsage().maxRSS * 1024,
        }),
      );
      return { complete: false, changed: r.released };
    }
    if (step.more && prior?.complete) return { complete: false, changed: 0 };
  } else if (eligibleAnchors && state?.regular) {
    await write(anchorFile, { ...state, regular: false });
  }
  if (prior?.frontier === frontier && prior.scientificComplete && priority) {
    // Signed offers live in memory. A completed on-disk scan can still own
    // ordinary reports after a restart or after another owner's offer won.
    try {
      await priority.refillFromWarmReports(db, id);
    } catch (error) {
      console.warn("[sweeper] remaining stopped report window", id,
        error instanceof Error ? error.message : String(error));
    }
  }
  if (prior?.complete && prior.frontier === frontier)
    return { complete: true, changed: 0 };
  const cursor: Cursor =
    prior?.frontier === frontier
      ? prior
      : { after: 0, frontier, complete: false };
  const scientific = !cursor.scientificComplete && !cursor.ordinaryNext;
  const after = scientific ? (cursor.scientificAfter ?? 0) : cursor.after;
  const keys = await stoppedReportCopyKeys(db, id, after, 32, scientific);
  if (scientific && priority)
    await offerStoppedReportCopyWindows(db, id, keys, owner.latestReceipt, priority);
  if (!keys.length) {
    if (scientific) {
      await write(cursorFile, {
        ...cursor,
        scientificComplete: true,
        ordinaryNext: true,
      });
      return { complete: false, changed: 0 };
    }
    const totals = await sharedReportTotals(db, root, id);
    await write(join(root, "totals.json"), totals);
    console.info(
      JSON.stringify({ component: "stopped-report-cloud-totals", ...totals }),
    );
    await write(cursorFile, { ...cursor, complete: true });
    return {
      complete: !(eligibleAnchors && state?.finishedAt === 0),
      changed: 0,
    };
  }
  if (keys.some((k) => k.mode === "missing"))
    throw new Error("Stopped source inventory or applied progress is missing");
  let changed = 0;
  for (const mode of ["preserve", "release"] as const) {
    const ledgerFile = join(
      root,
      "windows",
      (scientific ? "sources-" : "") + String(after) + ".json",
    );
    const ledger = (await read<PageLedger>(ledgerFile)) ?? { members: {} };
    const requested = keys.filter((k) => k.mode === mode);
    const remaining = [];
    const known = new Map<string, StoppedCopyReceipt>();
    for (const k of requested) {
      const saved =
        ledger.members[k.sequence] ??
        (mode === "preserve"
          ? await read<{ signature: string; receipt: string }>(
              join(root, "preserved-sources", k.sequence + ".json"),
            )
          : null);
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
      if (changed) {
        await write(cursorFile, { ...cursor, ordinaryNext: scientific });
        return { complete: false, changed };
      }
      const receipt = await copyStoppedReportBatch(
        db,
        objects,
        id,
        remaining,
        mode,
        hooks,
      );
      const hash = await preserveReceipt(root, receipt);
      if (eligibleAnchors && mode === "preserve")
        await write(anchorFile, {
          after: "",
          finishedAt: 0,
          frontier,
          regular: false,
        });

      for (const m of receipt.members) {
        const entry = { signature: m.signature, receipt: hash };
        ledger.members[m.sequence] = entry;
        if (mode === "preserve")
          await write(
            join(root, "preserved-sources", m.sequence + ".json"),
            entry,
          );
      }
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
      if (remaining.length) {
        await write(cursorFile, { ...cursor, ordinaryNext: scientific });
        return { complete: false, changed };
      }
    }
  }
  await write(cursorFile, {
    ...cursor,
    [scientific ? "scientificAfter" : "after"]: keys.at(-1)!.sequence,
    ordinaryNext: scientific,
    complete: false,
  });
  return { complete: false, changed };
}

export async function runSharedStoppedReportStorage(
  db: DB,
  signal: AbortSignal,
  priority?: CancelledReportCopyPriority,
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
  const directory = stoppedReportReceiptDirectory();
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
    stoppedReportArchivePrefix(),
  );
  let after: string | null = null,
    queue: string[] = [];
  let anchorReader = false;
  const anchorScope =
    process.env.AIRFOILFOAM_STOPPED_REPORT_ANCHOR_SCOPE?.trim() || "all";
  let worked = false,
    verifiedUntil = 0;
  // Only an owner that reached advancement can defer its own next turn.
  // A global capability or discovery failure keeps the queued owner in place.
  const retryAfter = new Map<string, number>();
  let nextOwnerRetry = Infinity;
  while (!signal.aborted) {
    let wait = 500;
    let owner: string | undefined;
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
              hubStoppedReportAnchorReader?: number;
            })
          : null;
        if (
          v?.service !== "aerodb-api" ||
          !v.hubReportArchiveFormats?.includes("shared-result-v1")
        )
          throw new Error(
            "Serving hub API has not enabled shared-result reads",
          );
        anchorReader = v.hubStoppedReportAnchorReader === 1;
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
          const now = Date.now();
          for (const row of page) {
            if (!row.ready) continue;
            const retry = retryAfter.get(row.key);
            if (retry !== undefined && retry > now) {
              nextOwnerRetry = Math.min(nextOwnerRetry, retry);
            } else {
              queue.push(row.key);
            }
          }
          if (!after) {
            wait = Math.min(worked ? 250 : 600_000, Math.max(250, nextOwnerRetry - now));
            worked = false;
            nextOwnerRetry = Infinity;
            for (const [id, retry] of retryAfter) {
              if (retry <= now) retryAfter.delete(id);
            }
          }
        } else queue = [scope];
      }
      owner = queue.shift();
      if (owner) {
        const result = await advanceSharedReportOwner(
          db,
          store,
          directory,
          owner,
          anchorReader && (anchorScope === "all" || anchorScope === owner),
          priority,
        );
        retryAfter.delete(owner);
        if (!result.complete) worked = true;
        if (scope !== "all" && result.complete) wait = 600_000;
        else if (result.changed) wait = 250;
      }
    } catch (e) {
      console.error(
        "[stopped-report-cloud-copy]",
        owner ?? "reader availability or owner discovery",
        e instanceof Error ? e.message : String(e),
      );
      if (owner && scope === "all") {
        const retry = Date.now() + 30_000;
        retryAfter.set(owner, retry);
        nextOwnerRetry = Math.min(nextOwnerRetry, retry);
      } else {
        wait = 30_000;
      }
    }
    try {
      await delay(wait, undefined, { signal });
    } catch (e) {
      if (!signal.aborted) throw e;
    }
  }
}
