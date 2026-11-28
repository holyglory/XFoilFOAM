import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  analysisContentHash,
  progressiveReportedPointSources,
  validateProgressiveRemoteReport,
  verifyProgressiveRemoteExecution,
  type ProgressiveRemoteExecutionEnvelope,
  type DB,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import { configuredDeploymentRole } from "./config";
import { fetchProgressiveRemote } from "./progressive-remote-http";
import {
  provenTerminalDiagnostic,
  readTerminalDiagnostics,
  type TerminalDiagnostics,
} from "./progressive-terminal-diagnostic";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const pageRows = 64;
const seen = new WeakMap<DB, { expiry: string; id: string }>();
const nextInspection = new WeakMap<DB, Map<string, number>>();

// The assignment creator locks the promise before inserting an execution.
// Stop, report publication and evidence staging lock the job. Reacquire both
// before the final obligation check; no HTTP or scientific body hashing there.
const owner = sql`FROM sync_sweep_promises p
  JOIN sync_api_settings cfg ON cfg.id=1 AND cfg.remote_solver_enabled
    AND NOT cfg.remote_solver_transfer_paused AND cfg.remote_solver_auth_token<>''
    AND cfg.remote_solver_registered_id=p.registered_solver_id AND cfg.upstream_base_url=p.source_base_url
  JOIN registered_remote_solvers solver ON solver.id=p.registered_solver_id AND solver.instance_id=cfg.instance_id::text AND solver.revoked_at IS NULL
  JOIN LATERAL (SELECT job.* FROM sim_jobs job WHERE job.id=CASE
    WHEN p.request_payload->>'progressiveExecutionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (p.request_payload->>'progressiveExecutionId')::uuid END OFFSET 0) j ON true
  LEFT JOIN progressive_worker_submission_intents i ON i.sim_job_id=j.id
  JOIN LATERAL (SELECT r.sequence,r.content_signature,r.assignment_signature,r.stopped_engine_job_id,r.acknowledged_at,r.report,
      r.archive_bundle_id,r.result_payload_hash
    FROM progressive_worker_reports r WHERE r.sim_job_id=j.id ORDER BY r.sequence DESC LIMIT 1) stop ON true`;
const assignment = sql`j.request_payload#>>'{remoteProgressiveExecution,contentSignature}'`;
// A namespace cancellation fence can be acknowledged without a physical submission.
// Its logical job ID in the report identifies that fence.
const stoppedOwner = sql`(
  (j.engine_job_id=j.id::text AND i.assignment_signature=${assignment}
    AND stop.report#>>'{stopProof,ownership_basis}' IS DISTINCT FROM 'never_started_cancellation_fence')
  OR (j.engine_job_id IS NULL AND j.status='cancelled' AND j.engine_state='cancelled'
    AND (i.sim_job_id IS NULL OR i.assignment_signature=${assignment})
    AND stop.report#>>'{stopProof,ownership_basis}'='never_started_cancellation_fence'
    AND stop.report#>>'{stopProof,fence}'='cancel_marker'
    AND stop.archive_bundle_id IS NULL AND stop.result_payload_hash IS NULL
    AND stop.report->'result'='null'::jsonb AND stop.report#>'{status,completed_cases}'='0'::jsonb))`;
