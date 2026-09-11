import { createHash, randomUUID } from "node:crypto";
import {
  analysisContentHash,
  remoteAssetReferences,
  solverEvidenceArtifacts,
  verifyProgressiveEvidenceCustodyReceipt,
  type DB,
  type ProgressiveEvidenceCustodyReceipt,
} from "@aerodb/db";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import { and, eq, sql } from "drizzle-orm";
import { configuredControlPlaneToken } from "./config";
import { recordProgressiveWorkerArchiveCustody } from "./progressive-worker-archive-custody";

type Settings = {
  upstreamBaseUrl: string | null;
  remoteSolverAuthToken: string;
  remoteSolverRegisteredId: string | null;
};
type Claim = { executionId: string; signature: string; token: string };

export async function runArchiveReclaimPass(
  legacy: (limit: number) => Promise<number>,
  progressive: (limit: number) => Promise<number>,
): Promise<number> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => legacy(4)),
    Promise.resolve().then(() => progressive(4)),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(
      errors,
      "Archive reclamation pass failed after draining both queues",
    );
  return results.reduce(
    (total, result) =>
      total + (result.status === "fulfilled" ? result.value : 0),
    0,
  );
}

export async function preflightProgressiveArchive(
  url: string,
  token: string,
  remote: ProgressiveEvidenceCustodyReceipt["remote"],
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    redirect: "error",
    headers: { accept: "application/zstd", "x-xfoilfoam-solver-token": token },
    signal,
  });
  if (
    !response.ok ||
    !response.body ||
    response.headers.get("content-type")?.split(";", 1)[0] !==
      "application/zstd" ||
    Number(response.headers.get("content-length")) !== remote.storedByteSize ||
    response.headers.get("x-content-sha256") !== remote.storedSha256 ||
    response.headers.get("x-gcs-generation") !== remote.generation
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      "Progressive archive readback changed its immutable headers",
    );
  }
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += bytes.length;
    if (size > remote.storedByteSize)
      throw new Error("Progressive archive readback exceeds its signed size");
    hash.update(bytes);
  }
  if (
    size !== remote.storedByteSize ||
    hash.digest("hex") !== remote.storedSha256
  )
    throw new Error(
      "Progressive archive readback failed its complete byte proof",
    );
}

async function claimArchive(db: DB): Promise<Claim | null> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`
      INSERT INTO progressive_worker_archive_reclaims(sim_job_id,point_content_signature)
      SELECT custody.sim_job_id,custody.point_content_signature
      FROM progressive_worker_archive_receipts custody
      JOIN progressive_worker_hub_receipts retained USING(sim_job_id,point_content_signature)
      WHERE NOT EXISTS (SELECT 1 FROM progressive_worker_archive_reclaims reclaim
        WHERE reclaim.sim_job_id=custody.sim_job_id AND reclaim.point_content_signature=custody.point_content_signature)
        AND NOT EXISTS (SELECT 1 FROM sync_remote_hub_binding_receipts legacy
          WHERE legacy.result_attempt_id=retained.result_attempt_id)
      ORDER BY custody.received_at,custody.sim_job_id,custody.point_content_signature
      LIMIT 100 ON CONFLICT DO NOTHING`);
    const token = randomUUID();
    const [claimed] = await transaction.execute(sql`
      WITH candidate AS (
        SELECT reclaim.sim_job_id,reclaim.point_content_signature
        FROM progressive_worker_archive_reclaims reclaim JOIN sim_jobs job ON job.id=reclaim.sim_job_id
        WHERE reclaim.completed_at IS NULL AND reclaim.retry_after<=clock_timestamp()
          AND EXISTS (SELECT 1 FROM sync_api_settings settings WHERE settings.id=1
            AND NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token<>''
            AND settings.upstream_base_url IS NOT NULL AND settings.remote_solver_registered_id IS NOT NULL)
          AND (reclaim.claim_expires_at IS NULL OR reclaim.claim_expires_at<=clock_timestamp())
          AND job.status IN ('done','failed','cancelled') AND job.engine_job_id=job.id::text
          AND job.request_payload ? 'remoteProgressiveExecution'
          AND NOT EXISTS (SELECT 1 FROM progressive_worker_hub_receipts retained
            JOIN sync_remote_hub_binding_receipts legacy ON legacy.result_attempt_id=retained.result_attempt_id
            WHERE retained.sim_job_id=reclaim.sim_job_id AND retained.point_content_signature=reclaim.point_content_signature)
          AND (job.ingest_lease_expires_at IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
          AND EXISTS (SELECT 1 FROM progressive_worker_reports report
            WHERE report.sim_job_id=job.id AND report.stopped_engine_job_id=job.id::text)
          AND NOT EXISTS (SELECT 1 FROM sim_jobs child WHERE child.status IN ('pending','submitted','running','ingesting')
            AND (child.parent_job_id=job.id OR child.request_payload#>>'{engineRequest,continue_from,engine_job_id}'=job.id::text))
        ORDER BY reclaim.retry_after,reclaim.sim_job_id,reclaim.point_content_signature
        LIMIT 1 FOR UPDATE OF reclaim SKIP LOCKED
      ) UPDATE progressive_worker_archive_reclaims reclaim
        SET claim_token=${token}::uuid,claim_expires_at=clock_timestamp()+interval '30 minutes',
          attempt_count=attempt_count+1,last_error=NULL
        FROM candidate WHERE reclaim.sim_job_id=candidate.sim_job_id AND reclaim.point_content_signature=candidate.point_content_signature
        RETURNING reclaim.sim_job_id,reclaim.point_content_signature`);
    return claimed
      ? {
          executionId: String(claimed.sim_job_id),
          signature: String(claimed.point_content_signature),
          token,
        }
      : null;
  });
}

