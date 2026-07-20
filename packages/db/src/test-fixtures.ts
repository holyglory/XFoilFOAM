/** Test-only evidence fixtures shared by DB-backed integration suites.
 * Runtime code must never import this module. */
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { DB } from "./client";
import {
  resultAttempts,
  resultClassifications,
  results,
  simulationPresetRevisions,
  solverEvidenceArchives,
  solverEvidenceArtifactMembers,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
} from "./schema";

export const VERIFIED_RESTART_ARCHIVE_MEMBERS = [
  "openfoam/transient/transient_start.json",
  "openfoam/transient/system/controlDict",
  "openfoam/transient/system/fvSchemes",
  "openfoam/transient/system/fvSolution",
  "openfoam/transient/constant/polyMesh/points",
  "openfoam/transient/constant/polyMesh/faces",
  "openfoam/transient/constant/polyMesh/owner",
  "openfoam/transient/constant/polyMesh/neighbour",
  "openfoam/transient/constant/polyMesh/boundary",
  "openfoam/transient/constant/transportProperties",
  "openfoam/transient/constant/turbulenceProperties",
  "openfoam/transient/constant/physicalProperties",
  "openfoam/transient/constant/momentumTransport",
  "time_directories/10/U",
  "time_directories/10/p",
  "time_directories/10/k",
  "time_directories/10/omega",
  "time_directories/10/nut",
  "time_directories/10/phi",
  "openfoam/postProcessing/forceCoeffs1/0/coefficient.dat",
] as const;

/** Attach a structurally complete test-only restart archive to one exact
 * immutable result generation. Callers own cleanup of the returned blob row:
 * deleting the result cascades logical artifacts/archives, while physical
 * blob identity intentionally survives until explicitly removed. */
export async function createVerifiedRestartArchiveFixture(
  db: DB,
  input: {
    resultId: string;
    resultAttemptId: string;
    backend?: "gcs" | "volume";
    compression?: "zstd" | "gzip";
    omitMembers?: readonly string[];
  },
): Promise<{ archiveId: string; blobId: string }> {
  const [attempt] = await db
    .select()
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, input.resultAttemptId),
        eq(resultAttempts.resultId, input.resultId),
      ),
    )
    .limit(1);
  if (!attempt) {
    throw new Error(
      `test restart archive requires exact attempt ${input.resultId}/${input.resultAttemptId}`,
    );
  }
  if (!attempt.solverImplementationId) {
    throw new Error(
      `test restart archive requires solver implementation ${input.resultAttemptId}`,
    );
  }
  const manifests = await db
    .select({ id: solverEvidenceArtifacts.id })
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, input.resultId),
        eq(solverEvidenceArtifacts.resultAttemptId, input.resultAttemptId),
        eq(solverEvidenceArtifacts.kind, "manifest"),
      ),
    );
  if (manifests.length !== 1) {
    throw new Error(
      `test restart archive requires one exact manifest; found ${manifests.length}`,
    );
  }

  const token = randomUUID().replaceAll("-", "");
  const [bundle] = await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: input.resultId,
      resultAttemptId: input.resultAttemptId,
      airfoilId: attempt.airfoilId,
      simJobId: attempt.simJobId,
      engineJobId: attempt.engineJobId,
      engineCaseSlug: attempt.engineCaseSlug,
      methodKey: attempt.methodKey,
      solverImplementationId: attempt.solverImplementationId,
      aoaDeg: attempt.aoaDeg,
      kind: "engine_bundle",
      storageKey: `test-fixtures/restart/${token}/engine.tar.zst`,
      mimeType: "application/zstd",
      sha256: "b".repeat(64),
      byteSize: 4096,
    })
    .returning({ id: solverEvidenceArtifacts.id });
  const backend = input.backend ?? "gcs";
  const compression = input.compression ?? "zstd";
  const [blob] = await db
    .insert(solverEvidenceBlobs)
    .values({
      backend,
      bucket: backend === "gcs" ? "exact-restart-test" : null,
      objectKey:
        backend === "gcs" && compression === "zstd"
          ? `solver-evidence/v1/sha256/cc/${"c".repeat(64)}.tar.zst`
          : `test-fixtures/restart/${token}.tar.${compression === "zstd" ? "zst" : "gz"}`,
      generation:
        backend === "gcs"
          ? String(BigInt(`0x${token.slice(0, 12)}`) + 1n)
          : null,
      compression,
      mimeType:
        compression === "zstd" ? "application/zstd" : "application/gzip",
      sha256: "c".repeat(64),
      byteSize: 4096,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: "d".repeat(64),
      uncompressedTarByteSize: 8192,
      verifiedAt: new Date(),
      metadata: {
        fixture: "verified-restart-archive",
        archiveFormat: "tar+zstd",
        zstdLevel: 10,
      },
    })
    .returning({ id: solverEvidenceBlobs.id });
  const [archive] = await db
    .insert(solverEvidenceArchives)
    .values({
      resultId: input.resultId,
      resultAttemptId: input.resultAttemptId,
      sourceArtifactId: bundle.id,
      blobId: blob.id,
    })
    .returning({ id: solverEvidenceArchives.id });

  const omitted = new Set(input.omitMembers ?? []);
  const memberPaths = VERIFIED_RESTART_ARCHIVE_MEMBERS.filter(
    (path) => !omitted.has(path),
  );
  const members = await db
    .insert(solverEvidenceArtifacts)
    .values(
      memberPaths.map((path, index) => ({
        resultId: input.resultId,
        resultAttemptId: input.resultAttemptId,
        airfoilId: attempt.airfoilId,
        simJobId: attempt.simJobId,
        engineJobId: attempt.engineJobId,
        engineCaseSlug: attempt.engineCaseSlug,
        methodKey: attempt.methodKey,
        solverImplementationId: attempt.solverImplementationId,
        aoaDeg: attempt.aoaDeg,
        kind: "time_directory" as const,
        storageKey: `test-fixtures/restart/${token}/${path}`,
        mimeType: "application/octet-stream",
        sha256: (index % 16).toString(16).repeat(64),
        byteSize: 64,
      })),
    )
    .returning({ id: solverEvidenceArtifacts.id });
  await db.insert(solverEvidenceArtifactMembers).values([
    {
      archiveId: archive.id,
      artifactId: manifests[0]!.id,
      memberPath: "evidence_manifest.json",
    },
    ...members.map((member, index) => ({
      archiveId: archive.id,
      artifactId: member.id,
      memberPath: memberPaths[index]!,
    })),
  ]);
  return { archiveId: archive.id, blobId: blob.id };
}

