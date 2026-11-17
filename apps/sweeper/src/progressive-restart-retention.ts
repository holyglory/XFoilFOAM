import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  canonicalAnalysisJson,
  isFinalProgressiveRemoteReport,
  type DB,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { assertProgressiveWorkerEvidenceJob } from "./progressive-remote-jobs";

const BROKERED_RECEIPT_NAMES = [
  "brokered_hub_binding.database.json",
  "brokered_local_reclaim.intent.json",
  "brokered_local_reclaim.json",
] as const;
const RECLAIM_PATH_KINDS = new Map([
  ["openfoam", "directory"],
  ["time_directories", "directory"],
  ["VTK", "directory"],
  ["engine_evidence.tar.zst", "file"],
  ["engine_evidence.tar.gz", "file"],
  ["openfoam_evidence.tar.gz", "file"],
]);
const SHA256 = /^[a-f0-9]{64}$/;
const safePath = (path: string) =>
  path
    .split("/")
    .every(
      (part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..",
    );
const nonnegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

async function readRetainedMetadata(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Retained brokered metadata is unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024)
        throw new Error("Retained brokered metadata exceeds its size bound");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Retained brokered metadata is not an object");
  return { text, value };
}

/** Recognize retained metadata only; this is never archive/deletion authority. */
async function onlyRetainedBrokeredMetadata(
  db: DB,
  engine: Partial<Pick<EngineClient, "fileUrl">>,
  report: ProgressiveRemoteReport,
  entries: string[],
): Promise<boolean> {
  if (!entries.length) return true;
  if (!engine.fileUrl || entries.length > 384) return false;
  const result = report.result!;
  const manifests = new Map<
    string,
    { caseSlug: string; base: string; sha256: string; size: number }
  >();
  for (const polar of result.polars) {
    for (const point of [...polar.points, ...(polar.attempts ?? [])]) {
      if (
        !point.case_slug ||
        !safePath(point.case_slug) ||
        point.case_slug.includes("/")
      )
        continue;
      for (const artifact of point.evidence_artifacts ?? []) {
        if (
          artifact.kind !== "manifest" ||
          !safePath(artifact.path) ||
          !artifact.path.endsWith("/evidence_manifest.json") ||
          !SHA256.test(artifact.sha256) ||
          !nonnegativeInteger(artifact.byte_size) ||
          !artifact.byte_size
        )
          continue;
        const base = artifact.path.slice(0, -"/evidence_manifest.json".length);
        const directory = `cases/${point.case_slug}/${base}`;
        const manifest = {
          caseSlug: point.case_slug,
          base,
          sha256: artifact.sha256,
          size: artifact.byte_size,
        };
        const previous = manifests.get(directory);
        if (
          previous &&
          canonicalAnalysisJson(previous) !== canonicalAnalysisJson(manifest)
        )
          return false;
        manifests.set(directory, manifest);
      }
    }
  }
  const directories = new Set<string>();
  for (const entry of entries) {
    const slash = entry.lastIndexOf("/");
    const directory = entry.slice(0, slash);
    if (
      !safePath(entry) ||
      !manifests.has(directory) ||
      !BROKERED_RECEIPT_NAMES.some((name) => entry.slice(slash + 1) === name)
    )
      return false;
    directories.add(directory);
  }
  if (directories.size > 128) return false;
  const deadlineAt = Date.now() + 10_000;
  const signal = AbortSignal.timeout(10_000);
  for (const directory of directories) {
    signal.throwIfAborted();
    const reads = await Promise.allSettled(
      BROKERED_RECEIPT_NAMES.map((name) =>
        readRetainedMetadata(
          engine.fileUrl!(result.job_id, `${directory}/${name}`),
          signal,
        ),
      ),
    );
    const [ack, intent, completed] = reads.map((read) => {
      if (read.status === "rejected") throw read.reason;
      return read.value;
    });
    const authorization = ack.value.authorization;
    const custody = authorization?.receipt;
    const manifest = manifests.get(directory)!;
    if (
      ack.value.schemaVersion !== 1 ||
      ack.value.state !== "hub_progressive_custody" ||
      typeof ack.value.registeredAt !== "string" ||
      !Number.isFinite(Date.parse(ack.value.registeredAt)) ||
      authorization?.schemaVersion !== 1 ||
      authorization.jobId !== result.job_id ||
      authorization.caseSlug !== manifest.caseSlug ||
      authorization.evidenceBase !== manifest.base ||
      custody?.schemaVersion !== 1 ||
      custody.kind !== "hub-progressive-evidence-custody" ||
      custody.source?.engineJobId !== result.job_id ||
      custody.source?.engineCaseSlug !== manifest.caseSlug ||
      !SHA256.test(authorization.receiptHmac) ||
      custody.remote?.manifestSha256 !== manifest.sha256 ||
      custody.remote?.manifestByteSize !== manifest.size ||
      intent.value.schemaVersion !== 1 ||
      intent.value.kind !== "brokered-local-evidence-reclaim-intent" ||
      completed.value.schemaVersion !== 1 ||
      completed.value.state !== "complete" ||
      canonicalAnalysisJson(intent.value.authorization) !==
        canonicalAnalysisJson(authorization) ||
      canonicalAnalysisJson(completed.value.authorization) !==
        canonicalAnalysisJson(authorization)
    )
      return false;
    const paths = intent.value.paths;
    if (
      !Array.isArray(paths) ||
      paths.length > RECLAIM_PATH_KINDS.size ||
      paths.some(
        (path) =>
          !path ||
          !RECLAIM_PATH_KINDS.has(path.name) ||
          path.kind !== RECLAIM_PATH_KINDS.get(path.name) ||
          !nonnegativeInteger(path.byteSize) ||
          !nonnegativeInteger(path.entryCount) ||
          !SHA256.test(path.treeSha256),
      ) ||
      new Set(paths.map((path) => path.name)).size !== paths.length ||
      intent.value.plannedPathCount !== paths.length ||
      !nonnegativeInteger(intent.value.plannedBytes) ||
      intent.value.plannedBytes !==
        paths.reduce((sum, path) => sum + path.byteSize, 0) ||
      completed.value.bytesDeleted !== intent.value.plannedBytes ||
      canonicalAnalysisJson(completed.value.deletedPaths) !==
        canonicalAnalysisJson(paths.map((path) => path.name).sort())
    )
      return false;
    // Python writes sorted JSON for both the intent file and its digest. Remove
    // only whitespace outside strings, preserving its number/Unicode spelling.
    const compactIntent = intent.text.replace(
      /"(?:\\.|[^"\\])*"|\s+/g,
      (token) => (token.startsWith('"') ? token : ""),
    );
    if (
      completed.value.intentSha256 !==
      createHash("sha256").update(compactIntent).digest("hex")
    )
      return false;
    signal.throwIfAborted();
    // The database proof shares the metadata deadline, rather than getting a
    // fresh ten-second query budget for each directory. The enclosing
    // transaction resets this local setting when it finishes.
    await db.execute(
      sql`SET LOCAL statement_timeout = ${sql.raw(String(Math.max(1, deadlineAt - Date.now())))}`,
    );
    const [stored] = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM progressive_worker_archive_receipts custody
        JOIN progressive_worker_archive_reclaims reclaim USING (sim_job_id, point_content_signature)
        WHERE custody.sim_job_id=${result.job_id}::uuid
          AND custody.point_content_signature=${custody.source?.progressiveEvidence?.pointContentSignature}
          AND custody.brokered_upload_id::text=${custody.brokeredUploadId}
          AND custody.receipt=${JSON.stringify({ receipt: custody, receiptHmac: authorization.receiptHmac })}::jsonb
          AND reclaim.completed_at IS NOT NULL
      ) AS retained
    `);
    if (stored?.retained !== true) return false;
    signal.throwIfAborted();
  }
  return true;
}

export async function reclaimProgressiveRestartState(
  db: DB,
  engine: Pick<EngineClient, "stripJob"> &
    Partial<Pick<EngineClient, "fileUrl">>,
  executionId?: string,
) {
  if (
    executionId !== undefined &&
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(executionId)
  )
    throw new Error("Restart reclamation requires an exact execution UUID");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [state] =
      await connection.execute(sql`SELECT disk_admission_blocked,set_config('statement_timeout','10000',true) FROM sweeper_state
      WHERE id=1`);
    if (state?.disk_admission_blocked !== true)
      return { stripped: 0, bytesFreed: 0 };
    const candidates = await connection.execute(sql`
      WITH live_jobs AS MATERIALIZED (
        SELECT parent_job_id,request_payload#>>'{engineRequest,continue_from,engine_job_id}' AS continuation
        FROM sim_jobs WHERE status IN ('pending','submitted','running','ingesting')
      ), selected AS MATERIALIZED (
      SELECT job.id FROM sim_jobs job
      WHERE job.status IN ('done','failed','cancelled') AND job.engine_job_id=job.id::text
        ${executionId ? sql`AND job.id=${executionId}::uuid` : sql``}
        AND job.request_payload ? 'remoteProgressiveExecution'
        AND (job.stripped_at IS NULL OR job.strip_report->>'kept_case_state'='true')
        AND (job.ingest_lease_expires_at IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
        AND EXISTS (SELECT 1 FROM progressive_worker_reports report
          WHERE report.sim_job_id=job.id AND report.stopped_engine_job_id=job.id::text)
        AND NOT EXISTS (SELECT 1 FROM live_jobs child
          WHERE child.parent_job_id=job.id OR child.continuation=job.id::text)
        AND NOT EXISTS (SELECT 1 FROM sim_urans_requests request JOIN results result ON result.id=request.continue_from_result_id
          WHERE result.sim_job_id=job.id AND request.state IN ('pending','submitted','running','ingesting'))
        AND NOT EXISTS (SELECT 1 FROM sim_precalc_obligation_attempts source
          JOIN sim_precalc_obligations obligation ON obligation.id=source.obligation_id
          JOIN result_attempts attempt ON attempt.id=source.result_attempt_id
          WHERE attempt.sim_job_id=job.id AND obligation.state='running')
        AND NOT EXISTS (SELECT 1 FROM sim_urans_verify_queue verification
          JOIN result_attempts attempt ON attempt.id=verification.latest_result_attempt_id
          WHERE attempt.sim_job_id=job.id AND verification.state IN ('pending','running')
            AND verification.last_outcome IN ('continuation_pending','continuation_retry_wait'))
      ORDER BY job."updatedAt",job.id LIMIT 1 FOR UPDATE OF job SKIP LOCKED)
      SELECT selected.id,report.sequence,report.report FROM selected
      JOIN LATERAL (SELECT sequence,public.resolve_progressive_report(to_jsonb(progressive_worker_reports.*)) AS report FROM progressive_worker_reports
        WHERE sim_job_id=selected.id ORDER BY sequence DESC LIMIT 1) report ON true`);
    if (!candidates.length) return { stripped: 0, bytesFreed: 0 };
    const candidate = candidates[0];
    const id = String(candidate.id);
    const report = candidate.report as unknown as ProgressiveRemoteReport;
    if (!isFinalProgressiveRemoteReport(report) || report.result === null) {
      await connection.execute(
        sql`UPDATE sim_jobs SET "updatedAt"=clock_timestamp() WHERE id=${id}::uuid`,
      );
      return { stripped: 0, bytesFreed: 0 };
    }
    const owned = await assertProgressiveWorkerEvidenceJob(connection, {
      simJobId: id,
      engineJobId: id,
      reportSequence: Number(candidate.sequence),
      result: report.result,
    });
    if (!owned)
      throw new Error("Restart reclamation has no exact worker evidence owner");
    try {
      const receipt = await engine.stripJob(
        id,
        { keep_case_state: false },
        { timeoutMs: 30000 },
      );
      if (
        receipt.job_id !== id ||
        receipt.kept_case_state !== false ||
        !Array.isArray(receipt.unknown_entries) ||
        receipt.unknown_entries.some((entry) => typeof entry !== "string") ||
        !Number.isSafeInteger(receipt.bytes_freed) ||
        receipt.bytes_freed < 0
      )
        throw new Error(
          "Restart reclamation returned an invalid exact-job receipt",
        );
      let complete = false;
      let metadataError: string | undefined;
      try {
        complete = await onlyRetainedBrokeredMetadata(
          connection,
          engine,
          report,
          receipt.unknown_entries!,
        );
      } catch {
        metadataError = "Retained brokered metadata could not be validated";
      }
      await connection.execute(sql`UPDATE sim_jobs SET strip_report=${JSON.stringify(receipt)}::jsonb,
        stripped_at=${complete ? sql`clock_timestamp()` : sql`NULL`},"updatedAt"=clock_timestamp()
        WHERE id=${id}::uuid`);
      return {
        stripped: complete ? 1 : 0,
        bytesFreed: receipt.bytes_freed,
        ...(metadataError ? { error: metadataError } : {}),
      };
    } catch (error) {
      await connection.execute(
        sql`UPDATE sim_jobs SET "updatedAt"=clock_timestamp() WHERE id=${id}::uuid`,
      );
      return {
        stripped: 0,
        bytesFreed: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