const terminal = sql`p.status='active' AND p.request_payload->>'remoteSolver'='true'
  AND p.request_payload->>'executionContract'='progressive-cfd-v1'
  AND p.request_payload->>'solverId'=solver.id::text AND p.request_payload->>'upstreamBaseUrl'=cfg.upstream_base_url
  AND j.status IN ('done','failed','cancelled') AND j.engine_state IN ('completed','failed','cancelled')
  AND ${stoppedOwner}
  AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
  AND j.request_payload->>'syncPromiseId'=p.id::text
  AND j.request_payload->>'remoteSolver'='true' AND j.request_payload->>'upstreamBaseUrl'=cfg.upstream_base_url
  AND j.request_payload#>>'{remoteProgressiveExecution,solverId}'=solver.id::text
  AND j.request_payload#>>'{remoteProgressiveExecution,promiseId}'=p.id::text
  AND j.request_payload#>>'{remoteProgressiveExecution,scope,executionId}'=j.id::text
  AND j.request_payload->'engineRequest'=j.request_payload#>'{remoteProgressiveExecution,request}'
  AND stop.assignment_signature=${assignment} AND stop.acknowledged_at IS NOT NULL
  AND stop.stopped_engine_job_id=j.id::text AND stop.report->>'executionId'=j.id::text
  AND stop.report#>>'{stopProof,job_id}'=j.id::text AND stop.report#>>'{status,job_id}'=j.id::text
  AND stop.report#>>'{stopProof,fence}' IN ('terminal_result','cancel_marker')
  AND stop.report#>>'{status,state}'=j.engine_state
  AND stop.report#>'{stopProof,execution_stopped}'='true'::jsonb
  AND stop.report#>'{stopProof,producer_stopped}'='true'::jsonb
  AND stop.report#>'{stopProof,namespace_verified}'='true'::jsonb
  AND stop.report#>'{stopProof,remaining}'='[]'::jsonb AND stop.report#>'{stopProof,error}'='null'::jsonb
  AND NOT EXISTS (SELECT FROM progressive_remote_dispatches d WHERE d.sim_job_id=j.id)
  AND NOT EXISTS (SELECT FROM progressive_cfd_attempts a WHERE a.sim_job_id=j.id)
  AND NOT EXISTS (SELECT FROM sim_jobs sibling WHERE sibling.id<>j.id
    AND (sibling.request_payload->>'syncPromiseId'=p.id::text OR sibling.engine_job_id=j.id::text))
  AND NOT EXISTS (SELECT FROM progressive_worker_submission_intents other
    WHERE other.assignment_signature=${assignment} AND other.sim_job_id<>j.id)
  AND NOT EXISTS (WITH live AS MATERIALIZED (SELECT id,request_payload FROM sim_jobs
    WHERE status IN ('pending','submitted','running','ingesting') OR engine_state IN ('cancelling','cancel_pending'))
    SELECT FROM live WHERE live.id<>j.id AND live.request_payload#>>'{remoteProgressiveExecution,promiseId}'=p.id::text)`;

// Ignore only completed/superseded transport. A missing custody receipt is
// outstanding even if no archive queue row has been allocated yet.
const settled = (
  diagnostics: TerminalDiagnostics,
) => sql`NOT EXISTS (SELECT FROM sync_remote_result_deliveries d
    WHERE (d.promise_id=p.id OR d.sim_job_id=j.id) AND d.state NOT IN ('delivered','superseded'))
  AND NOT EXISTS (SELECT FROM sync_remote_promise_cancellations c WHERE c.promise_id=p.id AND c.state<>'delivered')
  AND NOT EXISTS (SELECT FROM results live WHERE live.sim_job_id=j.id AND live.status IN ('pending','stale','queued','running'))
  AND NOT EXISTS (SELECT FROM progressive_worker_reports r WHERE r.sim_job_id=j.id AND r.acknowledged_at IS NULL)
  AND NOT EXISTS (SELECT FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=j.id)
  AND NOT EXISTS (SELECT FROM progressive_worker_staging_failures f WHERE f.sim_job_id=j.id)
  AND NOT EXISTS (SELECT FROM progressive_worker_delivery_failures f WHERE f.sim_job_id=j.id AND f.state='retry')
  AND NOT EXISTS (SELECT FROM progressive_worker_evidence_delivery_claims c WHERE c.sim_job_id=j.id AND c.claim_expires_at>clock_timestamp())
  AND NOT EXISTS (SELECT FROM progressive_worker_archive_deliveries a WHERE a.sim_job_id=j.id)
  AND (j.engine_job_id IS NOT NULL OR (
    NOT EXISTS(SELECT FROM result_attempts a WHERE a.sim_job_id=j.id OR a.engine_job_id=j.id::text)
    AND NOT EXISTS(SELECT FROM results r WHERE r.sim_job_id=j.id OR r.engine_job_id=j.id::text)
    AND NOT EXISTS(SELECT FROM solver_evidence_artifacts artifact WHERE artifact.engine_job_id=j.id::text)
    AND NOT EXISTS(SELECT FROM progressive_worker_evidence_attempts a WHERE a.sim_job_id=j.id)
    AND NOT EXISTS(SELECT FROM progressive_worker_hub_receipts h WHERE h.sim_job_id=j.id)
    AND NOT EXISTS(SELECT FROM progressive_worker_archive_receipts ar WHERE ar.sim_job_id=j.id)))
  AND NOT EXISTS (SELECT FROM progressive_worker_evidence_attempts a WHERE a.sim_job_id=j.id
    AND NOT EXISTS(SELECT FROM progressive_worker_hub_receipts h JOIN result_attempts attempt ON attempt.id=h.result_attempt_id
      WHERE h.sim_job_id=a.sim_job_id AND h.point_content_signature=a.point_content_signature AND h.result_attempt_id=a.result_attempt_id
        AND attempt.sim_job_id=j.id AND attempt.engine_job_id=j.engine_job_id AND attempt.airfoil_id=j.airfoil_id
        AND attempt.simulation_preset_revision_id=j.simulation_preset_revision_id AND j.bc_ids ? attempt.bc_id::text))
  AND NOT EXISTS (SELECT FROM progressive_worker_hub_receipts h WHERE h.sim_job_id=j.id
    AND NOT EXISTS(SELECT FROM progressive_worker_archive_receipts ar WHERE ar.sim_job_id=h.sim_job_id
      AND ar.point_content_signature=h.point_content_signature) AND NOT ${provenTerminalDiagnostic(diagnostics)})`;

