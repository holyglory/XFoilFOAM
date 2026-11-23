import { z } from "zod";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import type { ProgressiveEvidenceCustodyReceipt } from "@aerodb/db/progressive-evidence-custody";
import type { ProgressiveRemoteEvidenceDelivery } from "@aerodb/db/progressive-remote-evidence-receipts";
import type { resultAttempts } from "@aerodb/db/schema";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const positive = z.number().int().positive();
const archiveSubmission = z
  .object({
    promiseId: z.string().uuid(),
    sourceInstanceId: z.string().min(1),
    sourceInstanceName: z.string().optional(),
    results: z.tuple([
      z
        .object({
          solverId: z.string().uuid(),
          promiseId: z.string().uuid(),
          engineJobId: z.string().uuid(),
          aoaDeg: z.number().finite(),
          engineCaseSlug: z.string().nullable(),
          remoteResultId: z.string().uuid(),
          remoteResultAttemptId: z.string().uuid(),
          progressiveArchiveOnly: z.literal(true),
          progressiveEvidence: z
            .object({
              sequence: positive,
              reportContentSignature: hash,
              pointContentSignature: hash,
            })
            .strict(),
          evidenceArtifacts: z.tuple([
            z
              .object({
                kind: z.literal("manifest"),
                mimeType: z.literal("application/json"),
                sha256: hash,
                byteSize: positive,
                uploadField: z.literal("evidence_manifest"),
              })
              .strict(),
            z
              .object({
                kind: z.literal("engine_bundle"),
                mimeType: z.literal("application/zstd"),
                sha256: hash,
                byteSize: positive,
                remoteEvidenceUploadId: z.string().uuid(),
                metadata: z.record(z.unknown()),
              })
              .strict(),
          ]),
        })
        .strict(),
    ]),
  })
  .strict();
export type BoundArchiveSubmission = z.infer<typeof archiveSubmission>;
export function boundArchiveSubmission(
  input: unknown,
): BoundArchiveSubmission | undefined {
  const points = (input as { results?: unknown } | null)?.results;
  if (
    !Array.isArray(points) ||
    points.length !== 1 ||
    !points[0]?.progressiveArchiveOnly
  )
    return;
  const value = archiveSubmission.safeParse(input);
  if (value.success) return value.data;
}

type FileProof = {
  storageKey: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
};
export function submittedArchiveProof(
  submission: BoundArchiveSubmission,
  solverId: string,
  files: ReadonlyMap<string, FileProof>,
) {
  const point = submission.results[0],
    [manifest, bundle] = point.evidenceArtifacts;
  const file = files.get(manifest.uploadField);
  // These facts are measured while the multipart parser drains the actual file.
  if (
    point.solverId !== solverId ||
    point.promiseId !== submission.promiseId ||
    files.size !== 1 ||
    !file ||
    file.sha256 !== manifest.sha256 ||
    file.byteSize !== manifest.byteSize ||
    file.mimeType !== manifest.mimeType
  )
    return null;
  const {
    engineJobId,
    engineCaseSlug,
    remoteResultId,
    remoteResultAttemptId,
    aoaDeg,
    promiseId,
    progressiveEvidence,
  } = point;
  const source: ProgressiveRemoteEvidenceDelivery = {
    solverId,
    promiseId,
    engineJobId,
    engineCaseSlug,
    remoteResultId,
    remoteResultAttemptId,
    aoaDeg,
    progressiveEvidence,
  };
  return {
    source,
    instance: submission.sourceInstanceId,
    point: { manifest: file, bundle },
  };
}
export type SubmittedRawPoint = NonNullable<
  ReturnType<typeof submittedArchiveProof>
>["point"];

/** Match the full proposed artifact associations, including custom metadata.
 * An addition, ambiguous shape or proposed archive upgrade takes the normal
 * import/conflict path. Nothing in the multipart request can replace a proof. */
export async function boundArtifactsMatchSubmission(
  db: DB,
  proposed: SubmittedRawPoint,
  instance: string,
  attempt: typeof resultAttempts.$inferSelect,
  raw: Pick<ProgressiveEvidenceCustodyReceipt, "canonical" | "remote">,
) {
  const { bundle, manifest } = proposed;
  if (
    bundle.sha256 !== raw.remote.storedSha256 ||
    bundle.byteSize !== raw.remote.storedByteSize ||
    manifest.sha256 !== raw.remote.manifestSha256 ||
    manifest.byteSize !== raw.remote.manifestByteSize ||
    bundle.metadata.storageBackend !== "gcs" ||
    Object.entries(raw.remote).some(
      ([key, value]) =>
        bundle.metadata[key] !==
        (key === "tarByteSize" || key === "manifestByteSize"
          ? String(value)
          : value),
    )
  )
    return false;
  const metadata = JSON.stringify({
    ...bundle.metadata,
    sourceInstanceId: instance,
    remoteEvidenceUploadId: bundle.remoteEvidenceUploadId,
  });
  const [match] =
    await db.execute(sql`SELECT 1 FROM solver_evidence_artifacts b JOIN solver_evidence_artifact_members m
    ON m.archive_id=${raw.canonical.archiveId}::uuid AND m.member_path='evidence_manifest.json'
    JOIN solver_evidence_artifacts a ON a.id=m.artifact_id
    WHERE b.id=${raw.canonical.artifactId}::uuid AND b.kind='engine_bundle' AND a.kind='manifest'
      AND (a.result_id,a.result_attempt_id)=(b.result_id,b.result_attempt_id)
      AND (a.airfoil_id,a.sim_job_id,a.engine_job_id,a.engine_case_slug,a.method_key,a.solver_implementation_id,a.solver_runtime_build_id,a.aoa_deg)
        IS NOT DISTINCT FROM (b.airfoil_id,b.sim_job_id,b.engine_job_id,b.engine_case_slug,b.method_key,b.solver_implementation_id,b.solver_runtime_build_id,b.aoa_deg)
      AND (b.airfoil_id,b.sim_job_id,b.engine_job_id,b.engine_case_slug,b.method_key,b.solver_implementation_id,b.solver_runtime_build_id,b.aoa_deg)
        IS NOT DISTINCT FROM (${attempt.airfoilId}::uuid,${attempt.simJobId}::uuid,${attempt.engineJobId}::text,${attempt.engineCaseSlug}::text,
        ${attempt.methodKey}::text,${attempt.solverImplementationId}::uuid,${attempt.solverRuntimeBuildId}::uuid,${attempt.aoaDeg}::float8)
      AND a.field IS NULL AND a.role IS NULL AND b.field IS NULL AND b.role IS NULL
      AND b.metadata=${metadata}::jsonb AND a.metadata=jsonb_build_object('sourceInstanceId',${instance}::text)
      AND a.storage_key=${manifest.storageKey} AND a.mime_type=${manifest.mimeType} AND a.sha256=${manifest.sha256} AND a.byte_size=${manifest.byteSize}`);
  return Boolean(match);
}
