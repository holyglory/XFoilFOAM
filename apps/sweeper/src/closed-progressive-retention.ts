import { createHash } from "node:crypto";
import { EngineError } from "@aerodb/engine-client";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  canonicalAnalysisJson,
  verifyProgressiveEvidenceCustodyReceipt,
  type DB,
  type ProgressiveEvidenceCustodyReceipt,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import { preflightProgressiveArchive } from "./progressive-archive-reclaim";

export interface ClosedProgressiveManifest {
  directory: string;
  catalogSha256: string;
  manifestSha256: string;
  manifestByteSize: number;
  brokeredUploadId: string;
  generation: string;
  receiptHmac: string;
  keepMedia?: KeptImage[];
}

export interface ClosedProgressiveReadback {
  brokeredUploadId: string;
  generation: string;
  storedSha256: string;
  storedByteSize: number;
  verifiedAt: string;
}

export interface ClosedProgressiveReclaimResponse {
  job_id: string;
  state: "absent" | "planned" | "reclaimed";
  replayed?: boolean;
  mediaFiles?: MediaFile[];
  workingPaths?: string[];
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
  reclaimClosedProgressiveFiles(
    jobId: string,
    manifests: ClosedProgressiveManifest[],
    expectedPlan?: string,
    readbacks?: ClosedProgressiveReadback[],
  ): Promise<ClosedProgressiveReclaimResponse>;
}

