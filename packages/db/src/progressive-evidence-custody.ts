import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "./client";
import {
  solverEvidenceArchives,
  solverEvidenceArtifactMembers,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  syncBrokeredEvidenceUploads,
} from "./schema";
import {
  readProgressiveRemoteEvidenceReceipt,
  type ProgressiveRemoteEvidenceDelivery,
} from "./progressive-remote-evidence-receipts";
import {
  assertProgressiveReportedManifest,
  resolveProgressiveRemoteEvidence,
} from "./progressive-remote-evidence";

export interface ProgressiveEvidenceCustodyReceipt {
  schemaVersion: 1;
  kind: "hub-progressive-evidence-custody";
  source: ProgressiveRemoteEvidenceDelivery;
  brokeredUploadId: string;
  remote: {
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
  };
  canonical: {
    resultId: string;
    resultAttemptId: string;
    artifactId: string;
    archiveId: string;
  };
  boundAt: string;
}

function canonicalReceiptJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalReceiptJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalReceiptJson(record[key])}`)
    .join(",")}}`;
}

export function signProgressiveEvidenceCustodyReceipt(
  receipt: ProgressiveEvidenceCustodyReceipt,
  solverToken: string,
) {
  if (!solverToken)
    throw new Error("Custody receipt requires the solver credential");
  return {
    receipt,
    receiptHmac: createHmac("sha256", solverToken)
      .update("xfoilfoam-hub-progressive-evidence-custody-v1\n")
      .update(canonicalReceiptJson(receipt))
      .digest("hex"),
  };
}

export function verifyProgressiveEvidenceCustodyReceipt(
  signed: unknown,
  solverToken: string,
  expected: Pick<
    ProgressiveEvidenceCustodyReceipt,
    "source" | "brokeredUploadId" | "remote"
  >,
): ProgressiveEvidenceCustodyReceipt {
  if (!signed || typeof signed !== "object")
    throw new Error("Missing progressive archive custody receipt");
  const { receipt, receiptHmac } = signed as ReturnType<
    typeof signProgressiveEvidenceCustodyReceipt
  >;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "hub-progressive-evidence-custody" ||
    canonicalReceiptJson(receipt.source) !==
      canonicalReceiptJson(expected.source) ||
    receipt.brokeredUploadId !== expected.brokeredUploadId ||
    canonicalReceiptJson(receipt.remote) !==
      canonicalReceiptJson(expected.remote) ||
    !receipt.canonical ||
    ![
      receipt.canonical.resultId,
      receipt.canonical.resultAttemptId,
      receipt.canonical.artifactId,
      receipt.canonical.archiveId,
    ].every((value) => typeof value === "string" && uuid.test(value)) ||
    typeof receipt.boundAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.boundAt)) ||
    typeof receiptHmac !== "string" ||
    !/^[a-f0-9]{64}$/.test(receiptHmac)
  )
    throw new Error(
      "Progressive archive custody receipt does not match the exact delivery",
    );
  const actual = signProgressiveEvidenceCustodyReceipt(
    receipt,
    solverToken,
  ).receiptHmac;
  if (
    !timingSafeEqual(
      Buffer.from(actual, "hex"),
      Buffer.from(receiptHmac, "hex"),
    )
  )
    throw new Error("Progressive archive custody receipt signature is invalid");
  return receipt;
}

