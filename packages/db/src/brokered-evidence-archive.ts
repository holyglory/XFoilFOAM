import { and, eq } from "drizzle-orm";

import type { DB } from "./client";
import type { EvidenceManifestEntry } from "./evidence-archive-manifest";
import {
  resultAttempts,
  solverEvidenceArchives,
  solverEvidenceArtifactMembers,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
} from "./schema";

type EvidenceArtifactKind =
  (typeof solverEvidenceArtifacts.$inferInsert)["kind"];

export interface VerifiedBrokeredArchiveIdentity {
  bucket: string;
  objectKey: string;
  generation: string;
  crc32c: string;
  storedSha256: string;
  storedByteSize: number;
  tarSha256: string;
  tarByteSize: number;
  manifestSha256: string;
  manifestByteSize: number;
  zstdLevel: number;
  bundledFileCount: number;
  verifiedAt: Date;
}

function artifactKindForManifestRole(role: string): EvidenceArtifactKind {
  if (role === "frame_image") {
    throw new Error(
      "bundled frame_image must remain separately stored presentation evidence",
    );
  }
  if (role === "mesh_evidence") return "mesh";
  if (role === "continuation_state") return "dictionary";
  if (
    [
      "vtk_window",
      "time_directory",
      "log",
      "force_coefficients",
      "mesh",
      "dictionary",
    ].includes(role)
  ) {
    return role as EvidenceArtifactKind;
  }
  return "field_data";
}

function mimeTypeForMember(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".gz")) return "application/gzip";
  if (lower.endsWith(".zst")) return "application/zstd";
  if (lower.endsWith(".csv")) return "text/csv";
  if (
    lower.endsWith(".dat") ||
    lower.endsWith(".log") ||
    lower.endsWith(".txt")
  ) {
    return "text/plain";
  }
  if (
    lower.endsWith(".vtu") ||
    lower.endsWith(".vtk") ||
    lower.endsWith(".vtp")
  ) {
    return "application/vnd.vtk";
  }
  if (lower.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function memberStorageKey(
  identity: VerifiedBrokeredArchiveIdentity,
  memberPath: string,
): string {
  return `${identity.objectKey}.members/${memberPath}`;
}

function exactJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => exactJson(item)).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${exactJson(source[key])}`)
    .join(",")}}`;
}

/**
 * Register the exact generation-pinned archive accepted through the remote
 * evidence broker. The broker authenticates the compressed/tar identity and
 * the caller must first verify every manifest member from the fresh GCS
 * generation. This function then materializes only evidence-derived logical
 * member rows; it never invents solver bytes or mutates the imported source
 * artifact.
 */