interface Mirror {
  id: string;
  execution: string;
  solver: string;
  url: string;
  token: string;
  signature: string;
  sequence: number;
  finalSignature: string;
  stopSignature: string;
  engineJobId: string | null;
  intentToken: string | null;
  status: string;
  engine: string;
  expiry: string;
  envelope: ProgressiveRemoteExecutionEnvelope;
}

async function candidate(db: DB, promiseId?: string): Promise<Mirror | null> {
  const after = promiseId ? undefined : seen.get(db);
  const [r] =
    await db.execute(sql`SELECT p.id,j.id AS execution,solver.id AS solver,p.source_base_url AS url,
    cfg.remote_solver_auth_token AS token,${assignment} AS signature,stop.sequence,stop.content_signature AS final,
    j.engine_job_id,i.token AS intent_token,stop.report->'stopProof' AS stop_proof,
    j.status,j.engine_state,p."expiresAt"::text AS expiry,j.request_payload->'remoteProgressiveExecution' AS envelope
    ${owner} WHERE ${terminal} ${promiseId ? sql`AND p.id=${promiseId}::uuid` : sql``}
    ORDER BY ${after ? sql`(p."expiresAt",p.id)<=(${after.expiry}::timestamptz,${after.id}::uuid),` : sql``}
      p."expiresAt",p.id LIMIT 1`);
  if (!r) return null;
  const m: Mirror = {
    id: String(r.id),
    execution: String(r.execution),
    solver: String(r.solver),
    url: canonicalRemoteHubBaseUrl(String(r.url)),
    token: String(r.token),
    signature: String(r.signature),
    sequence: Number(r.sequence),
    finalSignature: String(r.final),
    stopSignature: analysisContentHash(r.stop_proof),
    engineJobId: r.engine_job_id == null ? null : String(r.engine_job_id),
    intentToken: r.intent_token == null ? null : String(r.intent_token),
    status: String(r.status),
    engine: String(r.engine_state),
    expiry: String(r.expiry),
    envelope: verifyProgressiveRemoteExecution(r.envelope, {
      solverId: String(r.solver),
      promiseId: String(r.id),
      executionId: String(r.execution),
      contentSignature: String(r.signature),
    }),
  };
  if (!promiseId) seen.set(db, { expiry: m.expiry, id: m.id });
  if (!Number.isSafeInteger(m.sequence) || m.sequence < 1) return null;
  return m;
}

async function cancelledAtHub(
  m: Mirror,
  fetcher: typeof fetch,
  diagnosticReceiptSetSignature?: string | null,
) {
  const reply = await fetchProgressiveRemote(
    fetcher,
    `${m.url}/progressive-executions/${m.execution}`,
    {
      headers: { "x-xfoilfoam-solver-token": m.token },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!reply.ok) {
    const hint = reply.headers.get("retry-after");
    const seconds = hint === null ? 0 : Number(hint);
    const retryMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, Date.parse(hint!) - Date.now()) || 0;
    await reply.body?.cancel();
    return { confirmed: false, httpStatus: reply.status, retryMs };
  }
  const value: unknown = await reply.json();
  if (!record(value) || !record(value.assignment))
    return { confirmed: false, httpStatus: reply.status };
  const a = value.assignment;
  if (
    !record(a.promise) ||
    !record(a.job) ||
    a.promise.id !== m.id ||
    a.promise.status !== "cancelled" ||
    a.job.status !== m.status ||
    a.job.engineState !== m.engine ||
    a.executionStopped !== true ||
    !record(a.terminalReceipt) ||
    a.terminalReceipt.reportSignature !== m.finalSignature ||
    a.terminalReceipt.stopProofSignature !== m.stopSignature ||
    (diagnosticReceiptSetSignature != null &&
      a.terminalReceipt.diagnosticReceiptSetSignature !==
        diagnosticReceiptSetSignature) ||
    a.receivedSequence !== m.sequence
  )
    return { confirmed: false, httpStatus: reply.status };
  try {
    verifyProgressiveRemoteExecution(a.envelope, {
      solverId: m.solver,
      promiseId: m.id,
      executionId: m.execution,
      contentSignature: m.signature,
    });
  } catch {
    return { confirmed: false, httpStatus: reply.status };
  }
  return { confirmed: true, httpStatus: reply.status };
}

