import {
  remoteAssetReferences as refs,
  resultMedia,
  solverEvidenceArtifacts as artifacts,
  type Result,
  type ResultAttempt,
  type SolverEvidenceArtifact,
} from "@aerodb/db";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { db } from "./db";

export function currentRenderManifest(
  result: Pick<Result, "id" | "airfoilId" | "currentResultAttemptId">,
  attempt: Pick<
    ResultAttempt,
    "id" | "resultId" | "simJobId" | "engineJobId" | "engineCaseSlug" | "aoaDeg"
  >,
  artifacts: readonly SolverEvidenceArtifact[],
): SolverEvidenceArtifact | null {
  if (
    result.currentResultAttemptId !== attempt.id ||
    result.id !== attempt.resultId
  )
    return null;
  const manifests = artifacts.filter((row) => row.kind === "manifest");
  const [manifest] = manifests;
  if (
    manifests.length !== 1 ||
    !manifest ||
    manifest.resultId !== result.id ||
    manifest.resultAttemptId !== attempt.id ||
    manifest.airfoilId !== result.airfoilId ||
    manifest.simJobId !== attempt.simJobId ||
    manifest.engineJobId !== attempt.engineJobId ||
    manifest.engineCaseSlug !== attempt.engineCaseSlug ||
    manifest.aoaDeg !== attempt.aoaDeg ||
    !/^[a-f0-9]{64}$/i.test(manifest.sha256) ||
    manifest.byteSize <= 0 ||
    !manifest.storageKey.trim() ||
    !manifest.mimeType.trim()
  )
    return null;
  return manifest;
}

/** Prefer the exact manifest over a signed media reference from the same authority.
 * Two different source/result pairs already prove ambiguity. */
export async function remoteRenderAuthorities(target: {
  resultId: string;
  resultAttemptId: string;
  evidenceSha256: string;
}) {
  const source = sql<string>`coalesce(${refs.sourceInstanceId}, '')`;
  return db
    .selectDistinctOn([source, refs.remoteResultId])
    .from(refs)
    .where(
      and(
        eq(refs.resultId, target.resultId),
        eq(refs.resultAttemptId, target.resultAttemptId),
        ne(refs.remoteResultId, ""),
        or(
          and(
            eq(refs.localKind, "evidence_artifact"),
            sql`EXISTS (
        SELECT 1 FROM ${artifacts}
        WHERE ${artifacts.id} = ${refs.localRowId} AND ${artifacts.resultId} = ${refs.resultId}
          AND ${artifacts.resultAttemptId} = ${refs.resultAttemptId} AND ${artifacts.kind} = 'manifest'
          AND ${artifacts.sha256} = ${target.evidenceSha256} AND ${artifacts.sha256} = ${refs.sha256}
          AND ${artifacts.byteSize} = ${refs.byteSize} AND ${artifacts.mimeType} = ${refs.mimeType}
      )`,
          ),
          and(
            eq(refs.localKind, "result_media"),
            sql`EXISTS (
        SELECT 1 FROM ${resultMedia}
        WHERE ${resultMedia.id} = ${refs.localRowId} AND ${resultMedia.resultId} = ${refs.resultId}
          AND ${resultMedia.resultAttemptId} = ${refs.resultAttemptId} AND ${resultMedia.evidenceSha256} = ${target.evidenceSha256}
          AND ${resultMedia.sha256} = ${refs.sha256} AND ${resultMedia.sha256} <> ''
          AND ${resultMedia.byteSize} IS NOT DISTINCT FROM ${refs.byteSize} AND ${resultMedia.mimeType} = ${refs.mimeType}
      )`,
          ),
        ),
      ),
    )
    .orderBy(
      source,
      refs.remoteResultId,
      sql`${refs.localKind} = 'evidence_artifact' DESC`,
    )
    .limit(2);
}
