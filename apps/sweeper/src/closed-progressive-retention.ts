import { createHash } from "node:crypto";
import { EngineError } from "@aerodb/engine-client";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  canonicalAnalysisJson,
  registeredWorkerArchiveOwner,
  verifyProgressiveEvidenceCustodyReceipt,
  verifyProgressiveRemoteExecution,
  type DB,
  type ProgressiveEvidenceCustodyReceipt,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import { configuredControlPlaneToken } from "./config";
import {
  openProgressiveArchive,
  preflightProgressiveArchive,
  verifyProgressiveArchiveResponse,
} from "./progressive-archive-reclaim";

type HistoricalReceipt = {
  sim_job_id: string;
  sequence: number;
  point_content_signature: string;
  report_signature: string;
  solver_id: string;
  source_instance_id: string;
  promise_id: string;
  assignment_signature: string;
  stop_signature: string;
  stored_sha256: string;
  stored_bytes: number;
  tar_sha256: string;
  tar_bytes: number;
  manifest_sha256: string;
  manifest_bytes: number;
  manifest_set_sha256: string;
  bundled_file_count: number;
  zstd_level: number;
  bucket: string;
  object_key: string;
  generation: string;
  crc32c: string;
  verified_at: string;
};
export interface ClosedProgressiveManifest {
  directory: string;
  catalogSha256: string;
  manifestSha256: string;
  manifestByteSize: number;
  brokeredUploadId?: string;
  generation: string;
  receiptHmac?: string;
  historicalRaw?: HistoricalReceipt;
  keepMedia?: KeptImage[];
  regime?: "urans";
}

export type ClosedProgressiveNativeOwner = { jobs: [string, string]; job: [string, string]; lock: [string, string] };
export type VerifiedArchiveRestore = {
  manifestSha256: string; memberSetSha256: string; memberCount: number; sample: MediaFile;
};
type AutomaticVerification = {
  state: "awaiting-readback" | "verified"; owner: ClosedProgressiveNativeOwner; restoreSha256: string;
};

export interface ClosedProgressiveReadback {
  restored?: VerifiedArchiveRestore;
  historicalPointSignature?: string;
  verifiedMember?: MediaFile | null;
  brokeredUploadId?: string;
  generation: string;
  storedSha256: string;
  storedByteSize: number;
  verifiedAt: string;
}

type PreservedSolver = { directory: string; treeSha256: string; entries: number; files: number;
  byteSize: number; allocatedBytes: number; sample: MediaFile;
  linkedContinuation?: {jobId: string; caseSlug: string; sharedFiles: number; otherLinks: number; pathSetSha256: string} };

export interface ClosedProgressiveReclaimResponse {
  nativeOwner?: ClosedProgressiveNativeOwner;
  preservedSolver?: PreservedSolver;
  job_id: string;
  state: "absent" | "planned" | "reclaimed";
  replayed?: boolean;
  mediaFiles?: MediaFile[];
  workingPaths?: string[];
  historicalPathsSha256?: string;
  historicalSamples?: Record<string, MediaFile | null>;
  plannedAllocatedBytes?: number;
  allocation?: {
    fileAllocatedBytes: number;
    netAttributedAllocatedBytes?: number;
    filesystemFreeDelta?: number;
  } | null;
  plan: string | null;
  bytes: number;
  files: number;
}

export interface ClosedProgressiveBackend {
  restoreArchive?(job: string, manifest: ClosedProgressiveManifest, remote: ProgressiveEvidenceCustodyReceipt["remote"],
                  body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<VerifiedArchiveRestore>;
  reclaimClosedProgressiveFiles(
    jobId: string,
    manifests: ClosedProgressiveManifest[],
    expectedPlan?: string,
    readbacks?: ClosedProgressiveReadback[],
  ): Promise<ClosedProgressiveReclaimResponse>;
}

type KeptImage = {
  currentImage?: MediaFile & { id: string; attemptId: string; legend: Record<string, unknown> | null };
  regime?: "urans";
  id: string;
  resultId: string;
  attemptId: string;
  slug: string;
  path: string;
  field: string;
  evidenceSha256: string;
  sha256: string;
  byteSize: number;
  rowSha256: string;
  engineUrl: string | null;
  legend: Record<string, unknown> | null;
};
type MediaFile = { path: string; sha256: string; byteSize: number };

function unaccountedMedia(media: readonly KeptImage[]) {
  return media.length
    ? sql`AND m.id NOT IN (${sql.join(
        media.map((m) => sql`${m.id}::uuid`),
        sql`,`,
      )})`
    : sql``;
}

// A named keep-set covers both attempt-owned rows and paths below the job, including rows with broken ownership.
// The ordinary scanner never supplies an exemption.
async function registeredImages(
  db: DB,
  jobId: string,
  lock: boolean,
  checkPriorOwner: boolean,
): Promise<KeptImage[]> {
  const prefix = `jobs/${jobId}/`;
  const owned = sql`(SELECT id FROM result_attempts WHERE sim_job_id=${jobId}::uuid OR engine_job_id=${jobId})`;
  const selected = sql`(m.result_attempt_id IN ${owned} OR m.storage_key LIKE ${prefix + "%"})`;
  if (lock) {
    await db.execute(
      sql`SELECT r.id FROM results r WHERE r.id IN (SELECT result_id FROM result_attempts WHERE id IN ${owned}) ORDER BY r.id FOR UPDATE`,
    );
    await db.execute(
      sql`SELECT a.id FROM result_attempts a WHERE a.id IN ${owned} ORDER BY a.id FOR UPDATE`,
    );
    await db.execute(
      sql`SELECT m.id FROM result_media m WHERE ${selected} ORDER BY m.id FOR SHARE`,
    );
    await db.execute(
      sql`SELECT s.id FROM field_color_scales s WHERE s.id IN (SELECT m.color_scale_id FROM result_media m WHERE ${selected}) ORDER BY s.id FOR SHARE`,
    );
  }
  const rows =
    await db.execute(sql`SELECT m.id,m.result_id AS "resultId",m.result_attempt_id AS "attemptId",f.slug, m.engine_url AS "engineUrl",
    substring(m.storage_key from ${prefix.length + 1}::int) AS path,m.field,m.sha256,m.byte_size::float8 AS "byteSize",m.evidence_sha256 AS "evidenceSha256",
    encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex') AS "rowSha256",
    CASE WHEN s.id IS NOT NULL THEN jsonb_build_object('mode','track','vmin',coalesce(m.scale_vmin,s.vmin),'vmax',coalesce(m.scale_vmax,s.vmax),
      'policy',coalesce(m.scale_policy,s.scale_policy),'version',coalesce(m.color_scale_version,s.version),'status',s.status) END AS legend,
    CASE WHEN shown.id IS NOT NULL THEN jsonb_build_object('id',shown.id,'attemptId',picked.id,
      'path',shown.storage_key,'sha256',shown.sha256,'byteSize',shown.byte_size,
      'legend',CASE WHEN ss.id IS NOT NULL THEN jsonb_build_object('mode','track','vmin',coalesce(shown.scale_vmin,ss.vmin),
        'vmax',coalesce(shown.scale_vmax,ss.vmax),'policy',coalesce(shown.scale_policy,ss.scale_policy),
        'version',coalesce(shown.color_scale_version,ss.version),'status',ss.status) END) END AS current_image,
    a.regime AS source_regime,
    (a.sim_job_id=${jobId}::uuid AND a.engine_job_id=${jobId} AND a.result_id=m.result_id AND a.regime IN ('rans','urans') AND (r.current_result_attempt_id=a.id OR shown.id IS NOT NULL)
     AND m.storage_key LIKE ${prefix + "%"} AND m.kind='image' AND m.role='instantaneous' AND m.mime_type='image/png'
     AND m.sha256~'^[a-f0-9]{64}$' AND m.byte_size>0 AND m.evidence_sha256~'^[a-f0-9]{64}$' AND m.field IS NOT NULL AND f.slug IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM result_media_storage_bindings b WHERE b.result_media_id=m.id)
     AND NOT EXISTS(SELECT 1 FROM result_media_storage_uploads u WHERE u.result_media_id=m.id)) AS ok
    FROM result_media m LEFT JOIN result_attempts a ON a.id=m.result_attempt_id LEFT JOIN results r ON r.id=m.result_id
    LEFT JOIN result_attempts picked ON ${checkPriorOwner}::boolean AND a.regime='urans' AND picked.id=r.current_result_attempt_id
      AND picked.result_id=m.result_id AND picked.airfoil_id=a.airfoil_id AND picked.sim_job_id<>a.sim_job_id
      AND picked.engine_job_id=picked.sim_job_id::text
    LEFT JOIN result_media shown ON shown.result_attempt_id=picked.id AND shown.result_id=picked.result_id AND shown.field=m.field
      AND shown.kind='image' AND shown.role='instantaneous' AND shown.mime_type='image/png' AND shown.byte_size BETWEEN 1 AND 134217728
      AND shown.sha256~'^[a-f0-9]{64}$' AND shown.storage_key LIKE 'jobs/'||picked.engine_job_id||'/%'
    LEFT JOIN field_color_scales ss ON ss.id=shown.color_scale_id
    LEFT JOIN airfoils f ON f.id=a.airfoil_id LEFT JOIN field_color_scales s ON s.id=m.color_scale_id WHERE ${selected} ORDER BY m.id LIMIT 257`);
  if (rows.length > 256) throw Error("The named job exceeds 256 registered instantaneous PNGs");
  if (rows.some((r) => r.ok !== true) || new Set(rows.map((r) => r.id)).size !== rows.length)
    throw Error(
      "Keep-set requires a bounded inventory of exact current-job instantaneous PNG rows",
    );
  return rows.map(({ ok, source_regime, current_image, ...r }) => ({
    ...r, ...(current_image ? { currentImage: current_image } : {}), ...(source_regime === "urans" ? { regime: "urans" } : {}),
  } as unknown as KeptImage));
}

async function assertWorkingPathsUnreferenced(
  db: DB,
  id: string,
  paths: readonly string[],
) {
  if (!paths.length) return;
  if (
    paths.some(
      (p) =>
        !p.startsWith("cases/") ||
        p.split("/").some((s) => !s || s === "." || s === ".."),
    )
  )
    throw Error("Invalid candidate working paths");
  // One snapshot covers the entire signed plan, including a URANS window
  // with thousands of fields. Bind the path list once instead of expanding
  // four independent lists of SQL parameters.
  const keys = sql`(SELECT key FROM planned)`;
  const [row] =
    await db.execute(sql`WITH planned AS MATERIALIZED (
      SELECT ${"jobs/" + id + "/"}::text || path AS key FROM jsonb_array_elements_text(${JSON.stringify(paths)}::jsonb) AS files(path)
    ) SELECT EXISTS (SELECT 1 FROM result_media WHERE storage_key IN ${keys})
    OR EXISTS(SELECT 1 FROM solver_evidence_artifacts WHERE storage_key IN ${keys})
    OR EXISTS(SELECT 1 FROM field_render_cache WHERE storage_key IN ${keys})
    OR EXISTS(SELECT 1 FROM remote_asset_references WHERE local_storage_key IN ${keys} OR cached_storage_key IN ${keys}) AS referenced`);
  if (row?.referenced !== false)
    throw Error(
      "A proposed working file still has a live artifact or media path reference",
    );
}

async function readStoredFile(
  url: URL,
  file: MediaFile,
  signal: AbortSignal,
  mime = "image/png",
) {
  const r = await fetch(url, {
    signal,
    redirect: "error",
    headers: { accept: mime || "*/*", "accept-encoding": "identity" },
  });
  if (
    !r.ok ||
    !r.body ||
    (mime && r.headers.get("content-type")?.split(";")[0] !== mime) ||
    r.headers.get("content-length") !== String(file.byteSize)
  ) {
    await r.body?.cancel();
    throw Error("File route did not return its stored identity");
  }
  let length = 0;
  const hash = createHash("sha256");
  for await (const bytes of r.body as unknown as AsyncIterable<Uint8Array>) {
    length += bytes.length;
    if (length > file.byteSize) throw Error("File exceeded its stored size");
    hash.update(bytes);
  }
  if (length !== file.byteSize || hash.digest("hex") !== file.sha256)
    throw Error("File route returned different bytes");
}

type DisplayedImages = Record<string, { kind?: string; url?: string; imageUrl?: string; scale?: unknown }>;

async function readImageDetail(api: string, m: KeptImage, signal: AbortSignal, priorAttempt = false) {
  const url = new URL(`/api/airfoils/${encodeURIComponent(m.slug)}/sim`, api);
  url.searchParams.set("resultId", m.resultId);
  if (priorAttempt) url.searchParams.set("resultAttemptId", m.attemptId);
  const r = await fetch(url, { signal, redirect: "error" });
  if (!r.ok && !(priorAttempt && r.status === 404)) {
    await r.body?.cancel();
    throw Error("Stored point detail is unavailable");
  }
  if (!r.body) throw Error("Stored point detail has no body");
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of r.body as unknown as AsyncIterable<Uint8Array>) {
    size += part.length;
    if (size > 2 * 1024 ** 2) throw Error("Stored point detail exceeded the media-proof byte bound");
    parts.push(part);
  }
  const detail = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
    resultId?: string; media?: DisplayedImages; error?: string;
  };
  if (priorAttempt && r.status === 404 && detail.error === "no solved OpenFOAM result for this point")
    return null;
  if (!r.ok || detail.resultId !== m.resultId || !detail.media) throw Error("Stored point detail changed owner or lost media");
  return detail.media;
}