type KeptImage = {
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
    (a.sim_job_id=${jobId}::uuid AND a.engine_job_id=${jobId} AND a.result_id=m.result_id AND a.regime='rans' AND r.current_result_attempt_id=a.id
     AND m.storage_key LIKE ${prefix + "%"} AND m.kind='image' AND m.role='instantaneous' AND m.mime_type='image/png'
     AND m.sha256~'^[a-f0-9]{64}$' AND m.byte_size>0 AND m.evidence_sha256~'^[a-f0-9]{64}$' AND m.field IS NOT NULL AND f.slug IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM result_media_storage_bindings b WHERE b.result_media_id=m.id)
     AND NOT EXISTS(SELECT 1 FROM result_media_storage_uploads u WHERE u.result_media_id=m.id)) AS ok
    FROM result_media m LEFT JOIN result_attempts a ON a.id=m.result_attempt_id LEFT JOIN results r ON r.id=m.result_id
    LEFT JOIN airfoils f ON f.id=a.airfoil_id LEFT JOIN field_color_scales s ON s.id=m.color_scale_id WHERE ${selected} ORDER BY m.id LIMIT 257`);
  if (!rows.length || rows.length > 256 || rows.some((r) => r.ok !== true))
    throw Error(
      "Keep-set requires a bounded inventory of exact current-job instantaneous PNG rows",
    );
  return rows.map(({ ok, ...r }) => r as unknown as KeptImage);
}

async function assertWorkingPathsUnreferenced(
  db: DB,
  id: string,
  paths: readonly string[],
) {
  if (!paths.length) return;
  if (
    paths.length > 4096 ||
    paths.some(
      (p) =>
        !p.startsWith("cases/") ||
        p.split("/").some((s) => !s || s === "." || s === ".."),
    )
  )
    throw Error("Invalid candidate working paths");
  const keys = sql`(${sql.join(
    paths.map((p) => sql`${`jobs/${id}/${p}`}`),
    sql`,`,
  )})`;
  const [row] =
    await db.execute(sql`SELECT EXISTS (SELECT 1 FROM result_media WHERE storage_key IN ${keys})
    OR EXISTS(SELECT 1 FROM solver_evidence_artifacts WHERE storage_key IN ${keys})
    OR EXISTS(SELECT 1 FROM field_render_cache WHERE storage_key IN ${keys})
    OR EXISTS(SELECT 1 FROM remote_asset_references WHERE local_storage_key IN ${keys} OR cached_storage_key IN ${keys}) AS referenced`);
  if (row?.referenced !== false)
    throw Error(
      "A proposed working file still has a live artifact or media path reference",
    );
}

async function readPng(url: URL, file: MediaFile, signal: AbortSignal) {
  const r = await fetch(url, {
    signal,
    redirect: "error",
    headers: { accept: "image/png", "accept-encoding": "identity" },
  });
  if (
    !r.ok ||
    !r.body ||
    r.headers.get("content-type")?.split(";")[0] !== "image/png" ||
    Number(r.headers.get("content-length")) !== file.byteSize
  ) {
    await r.body?.cancel();
    throw Error("Existing image route did not return its stored PNG identity");
  }
  let length = 0;
  const hash = createHash("sha256");
  for await (const bytes of r.body as unknown as AsyncIterable<Uint8Array>) {
    length += bytes.length;
    if (length > file.byteSize) throw Error("Image exceeded its stored size");
    hash.update(bytes);
  }
  if (length !== file.byteSize || hash.digest("hex") !== file.sha256)
    throw Error("Existing image route returned different bytes");
}

async function readKeptMedia(
  id: string,
  media: KeptImage[],
  plan: ClosedProgressiveReclaimResponse,
  signal: AbortSignal,
) {
  if (
    !plan.mediaFiles?.length ||
    plan.mediaFiles.length > 512 ||
    !Array.isArray(plan.workingPaths) ||
    plan.workingPaths.length !== plan.files
  )
    throw Error(
      "Native peer omitted the protected image or working-file inventory",
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
    await readPng(new URL(`/jobs/${id}/files/${path}`, engine), f, signal);
    await readPng(new URL(`/api/media/jobs/${id}/${path}`, api), f, signal);
  }
  const results = new Map<
    string,
    Record<string, { url?: string; imageUrl?: string; scale?: unknown }>
  >();
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
    await readPng(new URL(stable, api), file, signal);
    let displayed = results.get(m.resultId);
    if (!displayed) {
      const r = await fetch(
        new URL(
          `/api/airfoils/${encodeURIComponent(m.slug)}/sim?resultId=${m.resultId}`,
          api,
        ),
        { signal, redirect: "error" },
      );
      if (!r.ok) {
        await r.body?.cancel();
        throw Error("Stored point detail is unavailable");
      }
      if (!r.body) throw Error("Stored point detail has no body");
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const part of r.body as unknown as AsyncIterable<Uint8Array>) {
        size += part.length;
        if (size > 2 * 1024 ** 2)
          throw Error(
            "Stored point detail exceeded the media-proof byte bound",
          );
        parts.push(part);
      }
      const sim = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
        resultId: string;
        media: NonNullable<typeof displayed>;
      };
      if (sim.resultId !== m.resultId || !sim.media)
        throw Error("Stored point detail changed owner or lost media");
      displayed = sim.media;
      results.set(m.resultId, displayed);
    }
    const entry = Object.values(displayed).find(
      (x) => x.url === stable || x.imageUrl === stable,
    );
    if (
      !entry ||
      canonicalAnalysisJson(entry.scale ?? null) !==
        canonicalAnalysisJson(m.legend)
    )
      throw Error("Displayed media link or color legend changed");
  }
  return createHash("sha256")
    .update(canonicalAnalysisJson({ media, files: plan.mediaFiles }))
    .digest("hex");
}

const LIVE = sql`('pending','submitted','running','ingesting')`;
function eligible(
  now: Date,
  ageMs: number,
  completedPlan?: string,
  media: KeptImage[] = [],
) {
  return sql`j.status IN ('done','failed','cancelled') AND j.engine_job_id=j.id::text
    AND j.request_payload ? 'remoteProgressiveExecution' AND j.stripped_at IS NULL
    AND ${
      completedPlan === undefined
        ? sql`j.strip_report#>>'{closedProgressiveFiles,complete}' IS DISTINCT FROM 'true'`
        : sql`j.strip_report#>>'{closedProgressiveFiles,complete}'='true' AND j.strip_report#>>'{closedProgressiveFiles,planSha256}'=${completedPlan}`
    }
    AND coalesce((j.strip_report#>>'{closedProgressiveFiles,retryAfter}')::timestamptz,'-infinity') <= clock_timestamp()
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
    AND EXISTS(SELECT 1 FROM progressive_worker_archive_receipts ar WHERE ar.sim_job_id=j.id)
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
  resultId: string;
  canonicalAttemptId: string;
  canonicalResultId: string;
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
async function proofs(db: DB, jobId: string, media: KeptImage[] = []) {
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
    s.upstream_base_url AS base,p.id AS promise FROM sync_api_settings s JOIN sim_jobs j ON j.id=${jobId}::uuid
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
      catalog.signature AS catalog_sha,b.storage_key,b.metadata,mf.storage_key AS manifest_key,mf.sha256 AS manifest_sha,mf.byte_size AS manifest_size,ref.remote_download_url
    FROM owner a FULL JOIN pairs p ON p.result_attempt_id=a.id LEFT JOIN staged s ON s.result_attempt_id=p.result_attempt_id AND s.point_content_signature=p.point_content_signature
    LEFT JOIN progressive_worker_hub_receipts h ON h.sim_job_id=${jobId}::uuid AND h.result_attempt_id=a.id AND h.point_content_signature=s.point_content_signature
    LEFT JOIN progressive_worker_archive_reclaims r ON r.sim_job_id=h.sim_job_id AND r.point_content_signature=h.point_content_signature
    LEFT JOIN progressive_worker_archive_receipts ar ON ar.sim_job_id=r.sim_job_id AND ar.point_content_signature=r.point_content_signature
      AND r.completed_at IS NOT NULL AND a.sim_job_id=ar.sim_job_id AND a.engine_job_id=${jobId}
    LEFT JOIN solver_evidence_artifacts b ON b.result_attempt_id=a.id AND b.kind='engine_bundle'
    LEFT JOIN solver_evidence_artifacts mf ON mf.result_attempt_id=a.id AND mf.kind='manifest' AND mf.result_id=a.result_id AND mf.engine_job_id=${jobId}
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
  const archives: Archive[] = rows.map((row) => {
    const signed = row.receipt as {
      receipt?: ProgressiveEvidenceCustodyReceipt;
      receiptHmac: string;
    } | null;
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
    const kept = media.filter((m) => m.attemptId === row.id);
    if (
      media.length &&
      (!kept.length ||
        kept.some(
          (m) =>
            m.resultId !== row.result_id ||
            m.evidenceSha256 !== receipt.remote.manifestSha256 ||
            !m.path.startsWith(directory + "/scaled_media/"),
        ))
    )
      throw Error("Kept images differ from the exact signed point owner");
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
        ...(media.length ? { keepMedia: kept } : {}),
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
) {
  await db.execute(sql`UPDATE sim_jobs SET strip_report=jsonb_set(coalesce(strip_report,'{}'::jsonb),'{closedProgressiveFiles}',
    jsonb_build_object('checkedAt',clock_timestamp(),'complete',${complete}::boolean,'retryAfter',CASE WHEN ${complete}::boolean THEN NULL ELSE clock_timestamp()+interval '5 minutes' END,'outcome',${outcome}::text,'bytes',${bytes}::bigint,'files',${files}::int,'planSha256',${planSha256}::text,'verifiedArchives',${verifiedArchives}::int,'scientificSha256',${scientificSha256}::text,'allocation',${JSON.stringify(allocation ?? null)}::jsonb)
    || ${mediaSha256 ? sql`jsonb_build_object('mediaSha256',${mediaSha256}::text)` : sql`'{}'::jsonb`})
    WHERE id=${id}::uuid AND stripped_at IS NULL AND strip_report#>>'{closedProgressiveFiles,complete}' IS DISTINCT FROM 'true'`);
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
    keepMedia?: boolean;
    expectedMediaSha256?: string;
    expectedPlan?: string;
    signal?: AbortSignal;
  },
) {
  const { now, ageMs, timeoutMs } = options;
  if (options.verifyCompleted && (!options.inspect || !options.expectedPlan))
    throw new Error("Completed-plan verification must be read-only and exact");
  const source = await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    await tx.execute(
      sql`SELECT set_config('statement_timeout',${String(timeoutMs)},true),set_config('lock_timeout','500ms',true)`,
    );
    const media = options.keepMedia
      ? await registeredImages(tx, id, false)
      : [];
    const [ready] = await tx.execute(
      sql`SELECT j.id FROM sim_jobs j WHERE j.id=${id}::uuid AND ${eligible(now, ageMs, options.verifyCompleted ? options.expectedPlan : undefined, media)}`,
    );
    if (!ready)
      throw new Error(
        "Job has active ownership, a retention refusal, unbound media or an existing completion",
      );
    return proofs(tx, id, media);
  });
  const manifests = source.archives.map((a) => a.manifest);
  const plan = await engine.reclaimClosedProgressiveFiles(id, manifests);
  checkReceipt(plan, id, "planned");
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
  if (options.keepMedia) {
    await assertWorkingPathsUnreferenced(db, id, plan.workingPaths ?? []);
    mediaSha256 = await readKeptMedia(
      id,
      source.media,
      plan,
      options.signal ?? AbortSignal.timeout(120_000),
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
      const url = new URL(
        `/api/sync/v1/evidence-uploads/${archive.manifest.brokeredUploadId}/download`,
        source.base,
      );
      await preflightProgressiveArchive(
        url.toString(),
        source.token,
        archive.remote,
        signal,
      );
      readbacks.push({
        brokeredUploadId: archive.manifest.brokeredUploadId,
        generation: archive.remote.generation,
        storedSha256: archive.remote.storedSha256,
        storedByteSize: archive.remote.storedByteSize,
        verifiedAt: new Date().toISOString(),
      });
    }
  }
  if (options.inspect)
    return {
      plan,
      readbacks,
      points,
      scientificSha256,
      ...(mediaSha256 ? { mediaSha256, keptMediaRows: source.media } : {}),
      settled: false,
    };
  let allocation: ClosedProgressiveReclaimResponse["allocation"] = null;
  options.signal?.throwIfAborted();
  const settled = await db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    await tx.execute(
      sql`SELECT set_config('statement_timeout',${String(timeoutMs)},true)`,
    );
    const [locked] = await tx.execute(
      sql`SELECT id FROM sim_jobs WHERE id=${id}::uuid FOR UPDATE SKIP LOCKED`,
    );
    if (!locked) return false;
    const media = options.keepMedia ? await registeredImages(tx, id, true) : [];
    const [ready] = await tx.execute(
      sql`SELECT j.id FROM sim_jobs j WHERE j.id=${id}::uuid AND ${eligible(now, ageMs, undefined, media)}`,
    );
    if (!ready) return false;
    const fresh = await proofs(tx, id, media);
    if (options.keepMedia)
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
      if (
        options.keepMedia &&
        (canonicalAnalysisJson(done.mediaFiles) !==
          canonicalAnalysisJson(plan.mediaFiles) ||
          canonicalAnalysisJson(done.workingPaths) !==
            canonicalAnalysisJson(plan.workingPaths))
      )
        throw Error("Native keep-set or removed paths changed");
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
      true,
      plan.state === "absent" ? "absent" : "duplicate-files",
      plan.bytes,
      plan.files,
      plan.plan,
      readbacks.length,
      scientificSha256,
      allocation,
      mediaSha256,
    );
    return true;
  });
  return {
    plan,
    readbacks,
    points,
    scientificSha256,
    ...(mediaSha256 ? { mediaSha256, keptMediaRows: source.media } : {}),
    allocation,
    settled,
  };
}