export async function readProgressiveEvidenceCustodyReceipt(
  db: DB,
  source: ProgressiveRemoteEvidenceDelivery,
  brokeredUploadId: string,
): Promise<ProgressiveEvidenceCustodyReceipt> {
  const retained = await readProgressiveRemoteEvidenceReceipt(db, source);
  if (!retained)
    throw new Error(
      "Archive custody requires the exact retained source attempt",
    );
  const [stored] = await db
    .select({
      upload: syncBrokeredEvidenceUploads,
      archive: solverEvidenceArchives,
      blob: solverEvidenceBlobs,
      artifact: solverEvidenceArtifacts,
    })
    .from(syncBrokeredEvidenceUploads)
    .innerJoin(
      solverEvidenceArchives,
      and(
        eq(
          solverEvidenceArchives.resultId,
          syncBrokeredEvidenceUploads.canonicalResultId,
        ),
        eq(
          solverEvidenceArchives.resultAttemptId,
          syncBrokeredEvidenceUploads.canonicalResultAttemptId,
        ),
        eq(
          solverEvidenceArchives.sourceArtifactId,
          syncBrokeredEvidenceUploads.canonicalArtifactId,
        ),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .innerJoin(
      solverEvidenceBlobs,
      eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
    )
    .innerJoin(
      solverEvidenceArtifacts,
      eq(solverEvidenceArtifacts.id, solverEvidenceArchives.sourceArtifactId),
    )
    .where(eq(syncBrokeredEvidenceUploads.id, brokeredUploadId));
  if (!stored)
    throw new Error("Archive custody requires a complete registered archive");
  const { upload, archive, blob, artifact } = stored;
  if (
    upload.state !== "bound" ||
    !upload.boundAt ||
    !upload.verifiedAt ||
    !upload.generation ||
    !upload.crc32c ||
    upload.solverId !== source.solverId ||
    upload.promiseId !== source.promiseId ||
    upload.engineJobId !== source.engineJobId ||
    upload.engineCaseSlug !== source.engineCaseSlug ||
    upload.aoaDeg !== source.aoaDeg ||
    upload.remoteResultId !== source.remoteResultId ||
    upload.remoteResultAttemptId !== source.remoteResultAttemptId ||
    upload.canonicalResultId !== retained.resultId ||
    upload.canonicalResultAttemptId !== retained.resultAttemptId ||
    blob.backend !== "gcs" ||
    blob.compression !== "zstd" ||
    blob.mimeType !== "application/zstd" ||
    !blob.verifiedAt ||
    blob.bucket !== upload.bucket ||
    blob.objectKey !== upload.objectKey ||
    blob.generation !== upload.generation ||
    blob.sha256 !== upload.storedSha256 ||
    blob.byteSize !== upload.storedByteSize ||
    blob.crc32c !== upload.crc32c ||
    blob.uncompressedTarSha256 !== upload.tarSha256 ||
    blob.uncompressedTarByteSize !== upload.tarByteSize ||
    artifact.kind !== "engine_bundle" ||
    artifact.storageKey !== upload.objectKey ||
    artifact.mimeType !== "application/zstd" ||
    artifact.sha256 !== upload.storedSha256 ||
    artifact.byteSize !== upload.storedByteSize
  )
    throw new Error(
      "Archive custody binding differs from its verified source or storage identity",
    );
  const reported = await resolveProgressiveRemoteEvidence(db, source);
  if (!reported)
    throw new Error("Archive custody source report is unavailable");
  assertProgressiveReportedManifest(reported, upload);
  const members = await db
    .select({
      member: solverEvidenceArtifactMembers,
      artifact: solverEvidenceArtifacts,
    })
    .from(solverEvidenceArtifactMembers)
    .innerJoin(
      solverEvidenceArtifacts,
      eq(solverEvidenceArtifacts.id, solverEvidenceArtifactMembers.artifactId),
    )
    .where(eq(solverEvidenceArtifactMembers.archiveId, archive.id));
  const manifests = members.filter(
    ({ member }) => member.memberPath === "evidence_manifest.json",
  );
  if (
    members.length !== upload.bundledFileCount + 1 ||
    manifests.length !== 1 ||
    manifests[0]!.artifact.kind !== "manifest" ||
    manifests[0]!.artifact.sha256 !== upload.manifestSha256 ||
    manifests[0]!.artifact.byteSize !== upload.manifestByteSize ||
    members.some(
      ({ artifact: member }) =>
        member.resultId !== retained.resultId ||
        member.resultAttemptId !== retained.resultAttemptId ||
        !member.sha256 ||
        !/^[a-f0-9]{64}$/i.test(member.sha256) ||
        !Number.isSafeInteger(member.byteSize) ||
        Number(member.byteSize) < 0,
    )
  )
    throw new Error(
      "Archive custody requires every authenticated manifest member",
    );
  return {
    schemaVersion: 1,
    kind: "hub-progressive-evidence-custody",
    source,
    brokeredUploadId,
    remote: {
      bucket: upload.bucket,
      objectKey: upload.objectKey,
      generation: upload.generation,
      crc32c: upload.crc32c,
      storedSha256: upload.storedSha256,
      storedByteSize: upload.storedByteSize,
      tarSha256: upload.tarSha256,
      tarByteSize: upload.tarByteSize,
      manifestSha256: upload.manifestSha256,
      manifestByteSize: upload.manifestByteSize,
      zstdLevel: upload.zstdLevel,
      bundledFileCount: upload.bundledFileCount,
    },
    canonical: {
      resultId: retained.resultId,
      resultAttemptId: retained.resultAttemptId,
      artifactId: artifact.id,
      archiveId: archive.id,
    },
    boundAt: upload.boundAt.toISOString(),
  };
}
