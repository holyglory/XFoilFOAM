import { and, eq, inArray } from "drizzle-orm";

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
type Artifact = typeof solverEvidenceArtifacts.$inferSelect;

// A logical artifact has many bound columns. Keep each VALUES statement well
// below the PostgreSQL parameter limit even for multi-thousand-file archives.
const MEMBER_BATCH_SIZE = 512;

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

interface ArchiveRegistration {
  resultId: string;
  resultAttemptId: string;
  sourceArtifactId: string;
  manifestArtifactId: string;
  evidenceBase: string;
  identity: VerifiedBrokeredArchiveIdentity;
  memberSet: ReadonlyArray<EvidenceManifestEntry>;
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

function sameOwner(artifact: Artifact, source: Artifact): boolean {
  return (
    artifact.resultId === source.resultId &&
    artifact.resultAttemptId === source.resultAttemptId &&
    artifact.airfoilId === source.airfoilId &&
    artifact.simJobId === source.simJobId &&
    artifact.engineJobId === source.engineJobId &&
    artifact.engineCaseSlug === source.engineCaseSlug &&
    artifact.methodKey === source.methodKey &&
    artifact.solverImplementationId === source.solverImplementationId &&
    artifact.solverRuntimeBuildId === source.solverRuntimeBuildId &&
    artifact.aoaDeg === source.aoaDeg
  );
}

function logicalMember(
  member: EvidenceManifestEntry,
  source: Artifact,
  evidenceBase: string,
  identity: VerifiedBrokeredArchiveIdentity,
) {
  return {
    resultId: source.resultId,
    resultAttemptId: source.resultAttemptId,
    airfoilId: source.airfoilId,
    simJobId: source.simJobId,
    engineJobId: source.engineJobId,
    engineCaseSlug: source.engineCaseSlug,
    methodKey: source.methodKey,
    solverImplementationId: source.solverImplementationId,
    solverRuntimeBuildId: source.solverRuntimeBuildId,
    aoaDeg: source.aoaDeg,
    kind: artifactKindForManifestRole(member.role!),
    role: member.role!,
    storageKey: memberStorageKey(identity, member.path),
    mimeType: mimeTypeForMember(member.path),
    sha256: member.sha256,
    byteSize: member.byteSize,
    metadata: {
      evidenceBase,
      archiveMemberPath: member.path,
      storageBackend: "gcs",
      bucket: identity.bucket,
      objectKey: identity.objectKey,
      generation: identity.generation,
      ...(member.role === "mesh_evidence"
        ? { engineArtifactKind: "mesh_evidence" }
        : {}),
    },
  };
}

type LogicalMember = ReturnType<typeof logicalMember>;

function matchesMember(
  row: Artifact,
  wanted: LogicalMember,
  source: Artifact,
): boolean {
  return (
    sameOwner(row, source) &&
    row.kind === wanted.kind &&
    row.role === wanted.role &&
    (row.field ?? "") === "" &&
    row.storageKey === wanted.storageKey &&
    row.sha256 === wanted.sha256 &&
    row.byteSize === wanted.byteSize &&
    row.mimeType === wanted.mimeType &&
    exactJson(row.metadata) === exactJson(wanted.metadata)
  );
}

async function registerMembers(
  db: DB,
  archiveId: string,
  existingArchive: boolean,
  source: Artifact,
  manifest: Artifact,
  input: ArchiveRegistration,
) {
  const expected = new Map(
    input.memberSet.map((member) => [
      member.path,
      member.path === "evidence_manifest.json"
        ? null
        : logicalMember(member, source, input.evidenceBase, input.identity),
    ]),
  );
  const ids = new Map<string, string>([
    ["evidence_manifest.json", manifest.id],
  ]);

  // The whole set (including any unexpected path) belongs to this archive.
  // Validate the actual linked rows both on replay and after inserting gaps.
  async function verifiedLinks() {
    const rows = await db
      .select({
        path: solverEvidenceArtifactMembers.memberPath,
        artifact: solverEvidenceArtifacts,
      })
      .from(solverEvidenceArtifactMembers)
      .innerJoin(
        solverEvidenceArtifacts,
        eq(
          solverEvidenceArtifacts.id,
          solverEvidenceArtifactMembers.artifactId,
        ),
      )
      .where(eq(solverEvidenceArtifactMembers.archiveId, archiveId))
      .limit(expected.size + 1);
    const paths = new Set<string>();
    for (const { path, artifact } of rows) {
      const wanted = expected.get(path);
      if (
        wanted === undefined ||
        paths.has(path) ||
        (ids.has(path) && ids.get(path) !== artifact.id)
      ) {
        throw new Error(
          `brokered archive member ${path} conflicts with existing evidence`,
        );
      }
      const matches = wanted
        ? matchesMember(artifact, wanted, source)
        : artifact.kind === "manifest" &&
          artifact.sha256 === manifest.sha256 &&
          artifact.byteSize === manifest.byteSize &&
          sameOwner(artifact, source);
      if (!matches) {
        throw new Error(
          `brokered archive member ${path} changed immutable metadata`,
        );
      }
      paths.add(path);
      ids.set(path, artifact.id);
    }
    return paths;
  }

  const existing = existingArchive ? await verifiedLinks() : new Set<string>();
  if (existing.size === expected.size) return existing.size;
  const missing = Array.from(expected).filter(([path]) => !existing.has(path));
  for (let offset = 0; offset < missing.length; offset += MEMBER_BATCH_SIZE) {
    const batch = missing.slice(offset, offset + MEMBER_BATCH_SIZE);
    const values = batch.flatMap(([, wanted]) => (wanted ? [wanted] : []));
    if (values.length) {
      const byKey = new Map(
        values.map((wanted) => [wanted.storageKey, wanted]),
      );
      const inserted = await db
        .insert(solverEvidenceArtifacts)
        .values(values)
        .onConflictDoNothing()
        .returning({
          id: solverEvidenceArtifacts.id,
          storageKey: solverEvidenceArtifacts.storageKey,
        });
      for (const artifact of inserted) {
        const wanted = byKey.get(artifact.storageKey)!;
        ids.set(wanted.metadata.archiveMemberPath, artifact.id);
        byKey.delete(artifact.storageKey);
      }
      if (byKey.size) {
        // A partial registration or concurrent insert may already own an
        // unlinked artifact. Reuse only the exact association on this attempt.
        const stored = await db
          .select()
          .from(solverEvidenceArtifacts)
          .where(
            and(
              eq(
                solverEvidenceArtifacts.resultAttemptId,
                input.resultAttemptId,
              ),
              inArray(solverEvidenceArtifacts.storageKey, [...byKey.keys()]),
            ),
          );
        for (const artifact of stored) {
          const wanted = byKey.get(artifact.storageKey)!;
          if (matchesMember(artifact, wanted, source))
            ids.set(wanted.metadata.archiveMemberPath, artifact.id);
        }
      }
    }
    const links = batch.map(([memberPath]) => {
      const artifactId = ids.get(memberPath);
      if (!artifactId)
        throw new Error(
          `brokered archive member ${memberPath} changed immutable metadata`,
        );
      return { archiveId, artifactId, memberPath };
    });
    await db
      .insert(solverEvidenceArtifactMembers)
      .values(links)
      .onConflictDoNothing();
  }
  const verified = await verifiedLinks();
  if (verified.size !== expected.size)
    throw new Error("brokered archive database member coverage is incomplete");
  return verified.size;
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
  input: ArchiveRegistration,
): Promise<{ archiveId: string; memberCount: number }> {
  const [owner] = await db
    .select({ id: resultAttempts.id })
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
  if (!sameOwner(manifest, source)) {
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

  const findCurrent = () =>
    db
      .select()
      .from(solverEvidenceArchives)
      .where(
        and(
          eq(solverEvidenceArchives.resultAttemptId, input.resultAttemptId),
          eq(solverEvidenceArchives.state, "current"),
        ),
      )
      .limit(1);
  let [archive] = await findCurrent();
  let created = false;
  if (!archive) {
    const [inserted] = await db
      .insert(solverEvidenceArchives)
      .values({
        resultId: input.resultId,
        resultAttemptId: input.resultAttemptId,
        sourceArtifactId: source.id,
        blobId: blob.id,
        state: "current",
      })
      .onConflictDoNothing()
      .returning();
    created = Boolean(inserted);
    archive = inserted ?? (await findCurrent())[0];
  }
  if (!archive) throw new Error("failed to register brokered evidence archive");
  if (
    archive.resultId !== input.resultId ||
    archive.sourceArtifactId !== source.id ||
    archive.blobId !== blob.id
  ) {
    throw new Error(
      "exact attempt already owns a different current evidence archive",
    );
  }

  const memberCount = await registerMembers(
    db,
    archive.id,
    !created,
    source,
    manifest,
    input,
  );
  return { archiveId: archive.id, memberCount };
}