function checkDisplayedImage(shown: DisplayedImages, field: string, id: string, legend: KeptImage["legend"]) {
  const entry = shown[field];
  const stable = `/api/result-media/${id}`;
  if (!entry || entry.kind !== "image" || (entry.url !== stable && entry.imageUrl !== stable) ||
      canonicalAnalysisJson(entry.scale ?? null) !== canonicalAnalysisJson(legend))
    throw Error("Displayed media link or color legend changed");
}

async function readKeptMedia(
  id: string,
  media: KeptImage[],
  plan: ClosedProgressiveReclaimResponse,
  signal: AbortSignal,
  historical = false,
) {
  if (
    !Array.isArray(plan.mediaFiles) ||
    plan.mediaFiles.length > 512 ||
    (historical
      ? !/^[a-f0-9]{64}$/.test(plan.historicalPathsSha256 ?? "")
      : !Array.isArray(plan.workingPaths) ||
        plan.workingPaths.length !== plan.files)
  )
    throw Error(
      "Native peer omitted the protected image or working-file inventory",
    );
  const expectedPaths = new Set<string>();
  const uransFields = new Set<string>();
  for (const row of media) {
    const suffix = "/evidence/scaled_media/";
    const prefixLength = row.path.lastIndexOf(suffix);
    const nativeSuffix = "/images/" + row.field + ".png";
    const base = prefixLength >= 0 ? row.path.slice(0, prefixLength) :
      row.regime === "urans" && row.path.endsWith(nativeSuffix) ? row.path.slice(0, -nativeSuffix.length) : null;
    if (!base) throw Error("Registered image is outside its signed point media directories");
    const native = base + nativeSuffix;
    if (expectedPaths.has(row.path) || expectedPaths.has(native)) throw Error("Overlapping registered point images");
    expectedPaths.add(native);
    expectedPaths.add(row.path);
    if (row.regime === "urans") uransFields.add(base + nativeSuffix);
  }
  for (const file of plan.mediaFiles) {
    const previous = /^(cases\/[^/]+\/[^/]+)\/evidence\/scaled_media\/default_v1_zoom2\/v[0-9]+\/([^/]+\.png)$/.exec(file.path);
    if (previous && uransFields.has(previous[1] + "/images/" + previous[2]))
      expectedPaths.add(file.path);
  }
  if (
    plan.mediaFiles.length !== expectedPaths.size ||
    plan.mediaFiles.some((file) => !expectedPaths.has(file.path)) ||
    (!historical &&
      (new Set(plan.workingPaths).size !== plan.files ||
        plan.workingPaths!.some((path) => expectedPaths.has(path))))
  )
    throw Error(
      "Protected image/working-file inventory is incomplete or overlaps",
    );
  const api = "http://node-api:4000";
  const engine = new URL(process.env.ENGINE_URL ?? "http://api:8000");
  const files = new Map<string, MediaFile>();
  for (const f of plan.mediaFiles) {
    if (
      files.has(f.path) ||
      !f.path.startsWith("cases/") ||
      f.path.split("/").some((s) => !s || s === "." || s === "..") ||
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      !Number.isSafeInteger(f.byteSize) ||
      f.byteSize <= 0
    )
      throw Error("Invalid protected native image identity");
    files.set(f.path, f);
    const path = f.path.split("/").map(encodeURIComponent).join("/");
    await readStoredFile(new URL(`/jobs/${id}/files/${path}`, engine), f, signal);
    await readStoredFile(new URL(`/api/media/jobs/${id}/${path}`, api), f, signal);
  }
  const results = new Map<string, DisplayedImages>();
  const priorDetails = new Map<string, DisplayedImages | null>();
  const priorVisibility: Record<string, boolean> = {};
  if (media.reduce((bytes, row) => bytes + (row.currentImage?.byteSize ?? 0), 0) > 128 * 1024 ** 2)
    throw Error("Current image inventory exceeds the bounded byte budget");
  for (const m of media) {
    const file = files.get(m.path);
    if (!file || m.sha256 !== file.sha256 || m.byteSize !== file.byteSize)
      throw Error("Database and native image inventories differ");
    if (m.engineUrl) {
      const expected = new URL(
        `/jobs/${id}/files/${m.path.split("/").map(encodeURIComponent).join("/")}`,
        engine,
      );
      if (new URL(m.engineUrl).href !== expected.href)
        throw Error(
          "Stored engine media URL differs from the verified file path",
        );
    }
    const stable = `/api/result-media/${m.id}`;
    await readStoredFile(new URL(stable, api), file, signal);
    let displayed = results.get(m.resultId);
    if (!displayed) {
      const current = await readImageDetail(api, m, signal);
      if (!current) throw Error("Stored point detail is unavailable");
      displayed = current;
      results.set(m.resultId, current);
    }
    const selected = m.currentImage ?? m;
    checkDisplayedImage(displayed, m.field, selected.id, selected.legend);
    if (m.currentImage) {
      await readStoredFile(new URL(`/api/result-media/${m.currentImage.id}`, api), m.currentImage, signal);
      // Pin the old attempt's actual visibility even when the public campaign
      // no longer selects it. Its own stable image must always return exact bytes.
      if (!priorDetails.has(m.attemptId)) {
        const prior = await readImageDetail(api, m, signal, true);
        priorDetails.set(m.attemptId, prior);
        priorVisibility[m.attemptId] = prior !== null;
      }
      const prior = priorDetails.get(m.attemptId);
      if (prior) checkDisplayedImage(prior, m.field, m.id, m.legend);
    }
  }
  return createHash("sha256")
    .update(canonicalAnalysisJson({ media, files: plan.mediaFiles, ...(priorDetails.size ? { priorVisibility } : {}) }))
    .digest("hex");
}

async function assertClosedContinuation(db: DB, parent: string, directory: string, selection: string, lock: boolean) {
  const [child, destination, ...extra] = selection.split("/");
  if (!child || child === parent || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(child) ||
      !destination || !/^[a-zA-Z0-9_.-]+$/.test(destination) || [".",".."].includes(destination) || extra.length)
    throw Error("Invalid retained continuation owner");
  const caseSlug = directory.split("/")[1]!;
  const rows = await db.execute(sql`SELECT c.id FROM sim_jobs c JOIN sim_jobs source ON source.id=${parent}::uuid
    JOIN sync_sweep_promises p ON p.id::text=c.request_payload->>'syncPromiseId'
    JOIN sync_api_settings s ON s.id=1 AND p.registered_solver_id=s.remote_solver_registered_id AND p.source_base_url=s.upstream_base_url
    WHERE c.id=${child}::uuid AND c.engine_job_id=c.id::text AND c.status IN ('cancelled','failed','done')
      AND c.engine_state IN ('cancelled','failed','completed') AND (c.ingest_lease_token IS NULL OR c.ingest_lease_expires_at<=clock_timestamp())
      AND c.airfoil_id=source.airfoil_id AND c.simulation_preset_revision_id=source.simulation_preset_revision_id
      AND c.request_payload->>'upstreamBaseUrl'=s.upstream_base_url AND p.status IN ('cancelled','expired')
      AND c.request_payload#>>'{engineRequest,continue_from,engine_job_id}'=${parent}
      AND c.request_payload#>>'{engineRequest,continue_from,case_slug}'=${caseSlug}
      AND NOT EXISTS (SELECT FROM progressive_cfd_attempts a WHERE a.sim_job_id=c.id AND a.outcome='running')
      AND NOT EXISTS (SELECT FROM sim_jobs next WHERE next.status IN ('pending','submitted','running','ingesting')
        AND(next.parent_job_id=c.id OR next.request_payload#>>'{engineRequest,continue_from,engine_job_id}'=c.engine_job_id))
      ${lock ? sql`FOR SHARE OF c SKIP LOCKED` : sql``}`);
  if (rows.length !== 1) throw Error("The named linked continuation is busy or does not own this exact saved case");
}