// Compare exact PG result text, including numeric precision. A repeated
// receipt-less observation may still get staged normally after a lease closes.
// It can represent no new delivery only if the same assignment has already
// staged that exact SHA and length and positively delivered its evidence.
const reportStamp = sql`sha256(pg_catalog.record_send(ROW(r.sequence,r.content_signature,r.assignment_signature,
    r.tableoid,r.xmin::text,r.ctid,e.content_signature,links.points)))`;
const stagingReceipt = sql`LEFT JOIN progressive_worker_evidence_receipts e ON e.sim_job_id=r.sim_job_id AND e.sequence=r.sequence
  LEFT JOIN LATERAL (SELECT string_agg(a.point_content_signature||':'||a.result_attempt_id::text,',' ORDER BY a.point_content_signature COLLATE "C",a.result_attempt_id) AS points
    FROM progressive_worker_evidence_attempts a WHERE a.sim_job_id=r.sim_job_id AND a.sequence=r.sequence) links ON true`;
function startScan(m: Mirror, diagnostics: TerminalDiagnostics) {
  return {
    promiseId: m.id,
    final: m.finalSignature,
    signature: m.signature,
    stopSignature: m.stopSignature,
    engineJobId: m.engineJobId,
    intentToken: m.intentToken,
    diagnostics,
    after: 0,
    anchors: new Map<string, { sequence: number; points: boolean }>(),
    required: new Set<string>(),
    verified: new Set<string>(),
    hash: createHash("sha256"),
    proof: null as string | null,
  };
}
type Scan = ReturnType<typeof startScan>;
const scans = new WeakMap<DB, Scan>();
const namedScans = new WeakMap<DB, Map<string, Scan>>();
const pending = new WeakSet<DB>();
function isUnstartedReport(
  value: unknown,
  signature: unknown,
  sequence: number,
  m: Mirror,
) {
  if (!value) return false;
  try {
    const { report, contentSignature } = validateProgressiveRemoteReport(
      value,
      m.envelope,
    );
    return (
      contentSignature === signature &&
      report.sequence === sequence &&
      report.result === null &&
      report.status.completed_cases === 0 &&
      report.status.started_at == null &&
      !report.status.active_pids?.length &&
      !report.status.active_solver &&
      !report.status.solver_budget_progress?.cases.length &&
      (report.stopProof === null ||
        report.stopProof.ownership_basis === "never_started_cancellation_fence")
    );
  } catch {
    return false;
  }
}
async function evidenceProof(
  db: DB,
  m: Mirror,
  scan: Scan,
  pageLimit: number,
  deadline = Infinity,
) {
  if (scan.proof) return scan.proof;
  const { anchors, required, verified, hash } = scan;
  const unstartedReport =
    m.engineJobId === null
      ? sql`CASE WHEN p.archive_bundle_id IS NULL AND p.result_payload_hash IS NULL
        AND p.report->'result'='null'::jsonb THEN p.report END`
      : sql`NULL::jsonb`;
  for (let page = 0; scan.after < m.sequence && page < pageLimit; page++) {
    if (Date.now() >= deadline) return "checking";
    const rows = await db.execute(sql`WITH page AS MATERIALIZED (
      SELECT r.sim_job_id,r.sequence,r.report,r.content_signature,r.assignment_signature,r.archive_bundle_id,r.result_payload_hash,
        e.content_signature AS staged_signature,links.points IS NOT NULL AS point_anchor,encode(${reportStamp},'hex') AS stamp
      FROM progressive_worker_reports r ${stagingReceipt}
      WHERE r.sim_job_id=${m.execution}::uuid AND r.sequence>${scan.after} AND r.sequence<=${m.sequence}
      ORDER BY r.sequence LIMIT ${pageRows}),
    originals AS MATERIALIZED (
      SELECT p.sequence,p.content_signature,p.assignment_signature,p.staged_signature,p.stamp,p.archive_bundle_id,p.result_payload_hash,
        p.point_anchor,${unstartedReport} AS unstarted_report,
        CASE WHEN p.archive_bundle_id IS NULL AND p.result_payload_hash IS NULL THEN p.report->'result' END AS result FROM page p),
    bytes AS MATERIALIZED (
      SELECT sequence,content_signature,assignment_signature,staged_signature,stamp,archive_bundle_id,result_payload_hash,point_anchor,unstarted_report,
        jsonb_typeof(result) AS kind,
        CASE WHEN jsonb_typeof(result)='object' THEN convert_to(result::text,'UTF8') END AS body
      FROM originals)
    SELECT b.sequence,b.stamp,b.content_signature,b.unstarted_report,b.assignment_signature=${m.signature} AS owned,
      b.staged_signature=b.content_signature AS staged,b.staged_signature IS NOT NULL AS receipt,
      b.kind,b.point_anchor,b.archive_bundle_id IS NOT NULL AS archived,b.result_payload_hash IS NOT NULL AS shared,
      coalesce(payload.content_hash,encode(sha256(b.body),'hex')) AS sha,
      coalesce(payload.byte_size,octet_length(b.body)) AS bytes
    FROM bytes b LEFT JOIN progressive_report_result_payloads payload ON payload.content_hash=b.result_payload_hash
    ORDER BY b.sequence`);
    if (!rows.length) return null;
    for (const r of rows) {
      if (
        Number(r.sequence) !== scan.after + 1 ||
        r.owned !== true ||
        (r.receipt === true && r.staged !== true)
      )
        return null;
      scan.after = Number(r.sequence);
      hash.update(Buffer.from(String(r.stamp), "hex"));
      if (
        m.engineJobId === null &&
        !isUnstartedReport(
          r.unstarted_report,
          r.content_signature,
          scan.after,
          m,
        )
      )
        return null;
      // A compact cold header alone cannot attest to its original point set.
      if (r.archived === true) return null;
      if (r.kind === "null" && r.shared !== true) continue;
      if (!r.sha || r.bytes == null) return null;
      const key = `${r.sha}:${r.bytes}`;
      required.add(key);
      if (
        r.staged === true &&
        (!anchors.has(key) ||
          (!anchors.get(key)!.points && r.point_anchor === true))
      ) {
        anchors.set(key, {
          sequence: scan.after,
          points: r.point_anchor === true,
        });
      }
    }
  }
  if (scan.after < m.sequence) return "checking";
  let checked = 0;
  for (const key of required) {
    if (verified.has(key)) continue;
    if (Date.now() >= deadline) return "checking";
    if (checked >= pageLimit) return "checking";
    const anchor = anchors.get(key);
    if (!anchor) return null;
    const [original] =
      await db.execute(sql`SELECT CASE WHEN r.result_payload_hash IS NULL THEN (r.report->'result')::text ELSE payload.result::text END AS body
      FROM progressive_worker_reports r LEFT JOIN progressive_report_result_payloads payload ON payload.content_hash=r.result_payload_hash
      WHERE r.sim_job_id=${m.execution}::uuid AND r.sequence=${anchor.sequence} AND r.assignment_signature=${m.signature} AND r.archive_bundle_id IS NULL`);
    if (
      typeof original?.body !== "string" ||
      createHash("sha256").update(original.body).digest("hex") +
        ":" +
        Buffer.byteLength(original.body) !==
        key
    )
      return null;
    const points = progressiveReportedPointSources(JSON.parse(original.body))
      .map((p) => p.contentSignature)
      .sort();
    const associations =
      await db.execute(sql`SELECT point_content_signature FROM progressive_worker_evidence_attempts
      WHERE sim_job_id=${m.execution}::uuid AND sequence=${anchor.sequence} ORDER BY point_content_signature COLLATE "C",result_attempt_id`);
    if (
      associations.length !== points.length ||
      associations.some((a, i) => a.point_content_signature !== points[i])
    )
      return null;
    verified.add(key);
    checked++;
  }
  scan.proof = hash.digest("hex");
  return scan.proof;
}