/** Ensure a manual verify-queue fixture owns real immutable preliminary
 * attempt evidence. Legacy tests used to point only at the mutable results
 * container, which no longer represents a valid runnable verification. */
export async function createAcceptedPrecalcAttemptFixture(
  db: DB,
  resultId: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: resultAttempts.id })
    .from(resultAttempts)
    .innerJoin(
      resultClassifications,
      eq(resultClassifications.resultAttemptId, resultAttempts.id),
    )
    .where(
      and(
        eq(resultAttempts.resultId, resultId),
        eq(resultAttempts.status, "done"),
        eq(resultAttempts.source, "solved"),
        sql`${resultAttempts.evidencePayload} ->> 'fidelity' = 'urans_precalc'`,
        eq(resultClassifications.state, "accepted"),
      ),
    )
    .orderBy(desc(resultAttempts.createdAt), desc(resultAttempts.id))
    .limit(1);
  if (existing) return existing.id;

  const [result] = await db
    .select()
    .from(results)
    .where(eq(results.id, resultId))
    .limit(1);
  if (!result?.simulationPresetRevisionId) {
    throw new Error(
      `test preliminary attempt fixture requires revision-owned result ${resultId}`,
    );
  }
  const [revision] = await db
    .select({
      solverImplementationId: simulationPresetRevisions.solverImplementationId,
    })
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, result.simulationPresetRevisionId))
    .limit(1);
  const methodKey = result.methodKey ?? "openfoam.urans";
  const solverImplementationId =
    result.solverImplementationId ?? revision?.solverImplementationId;
  if (!solverImplementationId) {
    throw new Error(
      `test preliminary attempt fixture requires solver implementation ${resultId}`,
    );
  }
  await db
    .update(results)
    .set({ methodKey, solverImplementationId })
    .where(eq(results.id, result.id));
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId: result.airfoilId,
      bcId: result.bcId,
      simulationPresetRevisionId: result.simulationPresetRevisionId,
      aoaDeg: result.aoaDeg,
      simJobId: result.simJobId,
      engineJobId: result.engineJobId,
      engineCaseSlug: result.engineCaseSlug,
      methodKey,
      solverImplementationId,
      status: "done",
      source: "solved",
      regime: result.regime ?? "urans",
      validForPolar: true,
      cl: result.cl,
      cd: result.cd,
      cm: result.cm,
      clCd: result.clCd,
      clStd: result.clStd,
      cdStd: result.cdStd,
      cmStd: result.cmStd,
      converged: result.converged,
      unsteady: result.unsteady,
      evidencePayload: { fidelity: "urans_precalc", test_fixture: true },
      solvedAt: result.solvedAt ?? new Date(),
    })
    .returning({ id: resultAttempts.id });
  await db.insert(resultClassifications).values({
    resultId: null,
    resultAttemptId: attempt.id,
    airfoilId: result.airfoilId,
    simulationPresetRevisionId: result.simulationPresetRevisionId,
    aoaDeg: result.aoaDeg,
    regime: result.regime ?? "urans",
    classifierVersion: "test-fixture-exact-precalc-v1",
    state: "accepted",
    region: "unknown",
    confidence: 1,
    reasons: [],
  });
  await db.insert(solverEvidenceArtifacts).values({
    resultId: result.id,
    resultAttemptId: attempt.id,
    airfoilId: result.airfoilId,
    simJobId: result.simJobId,
    engineJobId: result.engineJobId,
    engineCaseSlug: result.engineCaseSlug,
    methodKey,
    solverImplementationId,
    aoaDeg: result.aoaDeg,
    kind: "manifest",
    storageKey: `test-fixtures/${attempt.id}/manifest.json`,
    mimeType: "application/json",
    sha256: "a".repeat(64),
    byteSize: 1,
  });
  return attempt.id;
}