async function checkPreservedSolver(id: string, directory: string, plan: ClosedProgressiveReclaimResponse, signal: AbortSignal) {
  const kept = plan.preservedSolver;
  const sample = kept?.sample;
  if (!kept || kept.directory !== directory || !/^[a-f0-9]{64}$/.test(kept.treeSha256) ||
      ![kept.entries, kept.files, kept.byteSize, kept.allocatedBytes].every(n => Number.isSafeInteger(n) && n >= 0) ||
      !kept.files || kept.entries < kept.files || !sample || !sample.path.startsWith(directory + "/") ||
      sample.path.split("/").some(c => !c || c === "." || c === "..") || !/\/postProcessing\/.*\/(?:coefficient|forceCoeffs)\.dat$/.test(sample.path) ||
      !Number.isSafeInteger(sample.byteSize) || sample.byteSize <= 0 || sample.byteSize > kept.byteSize ||
      !/^[a-f0-9]{64}$/.test(sample.sha256) || !Array.isArray(plan.workingPaths) ||
      plan.workingPaths.some(p => p === directory || p.startsWith(directory + "/")))
    throw Error("Unreported solver or signed sibling path inventory differs");
  const path = sample.path.split("/").map(encodeURIComponent).join("/");
  const engine = process.env.ENGINE_URL ?? "http://api:8000";
  await readStoredFile(new URL(`/jobs/${id}/files/${path}`, engine), sample, signal, "");
  await readStoredFile(new URL(`/api/media/jobs/${id}/${path}`, "http://node-api:4000"), sample, signal, "");
}

type RegisteredStop = {
  baseUrl: string; solverId: string; promiseId: string; executionId: string;
  assignmentSignature: string; localEnvelopeSha256: string; stoppedReportSignature: string; receivedSequence: number;
  promiseState: "cancelled" | "expired"; jobState: string; engineState: string;
};

/** A stopped worker need not receive another assignment poll after its hub cancels the promise. */
function terminalPromiseSha256(stop: RegisteredStop | undefined) {
  return stop ? createHash("sha256").update(canonicalAnalysisJson(stop)).digest("hex") : null;
}

async function registeredTerminalPromise(db: DB, id: string, signal?: AbortSignal, pin = false): Promise<RegisteredStop | undefined> {
  const [mirror] = await db.execute(sql`SELECT p.status,s.remote_solver_transfer_paused AS paused FROM sim_jobs j
    JOIN sync_sweep_promises p ON p.id::text=j.request_payload->>'syncPromiseId'
    JOIN sync_api_settings s ON s.id=1 AND p.registered_solver_id=s.remote_solver_registered_id AND p.source_base_url=s.upstream_base_url
    WHERE j.id=${id}::uuid AND j.engine_job_id=${id} AND j.status='cancelled'`);
  if (!pin && mirror?.status !== "active") return undefined;
  if (!mirror || mirror.paused !== false || !["active","cancelled","expired"].includes(String(mirror.status)))
    throw Error("Job has active ownership or registered transfer is paused");
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver") throw Error("Job has active ownership");
  const { baseUrl, authToken, envelope } = await registeredWorkerArchiveOwner(db, id);
  const [stop] = await db.execute(sql`SELECT r.sequence,r.content_signature,r.assignment_signature,r.acknowledged_at,r.stopped_engine_job_id,
    encode(sha256(convert_to((j.request_payload->'remoteProgressiveExecution')::text,'UTF8')),'hex') AS local_envelope_sha
    FROM progressive_worker_reports r JOIN sim_jobs j ON j.id=r.sim_job_id AND j.request_payload->'remoteProgressiveExecution'=${JSON.stringify(envelope)}::jsonb
    WHERE r.sim_job_id=${id}::uuid ORDER BY r.sequence DESC LIMIT 1`);
  const sequence = Number(stop?.sequence);
  if (stop?.stopped_engine_job_id !== id || !stop.acknowledged_at || stop.assignment_signature !== envelope.contentSignature ||
      typeof stop.local_envelope_sha !== "string" || !/^[a-f0-9]{64}$/.test(stop.local_envelope_sha) ||
      typeof stop.content_signature !== "string" || !/^[a-f0-9]{64}$/.test(stop.content_signature) ||
      !Number.isSafeInteger(sequence) || sequence < 1)
    throw Error("Job has active ownership or lacks an exact acknowledged stop");
  const { readRegisteredArchive } = await import("@aerodb/core/registered-archive-read");
  const r = await readRegisteredArchive(`${baseUrl}/progressive-executions/${id}`, authToken,
    signal ?? AbortSignal.timeout(30_000), "application/json");
  if (r.status !== 200 || !r.body || r.headers.get("content-type")?.split(";")[0] !== "application/json") {
    await r.body?.cancel();
    throw Error(`Registered assignment read refused (HTTP ${r.status})`);
  }
  const declared = r.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > 1024 ** 2)) {
    await r.body.cancel();
    throw Error("Registered assignment exceeds the owner proof bound");
  }
  let length = 0;
  const bytes: Buffer[] = [];
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    length += chunk.length;
    if (length > 1024 ** 2) throw Error("Registered assignment exceeds the owner proof bound");
    bytes.push(Buffer.from(chunk));
  }
  if (declared !== null && Number(declared) !== length) throw Error("Incomplete registered assignment");
  const observed = JSON.parse(Buffer.concat(bytes).toString("utf8")) as {
    assignment?: { envelope?: unknown; executionStopped?: boolean; receivedSequence?: number;
      promise?: { id?: string; status?: string }; job?: { status?: string; engineState?: string } };
    continuation?: { kind?: string };
  };
  const a = observed?.assignment;
  verifyProgressiveRemoteExecution(a?.envelope, {
    solverId: envelope.solverId, promiseId: envelope.promiseId, executionId: id, contentSignature: envelope.contentSignature,
  });
  if (!a || a.promise?.id !== envelope.promiseId || a.executionStopped !== true || a.receivedSequence !== sequence ||
      observed.continuation?.kind !== "stop" || (a.promise.status !== "cancelled" && a.promise.status !== "expired") ||
      !a.job?.status || !["cancelled", "done", "failed"].includes(a.job.status) ||
      !a.job.engineState || !["cancelled", "completed", "failed"].includes(a.job.engineState))
    throw Error("Registered hub has active ownership or lacks the matching terminal job, promise and report");
  return { baseUrl, solverId: envelope.solverId, promiseId: envelope.promiseId, executionId: id,
    assignmentSignature: envelope.contentSignature, localEnvelopeSha256: stop.local_envelope_sha, stoppedReportSignature: stop.content_signature, receivedSequence: sequence,
    promiseState: a.promise.status, jobState: a.job.status, engineState: a.job.engineState };
}

