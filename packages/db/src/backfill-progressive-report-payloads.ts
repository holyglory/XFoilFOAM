import { resolveStoredProgressiveReport } from "./progressive-report-reader";
import { sql as query } from "drizzle-orm";
import {
  backfillWorkerReportPrefix,
  type WorkerPrefixCursor,
} from "./progressive-report-prefix";
import { createClient } from "./client";
import { validateProgressiveRemoteReport } from "./progressive-remote-report";
import type { ProgressiveRemoteExecutionEnvelope } from "./progressive-remote-execution";
import {
  backfillProgressiveReportPayloads,
  progressiveReportStorageSample,
  progressiveReportStorageTotals,
  proveProgressiveReportsInline,
  progressiveReportTables,
  setProgressiveReportNormalization,
  type ProgressiveReportCursor,
} from "./progressive-report-payloads";

const usage =
  "backfill:progressive-report-payloads [--dry-run|--apply] [--restore-inline] [--prove-inline] [--table=worker|remote|both] [--rows=1..128] [--batches=1..1000] [--max-bytes=N] [--after-worker=UUID:SEQUENCE] [--after-remote=UUID:SEQUENCE] [--enable-writes --readers-ready|--disable-writes] [--stats-only [--full-stats]] [--verify-execution=UUID] | --native-prefix [--apply] [--execution=UUID] [--exclude-jobs=UUID,...] [--after-worker=UUID:SEQUENCE|UUID:end] [--min-stored-bytes=N] [--rows=N --max-bytes=N --batches=N]";
const flags = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z-]+)(?:=(.+))?$/.exec(arg);
  if (!match || flags.has(match[1])) throw new Error(usage);
  flags.set(match[1], match[2] ?? "true");
}
const booleans = [
  "dry-run",
  "apply",
  "native-prefix",
  "enable-writes",
  "readers-ready",
  "disable-writes",
  "stats-only",
  "full-stats",
  "restore-inline",
  "prove-inline",
];
if (
  [...flags].some(
    ([key, value]) =>
      ![
        ...booleans,
        "table",
        "rows",
        "batches",
        "max-bytes",
        "after-worker",
        "after-remote",
        "verify-execution",
        "execution",
        "min-stored-bytes",
        "exclude-jobs",
      ].includes(key) ||
      (booleans.includes(key) && value !== "true"),
  ) ||
  (flags.has("apply") && flags.has("dry-run")) ||
  (flags.has("enable-writes") && flags.has("disable-writes")) ||
  ((flags.has("enable-writes") || flags.has("disable-writes")) &&
    !flags.has("apply")) ||
  (flags.has("enable-writes") && !flags.has("readers-ready")) ||
  (flags.has("full-stats") && !flags.has("stats-only")) ||
  (flags.has("restore-inline") && flags.has("enable-writes")) ||
  (flags.has("prove-inline") &&
    (flags.has("restore-inline") ||
      flags.has("enable-writes") ||
      (flags.get("table") ?? "both") !== "both"))
)
  throw new Error(usage);
const native = flags.has("native-prefix");
if (
  native
    ? [...flags.keys()].some(
        (k) =>
          ![
            "native-prefix",
            "apply",
            "dry-run",
            "execution",
            "exclude-jobs",
            "after-worker",
            "min-stored-bytes",
            "rows",
            "max-bytes",
            "batches",
          ].includes(k),
      )
    : ["execution", "exclude-jobs", "min-stored-bytes"].some((k) =>
        flags.has(k),
      )
)
  throw new Error(usage);
const mode = flags.has("apply") ? "apply" : "dry-run";
const selection = flags.get("table") ?? "both";
if (!["both", "worker", "remote"].includes(selection)) throw new Error(usage);
const rows = Number(flags.get("rows") ?? (native ? 8 : 16));
const batches = Number(flags.get("batches") ?? 1);
const maxBytes = Number(
  flags.get("max-bytes") ?? (native ? 96 : 64) * 1024 * 1024,
);
if (
  !Number.isSafeInteger(rows) ||
  rows < 1 ||
  rows > 128 ||
  !Number.isSafeInteger(batches) ||
  batches < 1 ||
  batches > 1000 ||
  !Number.isSafeInteger(maxBytes) ||
  maxBytes < 1 ||
  maxBytes > 512 * 1024 * 1024
)
  throw new Error(usage);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const verifyExecution = flags.get("verify-execution");
if (verifyExecution && !uuid.test(verifyExecution)) throw new Error(usage);
const cursors = new Map<string, ProgressiveReportCursor | null>();
for (const side of native ? [] : ["worker", "remote"]) {
  const value = flags.get(`after-${side}`);
  const [executionId, sequence, extra] = value?.split(":") ?? [];
  if (
    value &&
    (!uuid.test(executionId) ||
      !Number.isSafeInteger(Number(sequence)) ||
      Number(sequence) < 1 ||
      extra)
  )
    throw new Error(usage);
  cursors.set(side, value ? { executionId, sequence: Number(sequence) } : null);
}