const binding = (
  m: Mirror,
) => sql`p.id=${m.id}::uuid AND j.id=${m.execution}::uuid AND solver.id=${m.solver}::uuid
  AND cfg.upstream_base_url=${m.url} AND cfg.remote_solver_auth_token=${m.token}
  AND ${assignment}=${m.signature} AND i.token IS NOT DISTINCT FROM ${m.intentToken}::uuid
  AND j.engine_job_id IS NOT DISTINCT FROM ${m.engineJobId}::text
  AND stop.sequence=${m.sequence} AND stop.content_signature=${m.finalSignature}
  AND j.request_payload->'remoteProgressiveExecution'=${JSON.stringify(m.envelope)}::jsonb
  AND j.status=${m.status} AND j.engine_state=${m.engine}`;

async function reconcileTerminalMirror(
  db: DB,
  options: {
    promiseId?: string;
    preview?: boolean;
    waitForCapacity?: boolean;
    fetcher?: typeof fetch;
    bounded?: boolean;
  } = {},
) {
  if (configuredDeploymentRole() !== "remote-solver")
    return { outcome: "inactive-role" } as const;
  if (options.promiseId !== undefined && !uuid.test(options.promiseId))
    throw new Error("Invalid progressive promise ID");
  // The existing single-flight transfer pass advances a bounded page budget.
  // An explicit execution of the same operation can finish one named promise.
  const named = options.bounded && options.promiseId ? options.promiseId : null;
  const cache = namedScans.get(db) ?? new Map<string, Scan>();
  const previous = named
    ? cache.get(named)
    : options.promiseId
      ? undefined
      : scans.get(db);
  if (previous && !named) scans.delete(db);
  const deadline = options.bounded ? Date.now() + 15_000 : Infinity;
  const m = await candidate(db, options.promiseId ?? previous?.promiseId);
  if (!m) {
    if (named) cache.delete(named);
    return { outcome: "no-candidate" } as const;
  }
  const identity = {
    promiseId: m.id,
    executionId: m.execution,
    sequence: m.sequence,
  };
  const transport = options.fetcher ?? fetch;
  const signal = options.bounded ? AbortSignal.timeout(15_000) : null;
  const fetcher: typeof fetch = signal
    ? (url, init) =>
        transport(url, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        })
    : transport;
  const resume =
    previous?.final === m.finalSignature &&
    previous.signature === m.signature &&
    previous.stopSignature === m.stopSignature &&
    previous.engineJobId === m.engineJobId &&
    previous.intentToken === m.intentToken;
  // An automatic pass probes the owner before starting a historical scan. A
  // specifically named operation always fetches the owner immediately after
  // the proof and before the write, without duplicating the initial GET.
  if (!resume && (!options.promiseId || options.bounded)) {
    const now = Date.now();
    const recent = nextInspection.get(db) ?? new Map<string, number>();
    for (const [key, until] of recent) if (until <= now) recent.delete(key);
    if (recent.has(m.id))
      return { ...identity, outcome: "recently-inspected" } as const;
    recent.set(m.id, now + 60_000);
    nextInspection.set(db, recent);
    const remote = await cancelledAtHub(m, fetcher);
    if (!remote.confirmed)
      return {
        ...identity,
        outcome: "no-terminal-proof",
        httpStatus: remote.httpStatus,
      } as const;
  }
  const diagnostics = resume
    ? previous.diagnostics
    : await readTerminalDiagnostics(db, m.execution, m.envelope);
  const obligations = settled(diagnostics);
  const [ready] = await db.execute(
    sql`SELECT 1 ${owner} WHERE ${binding(m)} AND ${terminal} AND ${obligations}`,
  );
  if (!ready) return { ...identity, outcome: "unsettled" } as const;
  const scan = resume ? previous : startScan(m, diagnostics);
  if (named) {
    if (!cache.has(named) && cache.size >= 64)
      cache.delete(cache.keys().next().value!);
    cache.set(named, scan);
    namedScans.set(db, cache);
  }
  const proof = await evidenceProof(
    db,
    m,
    scan,
    options.promiseId && !options.bounded ? Infinity : 2,
    deadline,
  );
  if (proof === "checking") {
    if (!named) scans.set(db, scan);
    return { ...identity, outcome: "checking" } as const;
  }
  if (!proof) {
    if (named) cache.delete(named);
    return { ...identity, outcome: "unsettled-reports" } as const;
  }
  let remote = await cancelledAtHub(m, fetcher, diagnostics.signature);
  // Under hub admission pressure, retain the in-memory proof during a
  // bounded named operation. Re-read the hub and rebind every local row
  // before writing. Normal transfer passes keep their short polling budget.
  for (
    let retry = 0;
    options.promiseId &&
    options.waitForCapacity &&
    !options.bounded &&
    remote.httpStatus === 503 &&
    retry < 2;
    retry++
  ) {
    const wait = Math.max(10_000, remote.retryMs ?? 0);
    if (wait > 30_000) break;
    await delay(wait);
    remote = await cancelledAtHub(m, fetcher, diagnostics.signature);
  }
  if (!remote.confirmed)
    return {
      ...identity,
      outcome: "no-terminal-proof",
      httpStatus: remote.httpStatus,
      provedResults: scan.verified.size,
    } as const;
  const evidence = {
    reports: scan.after,
    distinctResults: scan.required.size,
    provedResults: scan.verified.size,
    reportBinding: proof,
    ...(diagnostics.signature
      ? {
          diagnosticReceipts: diagnostics.pins.length,
          diagnosticReceiptSetSignature: diagnostics.signature,
        }
      : {}),
  };
  const qualified = sql`SELECT p.id ${owner} WHERE ${binding(m)} AND ${terminal} AND ${obligations}
    AND (SELECT encode(sha256(string_agg(${reportStamp},''::bytea ORDER BY r.sequence)),'hex')
      FROM progressive_worker_reports r ${stagingReceipt} WHERE r.sim_job_id=j.id)=${proof}`;
  if (options.preview) {
    const [valid] = await db.execute(qualified);
    return {
      ...identity,
      ...evidence,
      outcome: valid ? "eligible" : "changed",
    };
  }
  const outcome = await db.transaction(async (tx) => {
    const [locked] =
      await tx.execute(sql`SELECT p.id FROM sync_sweep_promises p JOIN sim_jobs j ON j.id=${m.execution}::uuid
      JOIN sync_api_settings cfg ON cfg.id=1 AND cfg.remote_solver_registered_id=p.registered_solver_id
      JOIN registered_remote_solvers solver ON solver.id=cfg.remote_solver_registered_id AND solver.instance_id=cfg.instance_id::text
      WHERE p.id=${m.id}::uuid AND p.status='active' AND solver.id=${m.solver}::uuid AND cfg.remote_solver_auth_token=${m.token}
        AND j.request_payload->>'syncPromiseId'=p.id::text
      FOR UPDATE OF p,j SKIP LOCKED FOR SHARE OF cfg,solver SKIP LOCKED`);
    if (!locked) return "changed";
    // A separate READ COMMITTED statement sees children committed while the
    // promise/job locks were being acquired, including new transfer claims.
    const update =
      await tx.execute(sql`UPDATE sync_sweep_promises SET status='cancelled',"cancelledAt"=coalesce("cancelledAt",clock_timestamp()),
      "updatedAt"=clock_timestamp(),response_payload=coalesce(response_payload,'{}'::jsonb)||jsonb_build_object(
        'registeredTerminalMirror',jsonb_build_object('executionId',${m.execution}::text,'solverId',${m.solver}::text,
          'assignmentSignature',${m.signature}::text,'sequence',${m.sequence}::bigint,'reportSignature',${m.finalSignature}::text,
          'engineJobId',${m.engineJobId}::text,'stopProofSignature',${m.stopSignature}::text,
          'diagnosticReceiptSetSignature',${diagnostics.signature}::text))
      WHERE id IN (${qualified}) AND status='active' RETURNING id`);
    if (update.length !== 1) return "changed";
    await tx.execute(sql`UPDATE sync_sweep_promise_points SET status='cancelled',"updatedAt"=clock_timestamp()
      WHERE promise_id=${m.id}::uuid AND status='active'`);
    return "reconciled";
  });
  if (named) cache.delete(named);
  return { ...identity, ...evidence, outcome };
}

export async function reconcileTerminalProgressiveMirror(
  ...args: Parameters<typeof reconcileTerminalMirror>
) {
  const [db] = args;
  if (pending.has(db)) return { outcome: "busy" } as const;
  pending.add(db);
  try {
    return await reconcileTerminalMirror(...args);
  } finally {
    pending.delete(db);
  }
}