const LIVE = sql`('pending','submitted','running','ingesting')`;
function eligible(
  now: Date,
  ageMs: number,
  completedPlan?: string,
  media: KeptImage[] = [],
  historical = false,
  preserveSolver?: string,
  hubStop?: RegisteredStop,
  verifyingApplied = false,
) {
  const receiptKey = preserveSolver ? "closedProgressiveSiblingFiles" : historical
    ? "historicalRawFiles"
    : "closedProgressiveFiles";
  const saved = sql`j.strip_report->${receiptKey}::text`;
  return sql`j.status IN ('done','failed','cancelled') AND j.engine_job_id=j.id::text
    AND j.request_payload ? 'remoteProgressiveExecution'
    ${preserveSolver ? sql`AND j.status='cancelled' AND (j.strip_report->'closedProgressiveFiles'->>'complete') IS DISTINCT FROM 'true'
      AND EXISTS(SELECT FROM sync_sweep_promises p JOIN sync_api_settings s ON s.id=1
        WHERE p.id::text=j.request_payload->>'syncPromiseId' AND p.registered_solver_id=s.remote_solver_registered_id
          AND p.source_base_url=s.upstream_base_url AND NOT s.remote_solver_transfer_paused
          AND (p.status IN ('cancelled','expired') ${hubStop ? sql`OR (p.status='active' AND j.id=${hubStop.executionId}::uuid
            AND p.id=${hubStop.promiseId}::uuid AND p.registered_solver_id=${hubStop.solverId}::uuid AND p.source_base_url=${hubStop.baseUrl}
            AND j.request_payload#>>'{remoteProgressiveExecution,contentSignature}'=${hubStop.assignmentSignature}
            AND encode(sha256(convert_to((j.request_payload->'remoteProgressiveExecution')::text,'UTF8')),'hex')=${hubStop.localEnvelopeSha256}
            AND EXISTS(SELECT FROM progressive_worker_reports r WHERE r.sim_job_id=j.id AND r.sequence=${hubStop.receivedSequence}
              AND r.content_signature=${hubStop.stoppedReportSignature} AND r.assignment_signature=${hubStop.assignmentSignature}
              AND r.stopped_engine_job_id=j.engine_job_id AND r.acknowledged_at IS NOT NULL
              AND NOT EXISTS(SELECT FROM progressive_worker_reports later WHERE later.sim_job_id=j.id AND later.sequence>r.sequence)))` : sql``}))` : sql``}
    AND ${
      historical
        ? sql`j.status='cancelled' AND j."ingestedAt" IS NOT NULL
      AND EXISTS(SELECT FROM sync_sweep_promises hp JOIN sync_api_settings hs ON hs.id=1
        WHERE hp.id::text=j.request_payload->>'syncPromiseId' AND hp.registered_solver_id=hs.remote_solver_registered_id
          AND hp.source_base_url=hs.upstream_base_url AND hp.status IN ('expired','cancelled') AND NOT hs.remote_solver_transfer_paused)
      AND NOT EXISTS(SELECT FROM progressive_worker_evidence_delivery_claims hc WHERE hc.sim_job_id=j.id AND hc.claim_expires_at>now())`
        : sql`j.stripped_at IS NULL`
    }
    AND ${
      completedPlan === undefined
        ? sql`(${saved})->>'complete' IS DISTINCT FROM 'true' AND (${saved})#>>'{automaticVerification,state}' IS DISTINCT FROM 'awaiting-readback'`
        : sql`((${saved})->>'complete'='true' OR (${verifyingApplied} AND (${saved})#>>'{automaticVerification,state}'='awaiting-readback')) AND (${saved})->>'planSha256'=${completedPlan}`
    }
    AND coalesce(((${saved})->>'retryAfter')::timestamptz,'-infinity') <= clock_timestamp()
    AND coalesce(j."finishedAt",j."ingestedAt",j."updatedAt",j."createdAt")<=${now.toISOString()}::timestamptz-(${ageMs}::float8*interval '1ms')
    AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM sim_jobs child WHERE child.status IN ${LIVE} AND
      (child.parent_job_id=j.id OR child.request_payload#>>'{engineRequest,continue_from,engine_job_id}'=j.engine_job_id))
    AND NOT EXISTS(SELECT 1 FROM progressive_cfd_attempts ca WHERE ca.sim_job_id=j.id AND ca.outcome='running')
    AND NOT EXISTS(SELECT 1 FROM progressive_worker_reports wr WHERE wr.sim_job_id=j.id AND wr.acknowledged_at IS NULL)
    AND EXISTS(SELECT 1 FROM progressive_worker_reports wr WHERE wr.sim_job_id=j.id AND wr.stopped_engine_job_id=j.engine_job_id)
    AND NOT EXISTS(SELECT 1 FROM sim_urans_requests u JOIN results r ON r.id=u.continue_from_result_id
      WHERE u.state IN ${LIVE} AND r.sim_job_id=j.id)
    AND NOT EXISTS(SELECT 1 FROM sim_precalc_obligation_attempts o JOIN sim_precalc_obligations p ON p.id=o.obligation_id
      JOIN result_attempts a ON a.id=o.result_attempt_id WHERE a.sim_job_id=j.id AND p.state IN ('pending','running'))
    AND NOT EXISTS(SELECT 1 FROM sim_urans_verify_queue v JOIN result_attempts a ON a.id=v.latest_result_attempt_id
      WHERE a.sim_job_id=j.id AND v.state IN ('pending','running') AND v.last_outcome IN ('continuation_pending','continuation_retry_wait'))
    AND ${historical ? sql`EXISTS(SELECT FROM progressive_worker_evidence_attempts a WHERE a.sim_job_id=j.id)` : sql`EXISTS(SELECT 1 FROM progressive_worker_archive_receipts ar WHERE ar.sim_job_id=j.id)`}
    AND NOT EXISTS(SELECT 1 FROM progressive_worker_archive_receipts ar
      LEFT JOIN progressive_worker_hub_receipts h USING(sim_job_id,point_content_signature)
      LEFT JOIN progressive_worker_archive_reclaims r USING(sim_job_id,point_content_signature)
      WHERE ar.sim_job_id=j.id AND (h.sim_job_id IS NULL OR r.completed_at IS NULL))
    AND NOT EXISTS(SELECT 1 FROM result_attempts a JOIN result_media m ON m.result_attempt_id=a.id
      LEFT JOIN result_media_storage_bindings b ON b.result_media_id=m.id
      LEFT JOIN result_media_blobs blob ON blob.id=b.blob_id AND blob.backend='gcs' AND blob."verifiedAt" IS NOT NULL
       AND b.local_storage_key=m.storage_key AND blob.sha256=m.sha256 AND blob.byte_size=m.byte_size AND blob.mime_type=m.mime_type
      WHERE (a.sim_job_id=j.id OR a.engine_job_id=j.engine_job_id) AND blob.id IS NULL ${unaccountedMedia(media)})`;
}

type ScientificPoint = {
  attemptId: string;
  resultId: string | null;
  canonicalAttemptId: string | null;
  canonicalResultId: string | null;
  pointSignature: string;
  payloadSha256: string;
  aoa: string | null;
  cl: string | null;
  cd: string | null;
  cm: string | null;
  status: string | null;
  regime: string | null;
};
type Archive = {
  point: ScientificPoint;
  manifest: ClosedProgressiveManifest;
  remote: ProgressiveEvidenceCustodyReceipt["remote"];
};
async function historicalCustody(db: DB, id: string, signal?: AbortSignal) {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver")
    throw Error("Historical reclaim requires the registered source worker");
  const { baseUrl, authToken, envelope } = await registeredWorkerArchiveOwner(
    db,
    id,
  );
  const { readRegisteredArchive } = await import("@aerodb/core/registered-archive-read");
  const res = await readRegisteredArchive(
    baseUrl +
      "/progressive-executions/" +
      id +
      "/historical-raw-archives/receipts",
    authToken,
    signal ?? AbortSignal.timeout(60_000),
    "application/json",
  );
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw Error(
      "Registered hub historical receipts unavailable (" + res.status + ")",
    );
  }
  let size = 0;
  const parts: Buffer[] = [];
  for await (const raw of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += raw.length;
    if (size > 512 * 1024) throw Error("Oversized receipt inventory");
    parts.push(Buffer.from(raw));
  }
  const rows = JSON.parse(Buffer.concat(parts).toString("utf8"))
    .receipts as HistoricalReceipt[];
  if (!Array.isArray(rows) || !rows.length || rows.length > 256)
    throw Error("No complete historical custody");
  const byPoint = new Map<string, HistoricalReceipt>();
  for (const c of rows) {
    if (
      c.sim_job_id !== id ||
      c.solver_id !== envelope.solverId ||
      c.promise_id !== envelope.promiseId ||
      c.assignment_signature !== envelope.contentSignature ||
      ![
        c.point_content_signature,
        c.report_signature,
        c.stored_sha256,
        c.tar_sha256,
        c.manifest_sha256,
        c.manifest_set_sha256,
        c.stop_signature,
      ].every((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) ||
      ![
        c.sequence,
        c.stored_bytes,
        c.tar_bytes,
        c.manifest_bytes,
        c.bundled_file_count,
        c.zstd_level,
      ].every((v) => Number.isSafeInteger(v) && v > 0) ||
      !/^[1-9][0-9]{0,19}$/.test(c.generation) ||
      BigInt(c.generation) > 18446744073709551615n ||
      !c.bucket ||
      c.object_key !==
        `solver-evidence/v1/sha256/${c.stored_sha256.slice(0, 2)}/${c.stored_sha256}.tar.zst` ||
      byPoint.has(c.point_content_signature)
    )
      throw Error("Historical custody owner or identity conflict");
    byPoint.set(c.point_content_signature, c);
  }
  return byPoint;
}
function pointImages(
  media: KeptImage[],
  attempt: unknown,
  result: unknown,
  regime: unknown,
  directory: string,
  manifestSha: string,
) {
  const kept = media.filter((m) => m.attemptId === attempt);
  if (
    media.length &&
    ((!kept.length && regime !== "urans") ||
      kept.some(
        (m) =>
          m.resultId !== result ||
          m.evidenceSha256 !== manifestSha ||
          !(
            m.path.startsWith(directory + "/scaled_media/") ||
            (regime === "urans" &&
              directory.endsWith("/evidence") &&
              m.path ===
                directory.slice(0, -"/evidence".length) +
                  "/images/" +
                  m.field +
                  ".png")
          ),
      ))
  )
    throw Error("Kept images differ from the exact signed point owner");
  return kept;
}

async function proofs(
  db: DB,
  jobId: string,
  media: KeptImage[] = [],
  historical?: Map<string, HistoricalReceipt>,
  inspectImages = false,
  automatic = false,
) {
  const prefix = `jobs/${jobId}/`;
  const [unprotected] = await db.execute(sql`SELECT EXISTS (
    SELECT 1 FROM result_media m LEFT JOIN result_media_storage_bindings b ON b.result_media_id=m.id AND b.local_storage_key=m.storage_key
    LEFT JOIN result_media_blobs blob ON blob.id=b.blob_id AND blob.backend='gcs' AND blob."verifiedAt" IS NOT NULL
      AND blob.sha256=m.sha256 AND blob.byte_size=m.byte_size AND blob.mime_type=m.mime_type
    WHERE m.storage_key LIKE ${prefix + "%"} AND blob.id IS NULL ${unaccountedMedia(media)}
  ) OR EXISTS(SELECT 1 FROM solver_evidence_incomplete_quarantines WHERE engine_job_id=${jobId})
    OR EXISTS(SELECT 1 FROM solver_evidence_orphan_quarantines WHERE engine_job_id=${jobId}) AS blocked`);
  if (unprotected?.blocked !== false)
    throw new Error("Job has unbound path-owned media or forensic custody");
  const [settings] =
    await db.execute(sql`SELECT s.remote_solver_registered_id AS solver,s.remote_solver_auth_token AS token,
    s.upstream_base_url AS base,p.id AS promise ${historical ? sql`,s.instance_id` : sql``} FROM sync_api_settings s JOIN sim_jobs j ON j.id=${jobId}::uuid
    JOIN sync_sweep_promises p ON p.id::text=j.request_payload->>'syncPromiseId'
    WHERE s.id=1 AND p.source_base_url=s.upstream_base_url AND p.registered_solver_id=s.remote_solver_registered_id
      AND j.request_payload->>'upstreamBaseUrl'=s.upstream_base_url`);
  if (
    !settings?.solver ||
    typeof settings.token !== "string" ||
    !settings.token ||
    typeof settings.base !== "string"
  )
    throw new Error("Closed job has no exact registered hub owner");
  const base = canonicalRemoteHubBaseUrl(settings.base);
  const rows = await db.execute(sql`WITH owner AS MATERIALIZED (
      SELECT id,result_id,sim_job_id,engine_job_id,engine_case_slug,aoa_deg,cl,cd,cm,status,regime,
        encode(sha256(convert_to(evidence_payload::text,'UTF8')),'hex') AS payload_sha FROM result_attempts WHERE sim_job_id=${jobId}::uuid OR engine_job_id=${jobId}
    ), staged AS MATERIALIZED (
      SELECT DISTINCT result_attempt_id,point_content_signature FROM progressive_worker_evidence_attempts WHERE sim_job_id=${jobId}::uuid
    ), pairs AS MATERIALIZED (
      SELECT * FROM staged
      UNION SELECT result_attempt_id,point_content_signature FROM progressive_worker_hub_receipts WHERE sim_job_id=${jobId}::uuid
    ) SELECT a.id,a.result_id,a.engine_case_slug,a.payload_sha,a.aoa_deg::text AS aoa,a.cl::text,a.cd::text,a.cm::text,
      a.status::text,a.regime::text,s.point_content_signature,ar.brokered_upload_id,ar.receipt,h.receipt AS hub,
      catalog.signature AS catalog_sha,b.storage_key,b.metadata,
      ${
        historical
          ? sql`b.sha256 AS archive_sha,b.byte_size AS archive_size,b.mime_type AS archive_mime,b.engine_job_id AS archive_job,
        b.engine_case_slug AS archive_case,b.result_id IS NOT DISTINCT FROM a.result_id AS same_local_result,`
          : sql``
      } mf.storage_key AS manifest_key,mf.sha256 AS manifest_sha,mf.byte_size AS manifest_size,ref.remote_download_url
    FROM owner a FULL JOIN pairs p ON p.result_attempt_id=a.id LEFT JOIN staged s ON s.result_attempt_id=p.result_attempt_id AND s.point_content_signature=p.point_content_signature
    LEFT JOIN progressive_worker_hub_receipts h ON h.sim_job_id=${jobId}::uuid AND h.result_attempt_id=a.id AND h.point_content_signature=s.point_content_signature
    LEFT JOIN progressive_worker_archive_reclaims r ON r.sim_job_id=h.sim_job_id AND r.point_content_signature=h.point_content_signature
    LEFT JOIN progressive_worker_archive_receipts ar ON ar.sim_job_id=r.sim_job_id AND ar.point_content_signature=r.point_content_signature
      AND r.completed_at IS NOT NULL AND a.sim_job_id=ar.sim_job_id AND a.engine_job_id=${jobId}
    LEFT JOIN solver_evidence_artifacts b ON b.result_attempt_id=a.id AND b.kind='engine_bundle'
    LEFT JOIN solver_evidence_artifacts mf ON mf.result_attempt_id=a.id AND mf.kind='manifest' AND ${historical ? sql`mf.result_id IS NOT DISTINCT FROM a.result_id` : sql`mf.result_id=a.result_id`} AND mf.engine_job_id=${jobId}
    LEFT JOIN LATERAL (
      SELECT CASE WHEN bool_and(valid) THEN encode(sha256(convert_to(string_agg(line,chr(10) ORDER BY line COLLATE "C"),'UTF8')),'hex') END AS signature
      FROM (SELECT DISTINCT (artifact.result_id IS NOT DISTINCT FROM a.result_id AND artifact.sha256 ~ '^[a-f0-9]{64}$'
          AND artifact.byte_size>=0 AND artifact.storage_key IS NOT NULL AND artifact.sha256 IS NOT NULL AND artifact.byte_size IS NOT NULL) AS valid,
        artifact.kind::text||chr(9)||artifact.storage_key||chr(9)||artifact.byte_size::text||chr(9)||artifact.sha256 AS line
        FROM solver_evidence_artifacts artifact WHERE artifact.result_attempt_id=a.id) inventory
    ) catalog ON true
    LEFT JOIN remote_asset_references ref ON ref.local_row_id=b.id AND ref.local_kind='evidence_artifact'
      AND ref.result_attempt_id=a.id AND ref.result_id=a.result_id AND b.result_id=a.result_id AND b.engine_job_id=${jobId}
      AND ref.local_storage_key=b.storage_key AND ref.sha256=b.sha256 AND ref.byte_size=b.byte_size AND ref.mime_type=b.mime_type
      AND ref.mime_type='application/zstd' AND ref.availability='remote_only' AND ref.metadata->>'generation'=ar.receipt#>>'{receipt,remote,generation}'
      AND ref.metadata->>'brokeredUploadId'=ar.brokered_upload_id::text AND ref.metadata->>'bucket'=ar.receipt#>>'{receipt,remote,bucket}' AND ref.metadata->>'objectKey'=ar.receipt#>>'{receipt,remote,objectKey}'
      AND ref.sha256=ar.receipt#>>'{receipt,remote,storedSha256}' AND ref.byte_size=(ar.receipt#>>'{receipt,remote,storedByteSize}')::bigint
      AND ref.remote_result_id=ar.receipt#>>'{receipt,canonical,resultId}' AND ref.remote_artifact_id=ar.receipt#>>'{receipt,canonical,artifactId}'
    ORDER BY a.id,s.point_content_signature LIMIT 257`);
  if (
    !rows.length ||
    rows.length > 256 ||
    new Set(rows.map((r) => r.id)).size !== rows.length
  )
    throw new Error("Incomplete or ambiguous job point inventory");
  // A deliberately empty set is meaningful only for a named URANS job.
  // The native peer checks every signed manifest, engine point and physical path.
  if (automatic) inspectImages = media.length > 0 || rows.every((r) => r.regime === "urans");
  if (inspectImages && !media.length && (historical || rows.some((r) => r.regime !== "urans")))
    throw Error("The named job has no registered instantaneous PNGs");
  const archives: Archive[] = rows.map((row) => {
    const signed = row.receipt as {
      receipt?: ProgressiveEvidenceCustodyReceipt;
      receiptHmac: string;
    } | null;
    const historic = historical?.get(String(row.point_content_signature));
    if (historic) {
      const c = historic,
        meta = row.metadata as Record<string, unknown> | null;
      const directory = `cases/${row.engine_case_slug}/${meta?.evidenceBase}`;
      if (
        !row.id ||
        row.same_local_result !== true ||
        signed?.receipt ||
        row.hub ||
        row.brokered_upload_id ||
        c.source_instance_id !== settings.instance_id ||
        !meta ||
        typeof meta.evidenceBase !== "string" ||
        directory
          .split("/")
          .some((s) => !s || s === "." || s === ".." || s.includes("\\")) ||
        row.archive_job !== jobId ||
        row.archive_case !== row.engine_case_slug ||
        row.archive_mime !== "application/zstd" ||
        row.storage_key !==
          `jobs/${jobId}/${directory}/engine_evidence.tar.zst` ||
        row.manifest_key !==
          `jobs/${jobId}/${directory}/evidence_manifest.json` ||
        row.archive_sha !== c.stored_sha256 ||
        Number(row.archive_size) !== c.stored_bytes ||
        row.manifest_sha !== c.manifest_sha256 ||
        Number(row.manifest_size) !== c.manifest_bytes ||
        meta.uncompressedTarSha256 !== c.tar_sha256 ||
        meta.uncompressedTarByteSize !== c.tar_bytes ||
        meta.bundledFileCount !== c.bundled_file_count ||
        meta.zstdLevel !== c.zstd_level ||
        typeof row.catalog_sha !== "string" ||
        typeof row.payload_sha !== "string" ||
        row.remote_download_url
      )
        throw Error("Historical local artifact and registered owner differ");
      const kept = pointImages(media, row.id, row.result_id, row.regime, directory, c.manifest_sha256);
      return {
        point: {
          attemptId: String(row.id),
          resultId: row.result_id === null ? null : String(row.result_id),
          canonicalAttemptId: null,
          canonicalResultId: null,
          pointSignature: c.point_content_signature,
          payloadSha256: row.payload_sha,
          aoa: row.aoa as string | null,
          cl: row.cl as string | null,
          cd: row.cd as string | null,
          cm: row.cm as string | null,
          status: row.status as string | null,
          regime: row.regime as string | null,
        },
        remote: {
          bucket: c.bucket,
          objectKey: c.object_key,
          generation: c.generation,
          crc32c: c.crc32c,
          storedSha256: c.stored_sha256,
          storedByteSize: c.stored_bytes,
          tarSha256: c.tar_sha256,
          tarByteSize: c.tar_bytes,
          manifestSha256: c.manifest_sha256,
          manifestByteSize: c.manifest_bytes,
          zstdLevel: c.zstd_level,
          bundledFileCount: c.bundled_file_count,
        },
        manifest: {
          directory,
          catalogSha256: row.catalog_sha,
          manifestSha256: c.manifest_sha256,
          manifestByteSize: c.manifest_bytes,
          generation: c.generation,
          historicalRaw: c,
          ...(row.regime === "urans" ? { regime: "urans" as const } : {}),
          ...(inspectImages ? { keepMedia: kept } : {}),
        },
      };
    }
    if (!row.id || !signed?.receipt)
      throw new Error("A job point lacks completed archive custody");
    const receipt = verifyProgressiveEvidenceCustodyReceipt(
      signed,
      settings.token as string,
      signed.receipt,
    );
    const hub = row.hub as {
      resultId?: string;
      resultAttemptId?: string;
    } | null;
    const metadata = row.metadata as { evidenceBase?: string } | null;
    const directory = `cases/${row.engine_case_slug}/${metadata?.evidenceBase}`;
    const url = new URL(
      `/api/sync/v1/evidence-uploads/${receipt.brokeredUploadId}/download`,
      base,
    ).toString();
    if (
      receipt.source.engineJobId !== jobId ||
      receipt.source.promiseId !== settings.promise ||
      receipt.source.solverId !== settings.solver ||
      receipt.source.remoteResultAttemptId !== row.id ||
      receipt.source.remoteResultId !== row.result_id ||
      receipt.source.engineCaseSlug !== row.engine_case_slug ||
      receipt.source.progressiveEvidence.pointContentSignature !==
        row.point_content_signature ||
      receipt.brokeredUploadId !== row.brokered_upload_id ||
      receipt.canonical.resultId !== hub?.resultId ||
      receipt.canonical.resultAttemptId !== hub?.resultAttemptId ||
      row.manifest_key !==
        `jobs/${jobId}/${directory}/evidence_manifest.json` ||
      receipt.remote.manifestSha256 !== row.manifest_sha ||
      receipt.remote.manifestByteSize !== Number(row.manifest_size) ||
      typeof row.catalog_sha !== "string" ||
      typeof row.payload_sha !== "string" ||
      !metadata?.evidenceBase ||
      directory
        .split("/")
        .some((p) => !p || p === "." || p === ".." || p.includes("\\")) ||
      row.storage_key !==
        `jobs/${jobId}/${directory}/engine_evidence.tar.zst` ||
      row.remote_download_url !== url
    )
      throw new Error(
        "Job point differs from its exact hub, manifest or archive owner",
      );
    const kept = pointImages(media, row.id, row.result_id, row.regime, directory, receipt.remote.manifestSha256);
    return {
      point: {
        attemptId: String(row.id),
        resultId: String(row.result_id),
        canonicalAttemptId: receipt.canonical.resultAttemptId,
        canonicalResultId: receipt.canonical.resultId,
        pointSignature:
          receipt.source.progressiveEvidence.pointContentSignature,
        payloadSha256: String(row.payload_sha),
        aoa: row.aoa as string | null,
        cl: row.cl as string | null,
        cd: row.cd as string | null,
        cm: row.cm as string | null,
        status: row.status as string | null,
        regime: row.regime as string | null,
      },
      remote: receipt.remote,
      manifest: {
        directory,
        catalogSha256: row.catalog_sha,
        ...(inspectImages ? { keepMedia: kept } : {}),
        ...(inspectImages && row.regime === "urans" ? { regime: "urans" as const } : {}),
        manifestSha256: receipt.remote.manifestSha256,
        manifestByteSize: receipt.remote.manifestByteSize,
        brokeredUploadId: receipt.brokeredUploadId,
        generation: receipt.remote.generation,
        receiptHmac: signed.receiptHmac,
      },
    };
  });
  if (
    new Set(archives.map((a) => a.manifest.directory)).size !== archives.length
  )
    throw new Error("Ambiguous job manifest ownership");
  if (
    archives.reduce((n, a) => n + (a.manifest.keepMedia?.length ?? 0), 0) !==
    media.length
  )
    throw Error("Kept media owner missing from archive set");
  if (historical) {
    const used = archives.filter((a) => a.manifest.historicalRaw);
    if (
      used.length !== historical.size ||
      new Set(used.map((a) => a.point.pointSignature)).size !== used.length
    )
      throw Error("Incomplete historical source coverage");
    const [match] =
      await db.execute(sql`SELECT count(*)::int AS n FROM jsonb_to_recordset(${JSON.stringify([...historical.values()])}::jsonb)
      c(sim_job_id uuid,sequence bigint,point_content_signature text,report_signature text,assignment_signature text)
      JOIN progressive_worker_reports r ON (r.sim_job_id,r.sequence,r.content_signature,r.assignment_signature)=(c.sim_job_id,c.sequence,c.report_signature,c.assignment_signature)
      WHERE r.acknowledged_at IS NOT NULL AND NOT EXISTS(SELECT FROM progressive_worker_report_conflicts x WHERE x.sim_job_id=r.sim_job_id AND x.sequence=r.sequence)
      AND NOT EXISTS(SELECT FROM progressive_worker_hub_receipts h WHERE h.sim_job_id=c.sim_job_id AND h.point_content_signature=c.point_content_signature)
      AND EXISTS(SELECT FROM progressive_worker_delivery_failures f
        JOIN progressive_worker_evidence_attempts a ON (a.sim_job_id,a.sequence,a.result_attempt_id,a.point_content_signature)=(f.sim_job_id,f.sequence,f.result_attempt_id,f.point_content_signature)
        WHERE f.sim_job_id=c.sim_job_id AND f.point_content_signature=c.point_content_signature AND f.state='conflict'
          AND f.last_http_status=409 AND f.remote_conflict_ids='[]'::jsonb AND f.last_error IN
          ('Progressive evidence delivery failed (409): progressive_scope_closed Obsolete or settled progressive CFD execution scope',
           'Stopped progressive storage delivery failed (409): Stopped storage requires closed ownership and its exact stop acknowledgement'))`);
    if (match?.n !== historical.size)
      throw Error("Historical worker report or original disposition changed");
  }
  if (historical) {
    const prefixes = archives
      .filter((a) => a.manifest.historicalRaw)
      .map((a) => ({
        dir: `jobs/${jobId}/${a.manifest.directory}/`,
        attempt: a.point.attemptId,
      }));
    // Source paths can have real artifact rows. Only the exact attempt's catalogue (checked against
    // the engine result and full manifest) may refer to the numeric files being offloaded.
    const [guard] =
      await db.execute(sql`WITH scopes AS MATERIALIZED(SELECT * FROM jsonb_to_recordset(${JSON.stringify(prefixes)}::jsonb) s(dir text,attempt uuid)),
      referenced AS MATERIALIZED (
        SELECT storage_key AS key,result_attempt_id AS owner,false AS other FROM solver_evidence_artifacts WHERE storage_key LIKE ${prefix + "%"}
        UNION ALL SELECT storage_key,NULL::uuid,true FROM result_media WHERE storage_key LIKE ${prefix + "%"}
        UNION ALL SELECT storage_key,NULL::uuid,true FROM field_render_cache WHERE storage_key LIKE ${prefix + "%"}
        UNION ALL SELECT local_storage_key,NULL::uuid,true FROM remote_asset_references WHERE local_storage_key LIKE ${prefix + "%"}
        UNION ALL SELECT cached_storage_key,NULL::uuid,true FROM remote_asset_references WHERE cached_storage_key LIKE ${prefix + "%"})
      SELECT EXISTS(SELECT FROM scopes s JOIN referenced a ON a.key=s.dir||'engine_evidence.tar.zst'
        OR starts_with(a.key,s.dir||'openfoam/') OR starts_with(a.key,s.dir||'time_directories/') OR starts_with(a.key,s.dir||'VTK/')
        WHERE a.other OR a.owner IS DISTINCT FROM s.attempt) AS conflict`);
    if (guard?.conflict !== false)
      throw Error(
        "Historical raw paths have foreign artifact, media, cache or proxy references",
      );
  }
  return { archives, base, token: settings.token, media };
}

function checkReceipt(
  r: ClosedProgressiveReclaimResponse,
  id: string,
  state: "planned" | "reclaimed",
) {
  if (
    r.job_id !== id ||
    !Number.isSafeInteger(r.bytes) ||
    r.bytes < 0 ||
    !Number.isSafeInteger(r.files) ||
    r.files < 0 ||
    !(
      (r.state === state &&
        typeof r.plan === "string" &&
        /^[a-f0-9]{64}$/.test(r.plan)) ||
      (r.state === "absent" && r.plan === null && !r.bytes && !r.files)
    )
  )
    throw new Error("Invalid closed progressive engine receipt");
}

async function record(
  db: DB,
  id: string,
  complete: boolean,
  outcome: string,
  bytes = 0,
  files = 0,
  planSha256: string | null = null,
  verifiedArchives = 0,
  scientificSha256: string | null = null,
  allocation: ClosedProgressiveReclaimResponse["allocation"] = null,
  mediaSha256?: string,
  historical = false,
  preserved?: PreservedSolver,
  hubStop?: RegisteredStop,
  automatic?: AutomaticVerification,
) {
  const field = preserved ? "closedProgressiveSiblingFiles" : historical ? "historicalRawFiles" : "closedProgressiveFiles";
  await db.execute(sql`UPDATE sim_jobs SET strip_report=jsonb_set(coalesce(strip_report,'{}'::jsonb),ARRAY[${field}::text],
    jsonb_build_object('checkedAt',clock_timestamp(),'complete',${complete}::boolean,'retryAfter',CASE WHEN ${complete || Boolean(automatic)}::boolean THEN NULL ELSE clock_timestamp()+interval '5 minutes' END,'outcome',${outcome}::text,'bytes',${bytes}::bigint,'files',${files}::int,'planSha256',${planSha256}::text,'verifiedArchives',${verifiedArchives}::int,'scientificSha256',${scientificSha256}::text,'allocation',${JSON.stringify(allocation ?? null)}::jsonb)
    || ${mediaSha256 ? sql`jsonb_build_object('mediaSha256',${mediaSha256}::text)` : sql`'{}'::jsonb`}
    || ${preserved ? sql`jsonb_build_object('preservedSolver',${JSON.stringify(preserved)}::jsonb)` : sql`'{}'::jsonb`}
    || ${hubStop ? sql`jsonb_build_object('registeredTerminalPromise',${JSON.stringify(hubStop)}::jsonb,'registeredTerminalPromiseSha256',${terminalPromiseSha256(hubStop)}::text)` : sql`'{}'::jsonb`}
    || ${automatic ? sql`jsonb_build_object('automaticVerification',${JSON.stringify(automatic)}::jsonb)` : sql`'{}'::jsonb`})
    WHERE id=${id}::uuid AND (${historical} OR stripped_at IS NULL) AND (strip_report->${field}::text)->>'complete' IS DISTINCT FROM 'true'
      AND (strip_report->${field}::text)#>>'{automaticVerification,state}' IS DISTINCT FROM 'awaiting-readback'`);
}