const { db, sql } = createClient({
  max: 1,
  connection: native
    ? {
        application_name: "native-worker-report-sharing",
        ...(mode === "dry-run" ? { default_transaction_read_only: "on" } : {}),
      }
    : undefined,
});
try {
  if (native) {
    if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver")
      throw new Error("Native sharing requires the remote-solver role");
    const raw = flags.get("after-worker");
    let after: WorkerPrefixCursor | null = null;
    if (raw) {
      const [executionId, position, extra] = raw.split(":");
      if (
        !uuid.test(executionId) ||
        extra ||
        !/^(?:end|[0-9]+)$/.test(position)
      )
        throw new Error(usage);
      after = {
        executionId,
        sequence: position === "end" ? null : Number(position),
      };
    }
    const excludeJobs = [
      process.env.AIRFOILFOAM_NATIVE_REPORT_EXCLUDE_JOBS,
      flags.get("exclude-jobs"),
    ]
      .filter(Boolean)
      .join(",")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (let batch = 0; batch < batches; batch++) {
      const r = await backfillWorkerReportPrefix(db, {
        apply: mode === "apply",
        after,
        executionId: flags.get("execution"),
        excludeJobs,
        rows,
        maxBytes,
        minStoredBytes: Number(flags.get("min-stored-bytes") ?? 262144),
      });
      console.log(
        JSON.stringify({
          mode,
          batch: batch + 1,
          ...r,
          physicalSpaceReleased: null,
        }),
      );
      after = r.after;
      if (
        r.state === "complete" ||
        r.state === "disabled" ||
        r.state === "busy" ||
        r.state === "timed-out"
      )
        break;
    }
  }
  if (flags.has("enable-writes") || flags.has("disable-writes")) {
    await setProgressiveReportNormalization(db, {
      enabled: flags.has("enable-writes"),
      readersReady: flags.has("readers-ready"),
    });
    console.log(
      JSON.stringify({ normalizationEnabled: flags.has("enable-writes") }),
    );
  }
  if (flags.has("prove-inline")) {
    const proof = await proveProgressiveReportsInline(db);
    console.log(JSON.stringify(proof));
    if (!proof.oldReaderRollbackSafe) process.exitCode = 1;
  }
  for (const table of native || flags.has("prove-inline")
    ? []
    : progressiveReportTables) {
    const side = table === "progressive_worker_reports" ? "worker" : "remote";
    if (selection !== "both" && selection !== side) continue;
    if (verifyExecution) {
      const reports =
        await db.execute(query`SELECT public.resolve_progressive_report(to_jsonb(report.*)) AS report,
        report.content_signature, report.result_payload_hash,
        ${side === "worker" ? query`job.request_payload->'remoteProgressiveExecution'` : query`dispatch.envelope`} AS envelope
        FROM ${query.identifier(table)} report
        ${
          side === "worker"
            ? query`JOIN sim_jobs job ON job.id = report.sim_job_id`
            : query`JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id = report.sim_job_id`
        }
        WHERE report.sim_job_id = ${verifyExecution}::uuid ORDER BY report.sequence DESC LIMIT ${rows}`);
      for (const stored of reports) {
        const validated = validateProgressiveRemoteReport(
          await resolveStoredProgressiveReport(
            db,
            side,
            stored,
            verifyExecution,
          ),
          stored.envelope as ProgressiveRemoteExecutionEnvelope,
        );
        if (validated.contentSignature !== stored.content_signature)
          throw new Error(
            "Stored report signature differs from reconstructed transport report",
          );
      }
      console.log(
        JSON.stringify({
          table,
          executionId: verifyExecution,
          checked: reports.length,
          normalized: reports.filter(
            (report) => report.result_payload_hash !== null,
          ).length,
          signaturesVerified: reports.length > 0,
        }),
      );
      continue;
    }
    if (flags.has("stats-only")) {
      console.log(
        JSON.stringify(
          flags.has("full-stats")
            ? await progressiveReportStorageTotals(db, table)
            : await progressiveReportStorageSample(db, table, {
                rows,
                after: cursors.get(side),
              }),
        ),
      );
      continue;
    }
    if (flags.has("disable-writes") && !flags.has("restore-inline")) continue;
    const before = await progressiveReportStorageSample(db, table, {
      rows,
      after: cursors.get(side),
    });
    let after = cursors.get(side);
    for (let batch = 0; batch < batches; batch++) {
      const receipt = await backfillProgressiveReportPayloads(db, {
        table,
        apply: mode === "apply",
        restoreInline: flags.has("restore-inline"),
        after,
        rows,
        maxBytes,
      });
      console.log(JSON.stringify({ mode, batch: batch + 1, ...receipt }));
      after = receipt.after;
      if (receipt.complete || receipt.locked > 0) break;
    }
    console.log(
      JSON.stringify({
        table,
        before,
        after: await progressiveReportStorageSample(db, table, {
          rows,
          after: cursors.get(side),
        }),
        resumeAfter: after,
        physicalSpaceReleased:
          "not measured; UPDATE makes pages reusable, OS reclamation is separate",
      }),
    );
  }
} finally {
  await sql.end();
}