async function reclaimClaim(
  db: DB,
  settings: Settings,
  claim: Claim,
): Promise<number> {
  const abort = new AbortController();
  const signal = AbortSignal.any([
    abort.signal,
    AbortSignal.timeout(20 * 60_000),
  ]);
  let renewal: Promise<void> | null = null;
  const renew = async () => {
    const rows = await db.execute(sql`UPDATE progressive_worker_archive_reclaims
      SET claim_expires_at=clock_timestamp()+interval '30 minutes'
      WHERE sim_job_id=${claim.executionId}::uuid AND point_content_signature=${claim.signature}
        AND claim_token=${claim.token}::uuid AND claim_expires_at>clock_timestamp() AND completed_at IS NULL
        AND EXISTS (SELECT 1 FROM sync_api_settings settings WHERE settings.id=1
          AND NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token=${settings.remoteSolverAuthToken}
          AND settings.remote_solver_registered_id=${settings.remoteSolverRegisteredId}::uuid
          AND settings.upstream_base_url=${settings.upstreamBaseUrl}) RETURNING sim_job_id`);
    if (rows.length !== 1)
      throw new Error("Progressive archive reclaim lost its exact claim");
  };
  const timer = setInterval(() => {
    if (!renewal)
      renewal = renew()
        .catch((error) => abort.abort(error))
        .finally(() => {
          renewal = null;
        });
  }, 60_000);
  try {
    if (
      !settings.upstreamBaseUrl ||
      !settings.remoteSolverAuthToken ||
      !settings.remoteSolverRegisteredId
    )
      throw new Error(
        "Progressive archive reclaim requires its registered hub",
      );
    const [stored] =
      await db.execute(sql`SELECT custody.receipt,custody.brokered_upload_id,retained.result_attempt_id
      FROM progressive_worker_archive_receipts custody JOIN progressive_worker_hub_receipts retained USING(sim_job_id,point_content_signature)
      WHERE custody.sim_job_id=${claim.executionId}::uuid AND custody.point_content_signature=${claim.signature}`);
    const signed = stored?.receipt as
      | { receipt?: ProgressiveEvidenceCustodyReceipt; receiptHmac?: string }
      | undefined;
    const supplied = signed?.receipt;
    if (!supplied?.source || !supplied.remote)
      throw new Error("Progressive archive reclaim has no custody receipt");
    const receipt = verifyProgressiveEvidenceCustodyReceipt(
      signed,
      settings.remoteSolverAuthToken,
      supplied,
    );
    if (
      receipt.source.engineJobId !== claim.executionId ||
      receipt.source.progressiveEvidence.pointContentSignature !==
        claim.signature ||
      receipt.source.remoteResultAttemptId !== stored.result_attempt_id ||
      receipt.brokeredUploadId !== stored.brokered_upload_id ||
      receipt.source.solverId !== settings.remoteSolverRegisteredId ||
      !receipt.source.engineCaseSlug
    )
      throw new Error("Progressive archive reclaim changed source ownership");
    await recordProgressiveWorkerArchiveCustody(db, signed, receipt);
    const bundles = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(
            solverEvidenceArtifacts.resultAttemptId,
            receipt.source.remoteResultAttemptId,
          ),
          eq(solverEvidenceArtifacts.kind, "engine_bundle"),
        ),
      );
    if (bundles.length !== 1)
      throw new Error("Progressive archive reclaim requires one exact bundle");
    const bundle = bundles[0]!;
    const metadata = bundle.metadata;
    const remote = receipt.remote;
    const evidenceBase = metadata.evidenceBase;
    if (
      bundle.resultId !== receipt.source.remoteResultId ||
      bundle.engineJobId !== claim.executionId ||
      bundle.engineCaseSlug !== receipt.source.engineCaseSlug ||
      bundle.sha256 !== remote.storedSha256 ||
      bundle.byteSize !== remote.storedByteSize ||
      bundle.mimeType !== "application/zstd" ||
      metadata.uncompressedTarSha256 !== remote.tarSha256 ||
      Number(metadata.uncompressedTarByteSize) !== remote.tarByteSize ||
      Number(metadata.zstdLevel) !== remote.zstdLevel ||
      Number(metadata.bundledFileCount) !== remote.bundledFileCount ||
      typeof evidenceBase !== "string" ||
      evidenceBase.includes("\\") ||
      evidenceBase
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error(
        "Progressive archive reclaim differs from the local bundle",
      );
    const hubBaseUrl = canonicalRemoteHubBaseUrl(settings.upstreamBaseUrl);
    const downloadUrl = new URL(
      `/api/sync/v1/evidence-uploads/${receipt.brokeredUploadId}/download`,
      hubBaseUrl,
    ).toString();
    const reference = {
      localKind: "evidence_artifact",
      localRowId: bundle.id,
      localStorageKey: bundle.storageKey,
      resultId: bundle.resultId,
      resultAttemptId: bundle.resultAttemptId,
      sourceInstanceId: null,
      sourceInstanceName: "authoritative remote solver hub",
      remoteResultId: receipt.canonical.resultId,
      remoteArtifactId: receipt.canonical.artifactId,
      remoteDownloadUrl: downloadUrl,
      remoteRenderUrl: null,
      sha256: remote.storedSha256,
      byteSize: remote.storedByteSize,
      mimeType: "application/zstd",
      availability: "remote_only" as const,
      cachedStorageKey: null,
      metadata: {
        source: "remote-solver-hub",
        authMode: "remote_solver_token",
        hubBaseUrl,
        registeredSolverId: settings.remoteSolverRegisteredId,
        brokeredUploadId: receipt.brokeredUploadId,
        bucket: remote.bucket,
        objectKey: remote.objectKey,
        generation: remote.generation,
        crc32c: remote.crc32c,
      },
    };
    await db.transaction(async (transaction) => {
      await transaction
        .insert(remoteAssetReferences)
        .values(reference)
        .onConflictDoNothing();
      const [existing] = await transaction
        .select()
        .from(remoteAssetReferences)
        .where(eq(remoteAssetReferences.localStorageKey, bundle.storageKey));
      const actual =
        existing &&
        Object.fromEntries(
          Object.keys(reference).map((key) => [
            key,
            existing[key as keyof typeof existing],
          ]),
        );
      if (
        !actual ||
        analysisContentHash(actual) !== analysisContentHash(reference)
      )
        throw new Error(
          "Progressive archive reclaim conflicts with a stored remote reference",
        );
    });
    await preflightProgressiveArchive(
      downloadUrl,
      settings.remoteSolverAuthToken,
      remote,
      signal,
    );
    await renew();
    signal.throwIfAborted();
    const token = configuredControlPlaneToken();
    if (!token)
      throw new Error(
        "Progressive archive reclaim requires engine authorization",
      );
    const response = await fetch(
      `${(process.env.ENGINE_URL ?? "http://localhost:8000").replace(/\/+$/, "")}/internal/evidence-uploads/reclaim`,
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jobId: claim.executionId,
          caseSlug: receipt.source.engineCaseSlug,
          evidenceBase,
          receipt,
          receiptHmac: signed!.receiptHmac,
        }),
      },
    );
    const result = (await response.json().catch(() => null)) as {
      state?: string;
      evidence_base?: string;
      verification?: string;
      bytes_freed?: number;
    } | null;
    if (
      !response.ok ||
      !result ||
      result.evidence_base !== evidenceBase ||
      result.verification !==
        "hub-signed-progressive-custody+local-archive+intent" ||
      !["complete", "no_local_bytes"].includes(String(result.state)) ||
      !Number.isSafeInteger(result.bytes_freed) ||
      result.bytes_freed! < 0
    )
      throw new Error(
        `Progressive archive engine reclaim failed (${response.status})`,
      );
    signal.throwIfAborted();
    const settled =
      await db.execute(sql`UPDATE progressive_worker_archive_reclaims
      SET completed_at=clock_timestamp(),reclaimed_bytes=${result.bytes_freed!},claim_token=NULL,claim_expires_at=NULL,last_error=NULL
      WHERE sim_job_id=${claim.executionId}::uuid AND point_content_signature=${claim.signature} AND claim_token=${claim.token}::uuid
        AND claim_expires_at>clock_timestamp() AND completed_at IS NULL RETURNING sim_job_id`);
    if (settled.length !== 1)
      throw new Error("Progressive archive reclaim settlement lost its claim");
    return 1;
  } catch (error) {
    await db.execute(sql`UPDATE progressive_worker_archive_reclaims SET claim_token=NULL,claim_expires_at=NULL,
      retry_after=clock_timestamp()+make_interval(secs=>least(21600,30*power(2,least(attempt_count,9)))::double precision),
      last_error=${String(error instanceof Error ? error.message : error).slice(0, 700)}
      WHERE sim_job_id=${claim.executionId}::uuid AND point_content_signature=${claim.signature}
        AND claim_token=${claim.token}::uuid AND completed_at IS NULL`);
    return 0;
  } finally {
    clearInterval(timer);
    await renewal;
  }
}

export async function reclaimProgressiveArchives(
  db: DB,
  settings: Settings,
  limit = 8,
): Promise<number> {
  const claims: Claim[] = [];
  for (
    let index = 0;
    index < Math.min(8, Math.max(0, Math.trunc(limit)));
    index += 1
  ) {
    const claim = await claimArchive(db);
    if (!claim) break;
    claims.push(claim);
  }
  const results = await Promise.all(
    claims.map((claim) => reclaimClaim(db, settings, claim)),
  );
  return results.reduce((total, count) => total + count, 0);
}