export async function closedProgressiveJob(
  db: DB,
  engine: ClosedProgressiveBackend,
  id: string,
  options: {
    now: Date;
    ageMs: number;
    timeoutMs: number;
    inspect?: boolean;
    verifyCompleted?: boolean;
    expectedScientificSha256?: string;
    automatic?: boolean;
    expectedNativeOwner?: ClosedProgressiveNativeOwner;
    expectedRestoreSha256?: string;
    expectedRegisteredStopSha256?: string | null;
    keepMedia?: boolean;
    historicalRaw?: boolean;
    preserveSolver?: string;
    linkedContinuation?: string;
    expectedMediaSha256?: string;
    expectedPlan?: string;
    signal?: AbortSignal;
  },
) {
  const { now, ageMs, timeoutMs } = options;
  if (options.automatic && (!engine.restoreArchive || options.preserveSolver || options.historicalRaw))
    throw Error("Automatic retention requires its verified native archive reader");
  const inspectMedia = options.keepMedia || options.automatic;
  if (options.preserveSolver !== undefined &&
      (!options.keepMedia || options.historicalRaw || !/^cases\/[a-zA-Z0-9_.-]+\/transient_a[0-9]+$/.test(options.preserveSolver) ||
        options.preserveSolver.split("/").some(p => p === "." || p === "..")))
    throw Error("Invalid named solver preservation scope");
  if (options.preserveSolver && !options.inspect &&
      (!options.expectedPlan || !options.expectedScientificSha256 || !options.expectedMediaSha256))
    throw Error("Signed sibling removal requires the exact plan, scientific evidence and media proof");
  if (options.verifyCompleted && (!options.inspect || !options.expectedPlan))
    throw new Error("Completed-plan verification must be read-only and exact");
  const historical = options.historicalRaw
    ? await historicalCustody(db, id, options.signal)
    : undefined;
  if (options.linkedContinuation !== undefined && !options.preserveSolver) throw Error("Continuation links require a preserved solver");
  const hubStop = options.preserveSolver
    ? await registeredTerminalPromise(db, id, options.signal, Boolean(options.expectedRegisteredStopSha256))
    : undefined;
  const stopSha256 = terminalPromiseSha256(hubStop);
  if ((options.expectedRegisteredStopSha256 !== undefined && options.expectedRegisteredStopSha256 !== stopSha256) ||
      (!options.inspect && hubStop && !options.expectedRegisteredStopSha256))
    throw Error("Registered terminal source differs from the pinned read-only proof");
  const source = await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    await tx.execute(
      sql`SELECT set_config('statement_timeout',${String(timeoutMs)},true),set_config('lock_timeout','500ms',true)`,
    );
    if (options.linkedContinuation !== undefined)
      await assertClosedContinuation(tx, id, options.preserveSolver!, options.linkedContinuation, false);
    const media = inspectMedia
      ? await registeredImages(tx, id, false, !historical)
      : [];
    const [ready] = await tx.execute(
      sql`SELECT j.id FROM sim_jobs j WHERE j.id=${id}::uuid AND ${eligible(now, ageMs, options.verifyCompleted ? options.expectedPlan : undefined, media, options.historicalRaw, options.preserveSolver, hubStop, options.automatic)}`,
    );
    if (!ready)
      throw new Error(
        "Job has active ownership, a retention refusal, unbound media or an existing completion",
      );
    return proofs(tx, id, media, historical, options.keepMedia, options.automatic);
  });
  const manifests = source.archives.map((a) => a.manifest);
  const plan = await engine.reclaimClosedProgressiveFiles(id, manifests);
  checkReceipt(plan, id, "planned");
  const keptImages = manifests.some(m => m.keepMedia !== undefined);
  if (options.automatic) {
    if (!plan.plan || !plan.files || !plan.bytes) throw Error("No positive verified working file copies");
    if (!plan.nativeOwner || !Array.isArray(plan.workingPaths) || plan.workingPaths.length !== plan.files ||
        new Set(plan.workingPaths).size !== plan.files)
      throw Error("Incomplete native working path or owner inventory");
    if (options.expectedNativeOwner && canonicalAnalysisJson(options.expectedNativeOwner) !== canonicalAnalysisJson(plan.nativeOwner))
      throw Error("Native volume or worker lock changed after reclamation");
  }
  const linked = plan.preservedSolver?.linkedContinuation;
  if (options.linkedContinuation !== undefined ?
      !linked || `${linked.jobId}/${linked.caseSlug}` !== options.linkedContinuation ||
      !/^[a-f0-9]{64}$/.test(linked.pathSetSha256) || !Number.isSafeInteger(linked.sharedFiles) || linked.sharedFiles < 1 ||
      !Number.isSafeInteger(linked.otherLinks) || linked.otherLinks < linked.sharedFiles : linked !== undefined)
    throw Error("Native retained continuation links differ from the named owner");
  if (options.preserveSolver) {
    if (!plan.bytes || !plan.files) throw Error("Signed siblings have no positive exact duplicates");
    const caseDir = options.preserveSolver.slice(0, options.preserveSolver.lastIndexOf("/"));
    const owners = new Set(manifests.map(m => m.directory));
    if (!manifests.length || manifests.some(m => m.regime !== "urans" || m.historicalRaw) ||
        options.preserveSolver !== `${caseDir}/transient_a${manifests.length}` ||
        manifests.some((_, i) => !owners.has(`${caseDir}/a${i}/evidence`)))
      throw Error("Named solver is not the next unreported sibling");
    await checkPreservedSolver(id, options.preserveSolver, plan, options.signal ?? AbortSignal.timeout(120_000));
  } else if (plan.preservedSolver) {
    throw Error("Unexpected preserved solver proof");
  }
  if (options.expectedPlan !== undefined && options.expectedPlan !== plan.plan)
    throw new Error(
      "The requested canary plan differs from the current filesystem plan",
    );
  if (options.verifyCompleted && plan.replayed !== true)
    throw new Error("The native completion receipt is missing");
  const points = source.archives.map((a) => a.point);
  const scientificSha256 = createHash("sha256")
    .update(JSON.stringify(points))
    .digest("hex");
  if (
    options.expectedScientificSha256 &&
    options.expectedScientificSha256 !== scientificSha256
  )
    throw new Error("Scientific point evidence differs from the pinned proof");
  let mediaSha256: string | undefined;
  if (!historical && (keptImages || options.automatic))
    await assertWorkingPathsUnreferenced(db, id, plan.workingPaths ?? []);
  if (keptImages) {
    mediaSha256 = await readKeptMedia(
      id,
      source.media,
      plan,
      options.signal ?? AbortSignal.timeout(120_000),
      Boolean(historical),
    );
    if (
      options.expectedMediaSha256 &&
      options.expectedMediaSha256 !== mediaSha256
    )
      throw Error("Kept media differ from the pinned proof");
  }
  const readbacks: ClosedProgressiveReadback[] = [];
  if (plan.state !== "absent" && plan.files) {
    const signal = options.signal ?? AbortSignal.timeout(20 * 60_000);
    for (const archive of source.archives) {
      const c = archive.manifest.historicalRaw;
      let verifiedMember: MediaFile | null = null;
      let restored: VerifiedArchiveRestore | undefined;
      if (c) {
        const target = new URL(
          "/jobs/" +
            id +
            "/files/" +
            archive.manifest.directory +
            "/engine_evidence.tar.zst",
          process.env.ENGINE_URL ?? "http://api:8000",
        );
        const headers: Record<string, string> = {
          accept: "application/zstd",
          "accept-encoding": "identity",
        };
        if (!options.verifyCompleted) {
          const token = configuredControlPlaneToken();
          if (!token) throw Error("Local engine authorization unavailable");
          headers.authorization = "Bearer " + token;
          headers["x-historical-raw-preflight"] = Buffer.from(
            JSON.stringify({
              version: 1,
              directory: archive.manifest.directory,
              receipt: c,
            }),
          ).toString("base64");
        }
        const result = await fetch(target, {
          redirect: "error",
          signal,
          headers,
        });
        if (
          result.headers.get("x-historical-raw-source") !== "registered-hub"
        ) {
          await result.body?.cancel();
          throw Error(
            "The actual engine file route did not reopen the registered historical generation (" +
              result.status +
              ")",
          );
        }
        await verifyProgressiveArchiveResponse(result, archive.remote);
        if (!plan.historicalSamples || !Object.hasOwn(plan.historicalSamples, c.point_content_signature))
          throw Error("Native historical member proof is missing");
        const sample = plan.historicalSamples[c.point_content_signature];
        if (sample) {
          if (
            !/^(openfoam|time_directories|VTK)\//.test(sample.path) ||
            sample.path
              .split("/")
              .some((p) => !p || p === "." || p === ".." || p.includes("\\")) ||
            !/^[a-f0-9]{64}$/.test(sample.sha256) ||
            !Number.isSafeInteger(sample.byteSize) ||
            sample.byteSize < 0
          )
            throw Error("Invalid historical member identity");
          const member = new URL(target);
          member.pathname =
            target.pathname.slice(0, target.pathname.lastIndexOf("/") + 1) +
            sample.path.split("/").map(encodeURIComponent).join("/");
          const response = await fetch(member, {
            redirect: "error",
            signal,
            headers,
          });
          if (
            response.headers.get("x-historical-raw-source") !== "registered-hub"
          ) {
            await response.body?.cancel();
            throw Error(
              "Original member route did not restore the pinned source",
            );
          }
          await verifyProgressiveArchiveResponse(
            response,
            {
              storedSha256: sample.sha256,
              storedByteSize: sample.byteSize,
              generation: c.generation,
            },
            false,
          );
          verifiedMember = sample;
        }
        if (options.verifyCompleted) {
          // This is the original HZ download link. Its local-first volume path is already absent.
          const file = sample ?? {
            path: "engine_evidence.tar.zst",
            byteSize: c.stored_bytes,
            sha256: c.stored_sha256,
          };
          const path = [archive.manifest.directory, file.path]
            .join("/")
            .split("/")
            .map(encodeURIComponent)
            .join("/");
          await readStoredFile(
            new URL(
              "/api/media/jobs/" + id + "/" + path,
              "http://node-api:4000",
            ),
            file,
            signal,
            sample ? "" : "application/zstd",
          );
        }
      } else {
        const url = new URL(
          `/api/sync/v1/evidence-uploads/${archive.manifest.brokeredUploadId}/download`,
          source.base,
        );
        if (options.automatic) {
          const body = await openProgressiveArchive(url.toString(), source.token, archive.remote, signal);
          try {
            restored = await engine.restoreArchive!(id, archive.manifest, archive.remote, body, signal);
          } finally {
            await body.cancel().catch(() => undefined);
          }
        } else {
          await preflightProgressiveArchive(url.toString(), source.token, archive.remote, signal);
        }
      }
      readbacks.push({
        ...(restored ? {restored} : {}),
        ...(c
          ? { historicalPointSignature: c.point_content_signature, verifiedMember }
          : { brokeredUploadId: archive.manifest.brokeredUploadId }),
        generation: archive.remote.generation,
        storedSha256: archive.remote.storedSha256,
        storedByteSize: archive.remote.storedByteSize,
        verifiedAt: new Date().toISOString(),
      });
    }
  }
  const automatic = options.automatic ? {
    state: "awaiting-readback" as const, owner: plan.nativeOwner!,
    restoreSha256: createHash("sha256").update(canonicalAnalysisJson(
      readbacks.map(({ verifiedAt: _at, ...identity }) => identity)
    )).digest("hex"),
  } : undefined;
  if (options.expectedRestoreSha256 && automatic?.restoreSha256 !== options.expectedRestoreSha256)
    throw Error("Post-removal archive membership or sample changed");
  if (options.inspect)
    return {
      plan,
      readbacks,
      points,
      scientificSha256,
      ...(mediaSha256 ? { mediaSha256, keptMediaRows: source.media } : {}),
      ...(hubStop ? { registeredTerminalPromise: hubStop, registeredTerminalPromiseSha256: stopSha256! } : {}),
      settled: false,
    };
  let allocation: ClosedProgressiveReclaimResponse["allocation"] = null;
  options.signal?.throwIfAborted();
  // All authenticated network reads finish before the write transaction starts.
  const confirmedStop = options.preserveSolver ? await registeredTerminalPromise(db, id, options.signal, Boolean(hubStop)) : undefined;
  if (terminalPromiseSha256(confirmedStop) !== stopSha256)
    throw Error("Registered terminal ownership changed during preflight");
  const settled = await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    await tx.execute(
      sql`SELECT set_config('statement_timeout',${String(timeoutMs)},true)`,
    );
    const [locked] = await tx.execute(
      sql`SELECT id FROM sim_jobs WHERE id=${id}::uuid FOR UPDATE SKIP LOCKED`,
    );
    if (!locked) return false;
    if (options.linkedContinuation !== undefined)
      await assertClosedContinuation(tx, id, options.preserveSolver!, options.linkedContinuation, true);
    const media = inspectMedia ? await registeredImages(tx, id, true, !historical) : [];
    const [ready] = await tx.execute(
      sql`SELECT j.id FROM sim_jobs j WHERE j.id=${id}::uuid AND ${eligible(now, ageMs, undefined, media, options.historicalRaw, options.preserveSolver, confirmedStop)}`,
    );
    if (!ready) return false;
    const fresh = await proofs(tx, id, media, historical, options.keepMedia, options.automatic);
    if ((keptImages || options.automatic) && !historical)
      await assertWorkingPathsUnreferenced(tx, id, plan.workingPaths!);
    options.signal?.throwIfAborted();
    if (
      fresh.base !== source.base ||
      fresh.token !== source.token ||
      JSON.stringify(fresh.archives) !== JSON.stringify(source.archives)
    )
      throw new Error("Closed job custody changed during preflight");
    if (plan.state !== "absent" && plan.files) {
      const done = await engine.reclaimClosedProgressiveFiles(
        id,
        manifests,
        plan.plan!,
        readbacks,
      );
      checkReceipt(done, id, "reclaimed");
      if (options.preserveSolver && canonicalAnalysisJson(done.preservedSolver) !== canonicalAnalysisJson(plan.preservedSolver))
        throw Error("Unreported solver changed during signed sibling release");
      if (
        keptImages &&
        (canonicalAnalysisJson(done.mediaFiles) !==
          canonicalAnalysisJson(plan.mediaFiles) ||
          (historical
            ? done.historicalPathsSha256 !== plan.historicalPathsSha256
            : canonicalAnalysisJson(done.workingPaths) !==
              canonicalAnalysisJson(plan.workingPaths)))
      )
        throw Error("Native keep-set or removed paths changed");
      if (options.automatic && (!done.allocation || !done.nativeOwner || canonicalAnalysisJson(done.nativeOwner) !== canonicalAnalysisJson(plan.nativeOwner) ||
          canonicalAnalysisJson(done.workingPaths) !== canonicalAnalysisJson(plan.workingPaths)))
        throw Error("Automatic removal differs from the measured native working set");
      allocation = done.allocation ?? null;
      if (
        done.state !== "reclaimed" ||
        done.plan !== plan.plan ||
        done.bytes !== plan.bytes ||
        done.files !== plan.files
      )
        throw new Error(
          "Closed progressive cleanup differs from verified plan",
        );
    }
    await record(
      tx,
      id,
      !options.automatic,
      plan.state === "absent"
        ? "absent"
        : options.preserveSolver
          ? "signed-sibling-working-files"
          : options.historicalRaw
          ? "historical-raw-files"
          : "duplicate-files",
      plan.bytes,
      plan.files,
      plan.plan,
      readbacks.length,
      scientificSha256,
      allocation,
      mediaSha256,
      options.historicalRaw,
      plan.preservedSolver,
      confirmedStop,
      automatic,
    );
    return true;
  });
  return {
    plan,
    readbacks,
    points,
    scientificSha256,
    ...(mediaSha256 ? { mediaSha256, keptMediaRows: source.media } : {}),
    ...(confirmedStop ? { registeredTerminalPromise: confirmedStop, registeredTerminalPromiseSha256: stopSha256! } : {}),
    allocation,
    settled,
  };
}