export async function registerVerifiedBrokeredEvidenceArchive(
  db: DB,
  input: {
    resultId: string;
    resultAttemptId: string;
    sourceArtifactId: string;
    manifestArtifactId: string;
    evidenceBase: string;
    identity: VerifiedBrokeredArchiveIdentity;
    memberSet: ReadonlyArray<EvidenceManifestEntry>;
  },
): Promise<{ archiveId: string; memberCount: number }> {
  const [owner] = await db
    .select()
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, input.resultAttemptId),
        eq(resultAttempts.resultId, input.resultId),
      ),
    )
    .limit(1);
  const [source] = await db
    .select()
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.id, input.sourceArtifactId),
        eq(solverEvidenceArtifacts.resultId, input.resultId),
        eq(solverEvidenceArtifacts.resultAttemptId, input.resultAttemptId),
      ),
    )
    .limit(1);
  const [manifest] = await db
    .select()
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.id, input.manifestArtifactId),
        eq(solverEvidenceArtifacts.resultId, input.resultId),
        eq(solverEvidenceArtifacts.resultAttemptId, input.resultAttemptId),
      ),
    )
    .limit(1);
  if (!owner || !source || !manifest) {
    throw new Error("brokered archive lacks one exact result-attempt owner");
  }
  if (
    source.kind !== "engine_bundle" ||
    source.storageKey !== input.identity.objectKey ||
    source.mimeType !== "application/zstd" ||
    source.sha256 !== input.identity.storedSha256 ||
    source.byteSize !== input.identity.storedByteSize
  ) {
    throw new Error("brokered archive source changed immutable GCS identity");
  }
  if (
    manifest.kind !== "manifest" ||
    manifest.sha256 !== input.identity.manifestSha256 ||
    manifest.byteSize !== input.identity.manifestByteSize
  ) {
    throw new Error("brokered archive manifest changed immutable identity");
  }
  const sameOwner = (
    artifact: typeof solverEvidenceArtifacts.$inferSelect,
  ): boolean =>
    artifact.airfoilId === source.airfoilId &&
    artifact.simJobId === source.simJobId &&
    artifact.engineJobId === source.engineJobId &&
    artifact.engineCaseSlug === source.engineCaseSlug &&
    artifact.methodKey === source.methodKey &&
    artifact.solverImplementationId === source.solverImplementationId &&
    artifact.solverRuntimeBuildId === source.solverRuntimeBuildId &&
    artifact.aoaDeg === source.aoaDeg;
  if (!sameOwner(manifest)) {
    throw new Error(
      "brokered manifest and bundle do not share one exact owner",
    );
  }
  if (!input.evidenceBase || input.evidenceBase.startsWith("/")) {
    throw new Error("brokered archive evidenceBase must be relative");
  }
  const manifestMembers = input.memberSet.filter(
    (member) => member.path === "evidence_manifest.json",
  );
  if (
    manifestMembers.length !== 1 ||
    manifestMembers[0]!.sha256 !== manifest.sha256 ||
    manifestMembers[0]!.byteSize !== manifest.byteSize ||
    input.memberSet.length !== input.identity.bundledFileCount + 1 ||
    new Set(input.memberSet.map((member) => member.path)).size !==
      input.memberSet.length
  ) {
    throw new Error("brokered archive member set does not match its manifest");
  }
  for (const member of input.memberSet) {
    if (member.path !== "evidence_manifest.json" && !member.role) {
      throw new Error(
        `brokered archive member ${member.path} lacks an exact evidence role`,
      );
    }
  }

  const blobValues = {
    backend: "gcs" as const,
    bucket: input.identity.bucket,
    objectKey: input.identity.objectKey,
    generation: input.identity.generation,
    compression: "zstd" as const,
    mimeType: "application/zstd",
    sha256: input.identity.storedSha256,
    byteSize: input.identity.storedByteSize,
    crc32c: input.identity.crc32c,
    uncompressedTarSha256: input.identity.tarSha256,
    uncompressedTarByteSize: input.identity.tarByteSize,
    verifiedAt: input.identity.verifiedAt,
    metadata: {
      archiveFormat: "tar+zstd",
      zstdLevel: input.identity.zstdLevel,
      manifestMemberCount: input.memberSet.length,
    },
  };
  const [insertedBlob] = await db
    .insert(solverEvidenceBlobs)
    .values(blobValues)
    .onConflictDoNothing()
    .returning();
  let blob = insertedBlob;
  if (!blob) {
    [blob] = await db
      .select()
      .from(solverEvidenceBlobs)
      .where(
        and(
          eq(solverEvidenceBlobs.backend, "gcs"),
          eq(solverEvidenceBlobs.bucket, input.identity.bucket),
          eq(solverEvidenceBlobs.objectKey, input.identity.objectKey),
          eq(solverEvidenceBlobs.generation, input.identity.generation),
        ),
      )
      .limit(1);
  }
  if (
    !blob ||
    blob.compression !== blobValues.compression ||
    blob.mimeType !== blobValues.mimeType ||
    blob.sha256 !== blobValues.sha256 ||
    blob.byteSize !== blobValues.byteSize ||
    blob.crc32c !== blobValues.crc32c ||
    blob.uncompressedTarSha256 !== blobValues.uncompressedTarSha256 ||
    blob.uncompressedTarByteSize !== blobValues.uncompressedTarByteSize ||
    exactJson(blob.metadata) !== exactJson(blobValues.metadata)
  ) {
    throw new Error("brokered GCS generation changed immutable blob metadata");
  }

  const [current] = await db
    .select()
    .from(solverEvidenceArchives)
    .where(
      and(
        eq(solverEvidenceArchives.resultAttemptId, input.resultAttemptId),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .limit(1);
  if (
    current &&
    (current.resultId !== input.resultId ||
      current.sourceArtifactId !== source.id ||
      current.blobId !== blob.id)
  ) {
    throw new Error(
      "exact attempt already owns a different current evidence archive",
    );
  }
  let archive = current;
  if (!archive) {
    [archive] = await db
      .insert(solverEvidenceArchives)
      .values({
        resultId: input.resultId,
        resultAttemptId: input.resultAttemptId,
        sourceArtifactId: source.id,
        blobId: blob.id,
        state: "current",
      })
      .returning();
  }
  if (!archive) throw new Error("failed to register brokered evidence archive");

  for (const member of input.memberSet) {
    let artifact =
      member.path === "evidence_manifest.json" ? manifest : undefined;
    if (!artifact) {
      const kind = artifactKindForManifestRole(member.role!);
      const storageKey = memberStorageKey(input.identity, member.path);
      const metadata = {
        evidenceBase: input.evidenceBase,
        archiveMemberPath: member.path,
        storageBackend: "gcs",
        bucket: input.identity.bucket,
        objectKey: input.identity.objectKey,
        generation: input.identity.generation,
        ...(member.role === "mesh_evidence"
          ? { engineArtifactKind: "mesh_evidence" }
          : {}),
      };
      [artifact] = await db
        .insert(solverEvidenceArtifacts)
        .values({
          resultId: input.resultId,
          resultAttemptId: input.resultAttemptId,
          airfoilId: source.airfoilId,
          simJobId: source.simJobId,
          engineJobId: source.engineJobId,
          engineCaseSlug: source.engineCaseSlug,
          methodKey: source.methodKey,
          solverImplementationId: source.solverImplementationId,
          solverRuntimeBuildId: source.solverRuntimeBuildId,
          aoaDeg: source.aoaDeg,
          kind,
          role: member.role!,
          storageKey,
          mimeType: mimeTypeForMember(member.path),
          sha256: member.sha256,
          byteSize: member.byteSize,
          metadata,
        })
        .onConflictDoNothing()
        .returning();
      if (!artifact) {
        [artifact] = await db
          .select()
          .from(solverEvidenceArtifacts)
          .where(
            and(
              eq(
                solverEvidenceArtifacts.resultAttemptId,
                input.resultAttemptId,
              ),
              eq(solverEvidenceArtifacts.kind, kind),
              eq(solverEvidenceArtifacts.storageKey, storageKey),
              eq(solverEvidenceArtifacts.sha256, member.sha256),
            ),
          )
          .limit(1);
      }
      if (
        !artifact ||
        artifact.resultId !== input.resultId ||
        artifact.resultAttemptId !== input.resultAttemptId ||
        artifact.role !== member.role ||
        artifact.byteSize !== member.byteSize ||
        artifact.mimeType !== mimeTypeForMember(member.path) ||
        exactJson(artifact.metadata) !== exactJson(metadata) ||
        !sameOwner(artifact)
      ) {
        throw new Error(
          `brokered archive member ${member.path} changed immutable metadata`,
        );
      }
    }
    const [insertedMember] = await db
      .insert(solverEvidenceArtifactMembers)
      .values({
        archiveId: archive.id,
        artifactId: artifact.id,
        memberPath: member.path,
      })
      .onConflictDoNothing()
      .returning({ archiveId: solverEvidenceArtifactMembers.archiveId });
    if (!insertedMember) {
      const [existingMember] = await db
        .select()
        .from(solverEvidenceArtifactMembers)
        .where(
          and(
            eq(solverEvidenceArtifactMembers.archiveId, archive.id),
            eq(solverEvidenceArtifactMembers.artifactId, artifact.id),
          ),
        )
        .limit(1);
      if (!existingMember || existingMember.memberPath !== member.path) {
        throw new Error(
          `brokered archive member ${member.path} conflicts with existing evidence`,
        );
      }
    }
  }
  const members = await db
    .select({ path: solverEvidenceArtifactMembers.memberPath })
    .from(solverEvidenceArtifactMembers)
    .where(eq(solverEvidenceArtifactMembers.archiveId, archive.id));
  if (
    members.length !== input.memberSet.length ||
    new Set(members.map((member) => member.path)).size !==
      input.memberSet.length
  ) {
    throw new Error("brokered archive database member coverage is incomplete");
  }
  return { archiveId: archive.id, memberCount: members.length };
}