const scanCursor = new WeakMap<DB, string | null>();
const PAGE_SIZE = 64;

export async function stripClosedProgressiveJobs(
  db: DB,
  engine: ClosedProgressiveBackend,
  now: Date,
  ageMs: number,
  limit: number,
  timeoutMs: number,
) {
  const signal = AbortSignal.timeout(20 * 60_000);
  const selected = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout',${String(timeoutMs)},true)`,
    );
    let after = scanCursor.get(db);
    if (after === undefined) {
      // Completed, interrupted and refused checks all record their position. Resume
      // the last attempted job's successor on a service restart, then wrap normally.
      const [last] = await tx.execute(sql`SELECT id FROM sim_jobs
        WHERE strip_report#>>'{closedProgressiveFiles,checkedAt}' IS NOT NULL
        ORDER BY (strip_report#>>'{closedProgressiveFiles,checkedAt}')::timestamptz DESC,id DESC LIMIT 1`);
      after = last ? String(last.id) : null;
      scanCursor.set(db, after);
    }
    // Evaluate joins and TOASTed request bodies only for this keyset page. Advance over every
    // inspected row, including SQL exclusions, an engine 409, and a failed cloud proof.
    return tx.execute(sql`WITH page AS MATERIALIZED (
      SELECT id FROM sim_jobs WHERE status IN ('done','failed','cancelled') AND engine_job_id=id::text
        AND stripped_at IS NULL AND strip_report#>>'{closedProgressiveFiles,complete}' IS DISTINCT FROM 'true'
        AND coalesce((strip_report#>>'{closedProgressiveFiles,retryAfter}')::timestamptz,'-infinity')<=clock_timestamp()
        ${after ? sql`AND id>${after}::uuid` : sql``}
      ORDER BY id LIMIT ${PAGE_SIZE}
    ) SELECT j.id, (${eligible(now, ageMs)}) AS eligible FROM page JOIN sim_jobs j USING(id) ORDER BY j.id`);
  });
  let completed = 0,
    attempted = 0,
    inspected = 0;
  for (const candidate of selected) {
    const id = String(candidate.id);
    scanCursor.set(db, id);
    inspected++;
    if (candidate.eligible !== true) continue;
    attempted++;
    try {
      const { settled } = await closedProgressiveJob(db, engine, id, {
        now,
        ageMs,
        timeoutMs,
        signal,
      });
      if (settled) completed++;
    } catch (error) {
      // The retry receipt never persists signed material or an upstream error body.
      const reason =
        error instanceof EngineError
          ? `engine-${error.status ?? "unavailable"}`
          : "custody-proof-failed";
      await record(db, id, false, reason);
    }
    if (signal.aborted || attempted >= Math.min(8, limit)) break;
  }
  if (inspected === selected.length && selected.length < PAGE_SIZE)
    scanCursor.set(db, null);
  return completed;
}