const PAGE_SIZE = 64;

type AppliedFileReceipt = {
  complete: boolean;
  planSha256: string;
  scientificSha256: string;
  mediaSha256?: string;
  automaticVerification?: AutomaticVerification;
};

async function reserveClosedOwner(db: DB, now: Date, ageMs: number, scanLimit: number, timeoutMs: number, automatic: boolean) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout',${String(timeoutMs)},true)`);
    const [cursor] = await tx.execute(sql`SELECT closed_progressive_retention_after_id AS after
      FROM sweeper_state WHERE id=1 FOR UPDATE SKIP LOCKED`);
    if (!cursor) return { owner: undefined, inspected: 0 };
    const after = cursor.after ? String(cursor.after) : null;
    // The point reclaim primary key starts with sim_job_id. Distinct keys bound every
    // subsequent job, media and receipt lookup; an excluded page still advances.
    const owners = await tx.execute(sql`WITH page AS MATERIALIZED (
      SELECT DISTINCT sim_job_id AS id FROM progressive_worker_archive_reclaims
      WHERE completed_at IS NOT NULL ${after ? sql`AND sim_job_id>${after}::uuid` : sql``}
      ORDER BY sim_job_id LIMIT ${scanLimit}
    ) SELECT page.id,j.strip_report->'closedProgressiveFiles' AS receipt,
      (j.status IN ('done','failed','cancelled') AND j.stripped_at IS NULL AND j.engine_job_id=j.id::text
       AND j.request_payload?'remoteProgressiveExecution'
       AND coalesce(j."finishedAt",j."ingestedAt",j."updatedAt",j."createdAt")<=${now.toISOString()}::timestamptz-(${ageMs}::float8*interval '1ms')
       AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
       AND j.strip_report#>>'{closedProgressiveFiles,complete}' IS DISTINCT FROM 'true'
       AND coalesce((j.strip_report#>>'{closedProgressiveFiles,retryAfter}')::timestamptz,'-infinity')<=clock_timestamp()
       AND coalesce((j.strip_report#>>'{closedProgressiveScan,retryAfter}')::timestamptz,'-infinity')<=clock_timestamp()
       ${automatic ? sql`` : sql`AND (${eligible(now,ageMs)})`}) AS ready
    FROM page LEFT JOIN sim_jobs j USING(id) ORDER BY page.id`);
    let owner: { id: string; receipt: AppliedFileReceipt | null } | undefined;
    let inspected = 0;
    let next: string | null = null;
    for (const row of owners) {
      next = String(row.id);
      inspected++;
      if (row.ready === true) {
        owner = { id: next, receipt: row.receipt as AppliedFileReceipt | null };
        break;
      }
    }
    // Wrap only after an empty tail. Persist progress even if every owner was held,
    // a later cloud read fails, or another sweeper starts before the next tick.
    if (next !== after)
      await tx.execute(sql`UPDATE sweeper_state SET closed_progressive_retention_after_id=${next}::uuid WHERE id=1`);
    return { owner, inspected };
  });
}

async function confirmAutomaticFiles(db: DB, engine: ClosedProgressiveBackend, id: string, saved: AppliedFileReceipt,
                                    now: Date, ageMs: number, timeoutMs: number, signal: AbortSignal) {
  const proof = saved.automaticVerification;
  if (saved.complete || !proof || proof.state !== "awaiting-readback") return false;
  if (!/^[a-f0-9]{64}$/.test(proof.restoreSha256) || !/^[a-f0-9]{64}$/.test(saved.scientificSha256) ||
      !/^[a-f0-9]{64}$/.test(saved.planSha256) || !proof.owner)
    throw Error("Missing durable automatic restore identity");
  const after = await closedProgressiveJob(db,engine,id,{now,ageMs,timeoutMs,signal,automatic:true,inspect:true,
    verifyCompleted:true,expectedPlan:saved.planSha256,expectedScientificSha256:saved.scientificSha256,
    expectedMediaSha256:saved.mediaSha256,expectedNativeOwner:proof.owner,expectedRestoreSha256:proof.restoreSha256});
  if (!after.plan.replayed || !after.readbacks.length || (after.mediaSha256 ?? null)!==(saved.mediaSha256 ?? null))
    throw Error("Post-removal source, media or native completion is missing");
  const rows = await db.execute(sql`UPDATE sim_jobs SET strip_report=jsonb_set(strip_report-'closedProgressiveScan',
    '{closedProgressiveFiles}', (strip_report->'closedProgressiveFiles') || jsonb_build_object(
      'complete',true,'automaticVerification', (strip_report#>'{closedProgressiveFiles,automaticVerification}') ||
      jsonb_build_object('state','verified','verifiedAt',clock_timestamp())))
    WHERE id=${id}::uuid AND stripped_at IS NULL AND strip_report->'closedProgressiveFiles'=${JSON.stringify(saved)}::jsonb
    RETURNING id`);
  return rows.length === 1;
}

function holdReason(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof EngineError) return `engine-${error.status ?? "unavailable"}`;
  if (/no positive|directory is absent/i.test(message)) return "no-verified-working-copies";
  if (/media|image|legend|PNG/.test(message)) return "media-ownership";
  if (/lock|EAGAIN|Resource temporarily unavailable/.test(message)) return "worker-busy";
  if (/unarchived|unreported|unowned/.test(message)) return "unresolved-source";
  if (/manifest|member|generation|CRC|restore|download|readback/i.test(message)) return "archive-restore";
  return "custody-proof-failed";
}

async function deferAutomaticFiles(db: DB, id: string, reason: string) {
  const repeats = sql`CASE WHEN strip_report#>>'{closedProgressiveScan,reason}'=${reason}
    THEN least(7,coalesce((strip_report#>>'{closedProgressiveScan,attempts}')::int,0)+1) ELSE 1 END`;
  await db.execute(sql`UPDATE sim_jobs SET strip_report=jsonb_set(coalesce(strip_report,'{}'::jsonb),'{closedProgressiveScan}',
    jsonb_build_object('checkedAt',clock_timestamp(),'reason',${reason}::text,'attempts',${repeats},
      'retryAfter',clock_timestamp()+make_interval(secs=>least(21600,300*power(2,(${repeats})-1))::float8)))
    WHERE id=${id}::uuid AND stripped_at IS NULL AND strip_report#>>'{closedProgressiveFiles,complete}' IS DISTINCT FROM 'true'`);
}

export async function stripClosedProgressiveJobs(
  db: DB, engine: ClosedProgressiveBackend, now: Date, ageMs: number, limit: number, timeoutMs: number,
  stop?: AbortSignal,
) {
  if (limit <= 0 || stop?.aborted) return 0;
  const deadline = AbortSignal.timeout(20 * 60_000);
  const signal = stop ? AbortSignal.any([deadline, stop]) : deadline;
  const automatic = typeof engine.restoreArchive === "function";
  let completed = 0, inspected = 0, attempted = 0;
  while (inspected < PAGE_SIZE && attempted < limit && !signal.aborted) {
    const page = await reserveClosedOwner(db,now,ageMs,PAGE_SIZE-inspected,timeoutMs,automatic);
    inspected += page.inspected;
    if (!page.owner) break;
    const { id, receipt } = page.owner;
    attempted++;
    try {
      if (receipt?.automaticVerification?.state === "awaiting-readback") {
        if (automatic && await confirmAutomaticFiles(db,engine,id,receipt,now,ageMs,timeoutMs,signal)) completed++;
        continue;
      }
      const result = await closedProgressiveJob(db,engine,id,{now,ageMs,timeoutMs,signal,automatic});
      if (!result.settled) {
        if (automatic) await deferAutomaticFiles(db,id,"owner-changed");
        continue;
      }
      if (automatic) {
        const [row] = await db.execute(sql`SELECT strip_report->'closedProgressiveFiles' AS receipt FROM sim_jobs WHERE id=${id}::uuid`);
        if (row?.receipt && await confirmAutomaticFiles(db,engine,id,row.receipt as AppliedFileReceipt,now,ageMs,timeoutMs,signal))
          completed++;
      } else completed++;
    } catch (error) {
      const reason = holdReason(error);
      if (automatic) await deferAutomaticFiles(db,id,reason);
      else await record(db,id,false,reason);
    }
  }
  return completed;
}
