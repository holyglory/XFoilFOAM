import {
  type DB,
  resultAttempts,
  results,
  simJobs,
  solverEvidenceArchives,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  solverEvidenceIncompleteQuarantines,
} from "@aerodb/db";
import { and, count, eq, sql } from "drizzle-orm";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { makeContext } from "./config";
import { parseEvidenceManifest } from "./evidence-manifest";

export const INCOMPLETE_ARCHIVE_NAME =
  "incomplete_evidence_quarantine.tar.zst";
export const INCOMPLETE_POINTER_NAME =
  "incomplete_evidence_quarantine.remote.json";
export const INCOMPLETE_PACKAGE_MANIFEST_NAME =
  "incomplete_evidence_quarantine.manifest.json";
export const INCOMPLETE_RECEIPT_NAME =
  "incomplete_evidence_quarantine.receipt.json";
export const INCOMPLETE_DATABASE_ACK_NAME =
  "incomplete_evidence_quarantine.database.json";

const SHA256 = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC32C = /^[A-Za-z0-9+/]{6}==$/;
const OBJECT_PREFIX = "solver-evidence-partial/v1";

export interface IncompleteMemberIdentity {
  path: string;
  sha256: string;
  byteSize: number;
}

export type IncompleteMemberSource =
  | { kind: "local_raw"; sourcePath: string }
  | {
      kind: "corrupt_archive_member" | "sibling_archive_member";
      sourceArchiveSha256: string;
      memberPath: string;
    };

export interface IncompleteRetainedMember extends IncompleteMemberIdentity {
  packagePath: string;
  sources: IncompleteMemberSource[];
}

export interface IncompleteSourceArchive {
  role: "corrupt_original" | "recovery_sibling";
  jobId: string;
  evidencePath: string;
  path: string;
  compression: "gzip" | "zstd";
  sha256: string;
  byteSize: number;
  integrity: "truncated" | "verified_complete";
  packagePath?: string;
  readableTarByteSize?: number;
  terminalError?: string;
  uncompressedTarSha256?: string;
  uncompressedTarByteSize?: number;
}

interface ManifestIdentity {
  path: string;
  sha256: string;
  byteSize: number;
  memberSetSha256: string;
  memberCount: number;
  packagePath?: string;
}

export interface IncompleteEvidenceQuarantineReceipt {
  schemaVersion: 1;
  state: "awaiting_database_registration" | "complete";
  preservationKind: "incomplete_evidence_quarantine";
  jobId: string;
  evidencePath: string;
  archive: {
    path: typeof INCOMPLETE_ARCHIVE_NAME;
    storedSha256: string;
    storedByteSize: number;
    uncompressedTarSha256: string;
    uncompressedTarByteSize: number;
    zstdLevel: number;
  };
  remote: {
    schemaVersion: 1;
    format: "tar+zstd";
    bucket: string;
    objectKey: string;
    generation: string;
    storedSha256: string;
    storedSize: number;
    tarSha256: string;
    tarSize: number;
    crc32c: string;
    zstdLevel: number;
    createdAt: string;
  };
  originalManifest: ManifestIdentity & {
    path: "evidence_manifest.json";
    packagePath: "original/evidence_manifest.json";
  };
  packageManifest: ManifestIdentity & {
    path: typeof INCOMPLETE_PACKAGE_MANIFEST_NAME;
  };
  expectedMembers: IncompleteMemberIdentity[];
  retainedMembers: IncompleteRetainedMember[];
  missingMembers: IncompleteMemberIdentity[];
  packageMembers: IncompleteMemberIdentity[];
  sourceArchives: IncompleteSourceArchive[];
  verificationMode: string;
  verifiedAt: string;
  registrationReceipt?: { sha256: string; byteSize: number };
  databaseAcknowledgement?: IncompleteEvidenceQuarantineAck;
}

export interface IncompleteEvidenceQuarantineAck {
  schemaVersion: 1;
  state: "incomplete_quarantined";
  registrationKind: "incomplete_evidence_quarantine";
  quarantineReason: "terminal_uningested_incomplete_archive";
  jobId: string;
  evidencePath: string;
  storedSha256: string;
  generation: string;
  quarantineId: string;
  blobId: string;
  originalManifestSha256: string;
  originalManifestByteSize: number;
  expectedMemberSetSha256: string;
  expectedMemberCount: number;
  retainedMemberSetSha256: string;
  retainedMemberCount: number;
  missingMemberSetSha256: string;
  missingMemberCount: number;
  packageManifestSha256: string;
  packageManifestByteSize: number;
  packageMemberSetSha256: string;
  packageMemberCount: number;
  migrationReceiptSha256: string;
  migrationReceiptByteSize: number;
  quarantinedAt: string;
  resultId?: never;
  resultAttemptId?: never;
  sourceArtifactId?: never;
  archiveId?: never;
  aoaDeg?: never;
}

interface ReceiptDocument {
  receipt: IncompleteEvidenceQuarantineReceipt;
  bytes: Buffer;
  sha256: string;
  registrationReceiptSha256: string;
  registrationReceiptByteSize: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty exact string`);
  }
  return value;
}

function safeRelative(value: unknown, label: string): string {
  const text = exactString(value, label);
  if (
    text.startsWith("/") ||
    text.includes("\\") ||
    text.includes("\0") ||
    [...text].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    text.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return text;
}

function pattern(value: unknown, label: string, regex: RegExp): string {
  const text = exactString(value, label);
  if (!regex.test(text)) throw new Error(`${label} is malformed`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const text = exactString(value, label);
  const normalized = text.endsWith("Z")
    ? `${text.slice(0, -1)}+00:00`
    : text;
  const parsed = new Date(text);
  const offsetMatch = normalized.match(/([+-])(\d{2}):(\d{2})$/);
  const offsetMinutes = offsetMatch
    ? (offsetMatch[1] === "+" ? 1 : -1) *
      (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]))
    : null;
  if (
    !text.includes("T") ||
    !Number.isFinite(parsed.getTime()) ||
    offsetMinutes !== 0
  ) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return text;
}

function comparePaths(
  left: Pick<IncompleteMemberIdentity, "path">,
  right: Pick<IncompleteMemberIdentity, "path">,
): number {
  return Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}

export function incompleteMemberSetSha256(
  members: ReadonlyArray<IncompleteMemberIdentity>,
): string {
  const digest = createHash("sha256");
  for (const member of [...members].sort(comparePaths)) {
    digest.update(member.path);
    digest.update("\0");
    digest.update(member.sha256);
    digest.update("\0");
    digest.update(String(member.byteSize));
    digest.update("\n");
  }
  return digest.digest("hex");
}

function parseMember(value: unknown, label: string): IncompleteMemberIdentity {
  const row = object(value, label);
  return {
    path: safeRelative(row.path, `${label} path`),
    sha256: pattern(row.sha256, `${label} sha256`, SHA256),
    byteSize: nonNegativeInteger(row.byteSize, `${label} byteSize`),
  };
}

function parseMemberList(
  value: unknown,
  label: string,
): IncompleteMemberIdentity[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const members = value.map((entry, index) =>
    parseMember(entry, `${label} ${index}`),
  );
  const paths = new Set(members.map((member) => member.path));
  if (paths.size !== members.length) {
    throw new Error(`${label} contains duplicate paths`);
  }
  return members.sort(comparePaths);
}

function parseManifestIdentity(
  value: unknown,
  label: string,
  opts: { path: string; packagePath?: string },
): ManifestIdentity {
  const row = object(value, label);
  const path = safeRelative(row.path, `${label} path`);
  if (path !== opts.path) throw new Error(`${label} path must be ${opts.path}`);
  if (opts.packagePath != null) {
    const packagePath = safeRelative(row.packagePath, `${label} packagePath`);
    if (packagePath !== opts.packagePath) {
      throw new Error(`${label} packagePath must be ${opts.packagePath}`);
    }
  }
  return {
    path,
    ...(opts.packagePath == null ? {} : { packagePath: opts.packagePath }),
    sha256: pattern(row.sha256, `${label} sha256`, SHA256),
    byteSize: positiveInteger(row.byteSize, `${label} byteSize`),
    memberSetSha256: pattern(
      row.memberSetSha256,
      `${label} memberSetSha256`,
      SHA256,
    ),
    memberCount: positiveInteger(row.memberCount, `${label} memberCount`),
  };
}

function parseRetainedMembers(value: unknown): IncompleteRetainedMember[] {
  if (!Array.isArray(value)) throw new Error("retainedMembers must be an array");
  const members = value.map((entry, index) => {
    const row = object(entry, `retained member ${index}`);
    const identity = parseMember(row, `retained member ${index}`);
    const packagePath = safeRelative(
      row.packagePath,
      `retained member ${index} packagePath`,
    );
    if (packagePath !== `retained/${identity.path}`) {
      throw new Error(
        `retained member ${index} packagePath must be retained/${identity.path}`,
      );
    }
    if (!Array.isArray(row.sources) || row.sources.length === 0) {
      throw new Error(`retained member ${index} sources must be non-empty`);
    }
    const sources: IncompleteMemberSource[] = row.sources.map(
      (entry, sourceIndex) => {
        const source = object(
          entry,
          `retained member ${index} source ${sourceIndex}`,
        );
        const kind = source.kind;
        if (kind === "local_raw") {
          const sourcePath = safeRelative(
            source.sourcePath,
            `retained member ${index} source ${sourceIndex} sourcePath`,
          );
          if (sourcePath !== identity.path) {
            throw new Error(
              `retained member ${index} local sourcePath must equal its member path`,
            );
          }
          return {
            kind,
            sourcePath,
          };
        }
        if (
          kind !== "corrupt_archive_member" &&
          kind !== "sibling_archive_member"
        ) {
          throw new Error(
            `retained member ${index} source ${sourceIndex} kind is unsupported`,
          );
        }
        const memberPath = safeRelative(
          source.memberPath,
          `retained member ${index} source ${sourceIndex} memberPath`,
        );
        if (memberPath !== identity.path) {
          throw new Error(
            `retained member ${index} archive memberPath must equal its member path`,
          );
        }
        return {
          kind,
          sourceArchiveSha256: pattern(
            source.sourceArchiveSha256,
            `retained member ${index} source ${sourceIndex} sourceArchiveSha256`,
            SHA256,
          ),
          memberPath,
        };
      },
    );
    return { ...identity, packagePath, sources };
  });
  if (new Set(members.map((member) => member.path)).size !== members.length) {
    throw new Error("retainedMembers contains duplicate paths");
  }
  return members.sort(comparePaths);
}

function parseSourceArchives(value: unknown): IncompleteSourceArchive[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("sourceArchives must be a non-empty array");
  }
  const archives = value.map((entry, index) => {
    const row = object(entry, `source archive ${index}`);
    const role = row.role;
    if (role !== "corrupt_original" && role !== "recovery_sibling") {
      throw new Error(`source archive ${index} role is unsupported`);
    }
    const compression = row.compression;
    if (compression !== "gzip" && compression !== "zstd") {
      throw new Error(`source archive ${index} compression is unsupported`);
    }
    const integrity = row.integrity;
    if (integrity !== "truncated" && integrity !== "verified_complete") {
      throw new Error(`source archive ${index} integrity is unsupported`);
    }
    const archive: IncompleteSourceArchive = {
      role,
      jobId: safeRelative(row.jobId, `source archive ${index} jobId`),
      evidencePath: safeRelative(
        row.evidencePath,
        `source archive ${index} evidencePath`,
      ),
      path: safeRelative(row.path, `source archive ${index} path`),
      compression,
      sha256: pattern(row.sha256, `source archive ${index} sha256`, SHA256),
      byteSize: positiveInteger(
        row.byteSize,
        `source archive ${index} byteSize`,
      ),
      integrity,
    };
    if (row.packagePath != null) {
      archive.packagePath = safeRelative(
        row.packagePath,
        `source archive ${index} packagePath`,
      );
    }
    if (row.readableTarByteSize != null) {
      archive.readableTarByteSize = positiveInteger(
        row.readableTarByteSize,
        `source archive ${index} readableTarByteSize`,
      );
    }
    if (row.terminalError != null) {
      archive.terminalError = exactString(
        row.terminalError,
        `source archive ${index} terminalError`,
      );
    }
    const hasTarSha = row.uncompressedTarSha256 != null;
    const hasTarSize = row.uncompressedTarByteSize != null;
    if (hasTarSha !== hasTarSize) {
      throw new Error(
        `source archive ${index} uncompressed tar identity is incomplete`,
      );
    }
    if (hasTarSha) {
      archive.uncompressedTarSha256 = pattern(
        row.uncompressedTarSha256,
        `source archive ${index} uncompressedTarSha256`,
        SHA256,
      );
      archive.uncompressedTarByteSize = positiveInteger(
        row.uncompressedTarByteSize,
        `source archive ${index} uncompressedTarByteSize`,
      );
    }
    if (role === "corrupt_original") {
      if (
        compression !== "gzip" ||
        integrity !== "truncated" ||
        archive.packagePath !== "original/openfoam_evidence.tar.gz" ||
        archive.readableTarByteSize == null ||
        archive.terminalError == null
      ) {
        throw new Error(
          "corrupt original source requires gzip, truncated status, packagePath, readableTarByteSize and terminalError",
        );
      }
    } else if (
      integrity !== "verified_complete" ||
      archive.uncompressedTarSha256 == null ||
      archive.uncompressedTarByteSize == null
    ) {
      throw new Error(
        "recovery sibling source must be completely verified with an uncompressed tar identity",
      );
    }
    return archive;
  });
  if (archives.filter((archive) => archive.role === "corrupt_original").length !== 1) {
    throw new Error("sourceArchives must contain exactly one corrupt original");
  }
  if (new Set(archives.map((archive) => archive.sha256)).size !== archives.length) {
    throw new Error("sourceArchives contains duplicate SHA-256 identities");
  }
  return archives.sort((left, right) =>
    `${left.role}:${left.sha256}`.localeCompare(`${right.role}:${right.sha256}`),
  );
}

function parseBundledManifestMembers(
  bytes: Buffer,
  label: string,
  opts: { requireNoExcludes?: boolean } = {},
): IncompleteMemberIdentity[] {
  let parsed: ReturnType<typeof parseEvidenceManifest>;
  try {
    parsed = parseEvidenceManifest(bytes);
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error)}`);
  }
  if (opts.requireNoExcludes && parsed.bundleExcludes.length !== 0) {
    throw new Error(`${label} must not exclude package members`);
  }
  return parsed.bundled.sort(comparePaths);
}

function requireSameMembers(
  actual: ReadonlyArray<IncompleteMemberIdentity>,
  expected: ReadonlyArray<IncompleteMemberIdentity>,
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    incompleteMemberSetSha256(actual) !== incompleteMemberSetSha256(expected)
  ) {
    throw new Error(`${label} does not match its retained manifest`);
  }
}

export async function readIncompleteEvidenceQuarantineReceipt(
  receiptPath: string,
  mediaRoot: string,
): Promise<ReceiptDocument> {
  const bytes = await readFile(receiptPath);
  const raw = object(JSON.parse(bytes.toString("utf8")), "incomplete receipt");
  if (raw.schemaVersion !== 1) throw new Error("unsupported incomplete receipt schema");
  if (
    raw.state !== "awaiting_database_registration" &&
    raw.state !== "complete"
  ) {
    throw new Error("incomplete receipt is not database-registerable");
  }
  if (raw.preservationKind !== "incomplete_evidence_quarantine") {
    throw new Error("incomplete receipt has the wrong preservationKind");
  }
  const jobId = safeRelative(raw.jobId, "jobId");
  if (jobId.includes("/")) throw new Error("jobId must be one path segment");
  const evidencePath = safeRelative(raw.evidencePath, "evidencePath");
  const expectedReceiptPath = resolve(
    mediaRoot,
    "jobs",
    jobId,
    evidencePath,
    INCOMPLETE_RECEIPT_NAME,
  );
  if (resolve(receiptPath) !== expectedReceiptPath) {
    throw new Error("incomplete receipt path does not match its exact identity");
  }

  const archive = object(raw.archive, "archive");
  if (archive.path !== INCOMPLETE_ARCHIVE_NAME) {
    throw new Error(`archive path must be ${INCOMPLETE_ARCHIVE_NAME}`);
  }
  const remote = object(raw.remote, "remote");
  const storedSha256 = pattern(
    remote.storedSha256,
    "remote storedSha256",
    SHA256,
  );
  const objectKey = safeRelative(remote.objectKey, "remote objectKey");
  const requiredObjectKey = `${OBJECT_PREFIX}/sha256/${storedSha256.slice(0, 2)}/${storedSha256}.tar.zst`;
  if (objectKey !== requiredObjectKey) {
    throw new Error(`remote objectKey must be ${requiredObjectKey}`);
  }
  const parsedArchive = {
    path: INCOMPLETE_ARCHIVE_NAME,
    storedSha256: pattern(archive.storedSha256, "archive storedSha256", SHA256),
    storedByteSize: positiveInteger(
      archive.storedByteSize,
      "archive storedByteSize",
    ),
    uncompressedTarSha256: pattern(
      archive.uncompressedTarSha256,
      "archive uncompressedTarSha256",
      SHA256,
    ),
    uncompressedTarByteSize: positiveInteger(
      archive.uncompressedTarByteSize,
      "archive uncompressedTarByteSize",
    ),
    zstdLevel: positiveInteger(archive.zstdLevel, "archive zstdLevel"),
  } as const;
  if (remote.schemaVersion !== 1 || remote.format !== "tar+zstd") {
    throw new Error("remote pointer must be schema 1 tar+zstd");
  }
  const parsedRemote = {
    schemaVersion: 1 as const,
    format: "tar+zstd" as const,
    bucket: exactString(remote.bucket, "remote bucket"),
    objectKey,
    generation: pattern(remote.generation, "remote generation", GENERATION),
    storedSha256,
    storedSize: positiveInteger(remote.storedSize, "remote storedSize"),
    tarSha256: pattern(remote.tarSha256, "remote tarSha256", SHA256),
    tarSize: positiveInteger(remote.tarSize, "remote tarSize"),
    crc32c: pattern(remote.crc32c, "remote crc32c", CRC32C),
    zstdLevel: positiveInteger(remote.zstdLevel, "remote zstdLevel"),
    createdAt: isoTimestamp(remote.createdAt, "remote createdAt"),
  };
  if (
    parsedArchive.storedSha256 !== parsedRemote.storedSha256 ||
    parsedArchive.storedByteSize !== parsedRemote.storedSize ||
    parsedArchive.uncompressedTarSha256 !== parsedRemote.tarSha256 ||
    parsedArchive.uncompressedTarByteSize !== parsedRemote.tarSize ||
    parsedArchive.zstdLevel !== parsedRemote.zstdLevel
  ) {
    throw new Error("archive identity does not match remote pointer");
  }
  const configuredBucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
  if (!configuredBucket) {
    throw new Error("AIRFOILFOAM_EVIDENCE_BUCKET is required");
  }
  if (parsedRemote.bucket !== configuredBucket) {
    throw new Error("remote bucket does not match AIRFOILFOAM_EVIDENCE_BUCKET");
  }
  const pointerPath = join(dirname(receiptPath), INCOMPLETE_POINTER_NAME);
  const pointer = object(
    JSON.parse(await readFile(pointerPath, "utf8")),
    "incomplete remote pointer",
  );
  if (stableJson(pointer) !== stableJson(parsedRemote)) {
    throw new Error("retained remote pointer does not equal receipt.remote");
  }

  const originalManifest = parseManifestIdentity(
    raw.originalManifest,
    "originalManifest",
    {
      path: "evidence_manifest.json",
      packagePath: "original/evidence_manifest.json",
    },
  ) as IncompleteEvidenceQuarantineReceipt["originalManifest"];
  const packageManifest = parseManifestIdentity(
    raw.packageManifest,
    "packageManifest",
    { path: INCOMPLETE_PACKAGE_MANIFEST_NAME },
  ) as IncompleteEvidenceQuarantineReceipt["packageManifest"];
  const expectedMembers = parseMemberList(raw.expectedMembers, "expectedMembers");
  const retainedMembers = parseRetainedMembers(raw.retainedMembers);
  const missingMembers = parseMemberList(raw.missingMembers, "missingMembers");
  const packageMembers = parseMemberList(raw.packageMembers, "packageMembers");
  const sourceArchives = parseSourceArchives(raw.sourceArchives);

  for (const [label, identity, members] of [
    ["originalManifest", originalManifest, expectedMembers],
    ["packageManifest", packageManifest, packageMembers],
  ] as const) {
    if (
      identity.memberCount !== members.length ||
      identity.memberSetSha256 !== incompleteMemberSetSha256(members)
    ) {
      throw new Error(`${label} member identity mismatch`);
    }
  }
  const expectedByPath = new Map(expectedMembers.map((member) => [member.path, member]));
  const retainedPaths = new Set<string>();
  const packageByPath = new Map(packageMembers.map((member) => [member.path, member]));
  for (const member of retainedMembers) {
    const expected = expectedByPath.get(member.path);
    const packaged = packageByPath.get(member.packagePath);
    if (
      !expected ||
      expected.sha256 !== member.sha256 ||
      expected.byteSize !== member.byteSize ||
      !packaged ||
      packaged.sha256 !== member.sha256 ||
      packaged.byteSize !== member.byteSize
    ) {
      throw new Error(`retained member ${member.path} is not exact`);
    }
    retainedPaths.add(member.path);
  }
  const missingPaths = new Set<string>();
  for (const member of missingMembers) {
    const expected = expectedByPath.get(member.path);
    if (
      !expected ||
      expected.sha256 !== member.sha256 ||
      expected.byteSize !== member.byteSize ||
      retainedPaths.has(member.path)
    ) {
      throw new Error(`missing member ${member.path} is not an exact disjoint entry`);
    }
    missingPaths.add(member.path);
  }
  if (
    expectedMembers.some(
      (member) =>
        Number(retainedPaths.has(member.path)) +
          Number(missingPaths.has(member.path)) !==
        1,
    )
  ) {
    throw new Error("retained and missing members do not partition expectedMembers");
  }
  const sourceBySha = new Map(
    sourceArchives.map((source) => [source.sha256, source]),
  );
  for (const member of retainedMembers) {
    for (const source of member.sources) {
      if (source.kind === "local_raw") continue;
      const archiveSource = sourceBySha.get(source.sourceArchiveSha256);
      const expectedRole =
        source.kind === "corrupt_archive_member"
          ? "corrupt_original"
          : "recovery_sibling";
      if (!archiveSource || archiveSource.role !== expectedRole) {
        throw new Error(`retained member ${member.path} has foreign source provenance`);
      }
    }
  }
  const corrupt = sourceArchives.find(
    (source) => source.role === "corrupt_original",
  )!;
  if (
    corrupt.jobId !== jobId ||
    corrupt.evidencePath !== evidencePath ||
    !corrupt.packagePath
  ) {
    throw new Error("corrupt original source does not match the exact target");
  }
  const packagedCorrupt = packageByPath.get(corrupt.packagePath);
  const packagedOriginalManifest = packageByPath.get(
    originalManifest.packagePath,
  );
  if (
    !packagedCorrupt ||
    packagedCorrupt.sha256 !== corrupt.sha256 ||
    packagedCorrupt.byteSize !== corrupt.byteSize ||
    !packagedOriginalManifest ||
    packagedOriginalManifest.sha256 !== originalManifest.sha256 ||
    packagedOriginalManifest.byteSize !== originalManifest.byteSize
  ) {
    throw new Error("package omits exact corrupt archive or original manifest bytes");
  }
  const verificationMode = exactString(raw.verificationMode, "verificationMode");
  if (
    verificationMode !==
    `archive+manifest+all-members-restore:${packageMembers.length}`
  ) {
    throw new Error("verificationMode does not cover every package member");
  }

  const originalManifestBytes = await readFile(
    join(dirname(receiptPath), originalManifest.path),
  );
  if (
    createHash("sha256").update(originalManifestBytes).digest("hex") !==
      originalManifest.sha256 ||
    originalManifestBytes.byteLength !== originalManifest.byteSize
  ) {
    throw new Error("retained original manifest identity mismatch");
  }
  requireSameMembers(
    parseBundledManifestMembers(
      originalManifestBytes,
      "retained original manifest",
    ),
    expectedMembers,
    "expectedMembers",
  );
  const packageManifestBytes = await readFile(
    join(dirname(receiptPath), packageManifest.path),
  );
  if (
    createHash("sha256").update(packageManifestBytes).digest("hex") !==
      packageManifest.sha256 ||
    packageManifestBytes.byteLength !== packageManifest.byteSize
  ) {
    throw new Error("retained package manifest identity mismatch");
  }
  requireSameMembers(
    parseBundledManifestMembers(
      packageManifestBytes,
      "retained package manifest",
      { requireNoExcludes: true },
    ),
    packageMembers,
    "packageMembers",
  );

  const receipt: IncompleteEvidenceQuarantineReceipt = {
    schemaVersion: 1,
    state: raw.state,
    preservationKind: "incomplete_evidence_quarantine",
    jobId,
    evidencePath,
    archive: parsedArchive,
    remote: parsedRemote,
    originalManifest,
    packageManifest,
    expectedMembers,
    retainedMembers,
    missingMembers,
    packageMembers,
    sourceArchives,
    verificationMode,
    verifiedAt: isoTimestamp(raw.verifiedAt, "verifiedAt"),
  };
  let registrationReceiptSha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");
  let registrationReceiptByteSize = bytes.byteLength;
  if (raw.state === "complete") {
    const registrationReceipt = object(
      raw.registrationReceipt,
      "registrationReceipt",
    );
    registrationReceiptSha256 = pattern(
      registrationReceipt.sha256,
      "registrationReceipt sha256",
      SHA256,
    );
    registrationReceiptByteSize = positiveInteger(
      registrationReceipt.byteSize,
      "registrationReceipt byteSize",
    );
    receipt.registrationReceipt = {
      sha256: registrationReceiptSha256,
      byteSize: registrationReceiptByteSize,
    };
    receipt.databaseAcknowledgement = parseIncompleteAck(
      raw.databaseAcknowledgement,
    );
  } else if (
    raw.registrationReceipt != null ||
    raw.databaseAcknowledgement != null
  ) {
    throw new Error(
      "awaiting receipt must not contain final registration fields",
    );
  }
  return {
    receipt,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    registrationReceiptSha256,
    registrationReceiptByteSize,
  };
}

function exactEvidenceIdentity(receipt: IncompleteEvidenceQuarantineReceipt): {
  engineCaseSlug: string;
} {
  const parts = receipt.evidencePath.split("/");
  if (parts[0] !== "cases" || parts.length < 3) {
    throw new Error("evidencePath must be cases/<engine-case>/<evidence-base>");
  }
  const engineCaseSlug = safeRelative(parts[1], "engineCaseSlug");
  if (engineCaseSlug.includes("/")) throw new Error("engineCaseSlug must be one segment");
  return { engineCaseSlug };
}

async function exactContext(db: DB, receipt: IncompleteEvidenceQuarantineReceipt) {
  const jobs = await db
    .select()
    .from(simJobs)
    .where(eq(simJobs.engineJobId, receipt.jobId));
  if (jobs.length !== 1) {
    throw new Error(`incomplete receipt must resolve to one exact sim job; found ${jobs.length}`);
  }
  const simJob = jobs[0]!;
  if (!new Set(["done", "failed", "cancelled"]).has(simJob.status)) {
    throw new Error(`incomplete quarantine sim job is ${simJob.status}, not terminal`);
  }
  const { engineCaseSlug } = exactEvidenceIdentity(receipt);
  const base = `jobs/${receipt.jobId}/${receipt.evidencePath}/`;
  const exactArtifacts = await db
    .select({ id: solverEvidenceArtifacts.id })
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.engineJobId, receipt.jobId),
        sql`left(${solverEvidenceArtifacts.storageKey}, length(${base})) = ${base}`,
      ),
    )
    .limit(1);
  if (exactArtifacts.length) {
    throw new Error("exact evidence path already has canonical artifact ownership");
  }
  return { simJob, engineCaseSlug };
}

function requireBlobMatches(
  blob: typeof solverEvidenceBlobs.$inferSelect,
  receipt: IncompleteEvidenceQuarantineReceipt,
): void {
  if (
    blob.backend !== "gcs" ||
    blob.bucket !== receipt.remote.bucket ||
    blob.objectKey !== receipt.remote.objectKey ||
    blob.generation !== receipt.remote.generation ||
    blob.compression !== "zstd" ||
    blob.mimeType !== "application/zstd" ||
    blob.sha256 !== receipt.remote.storedSha256 ||
    blob.byteSize !== receipt.remote.storedSize ||
    blob.crc32c !== receipt.remote.crc32c ||
    blob.uncompressedTarSha256 !== receipt.remote.tarSha256 ||
    blob.uncompressedTarByteSize !== receipt.remote.tarSize
  ) {
    throw new Error("incomplete quarantine GCS blob conflicts with receipt");
  }
}

function parseIncompleteAck(value: unknown): IncompleteEvidenceQuarantineAck {
  const row = object(value, "incomplete database acknowledgement");
  const allowed = new Set([
    "schemaVersion",
    "state",
    "registrationKind",
    "quarantineReason",
    "jobId",
    "evidencePath",
    "storedSha256",
    "generation",
    "quarantineId",
    "blobId",
    "originalManifestSha256",
    "originalManifestByteSize",
    "expectedMemberSetSha256",
    "expectedMemberCount",
    "retainedMemberSetSha256",
    "retainedMemberCount",
    "missingMemberSetSha256",
    "missingMemberCount",
    "packageManifestSha256",
    "packageManifestByteSize",
    "packageMemberSetSha256",
    "packageMemberCount",
    "migrationReceiptSha256",
    "migrationReceiptByteSize",
    "quarantinedAt",
  ]);
  const actual = Object.keys(row);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    throw new Error("incomplete database acknowledgement has unknown or missing keys");
  }
  if (
    row.schemaVersion !== 1 ||
    row.state !== "incomplete_quarantined" ||
    row.registrationKind !== "incomplete_evidence_quarantine" ||
    row.quarantineReason !== "terminal_uningested_incomplete_archive"
  ) {
    throw new Error("incomplete database acknowledgement has the wrong contract");
  }
  return {
    schemaVersion: 1,
    state: "incomplete_quarantined",
    registrationKind: "incomplete_evidence_quarantine",
    quarantineReason: "terminal_uningested_incomplete_archive",
    jobId: safeRelative(row.jobId, "ack jobId"),
    evidencePath: safeRelative(row.evidencePath, "ack evidencePath"),
    storedSha256: pattern(row.storedSha256, "ack storedSha256", SHA256),
    generation: pattern(row.generation, "ack generation", GENERATION),
    quarantineId: pattern(
      row.quarantineId,
      "ack quarantineId",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ),
    blobId: pattern(
      row.blobId,
      "ack blobId",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ),
    originalManifestSha256: pattern(
      row.originalManifestSha256,
      "ack originalManifestSha256",
      SHA256,
    ),
    originalManifestByteSize: positiveInteger(
      row.originalManifestByteSize,
      "ack originalManifestByteSize",
    ),
    expectedMemberSetSha256: pattern(
      row.expectedMemberSetSha256,
      "ack expectedMemberSetSha256",
      SHA256,
    ),
    expectedMemberCount: positiveInteger(
      row.expectedMemberCount,
      "ack expectedMemberCount",
    ),
    retainedMemberSetSha256: pattern(
      row.retainedMemberSetSha256,
      "ack retainedMemberSetSha256",
      SHA256,
    ),
    retainedMemberCount: nonNegativeInteger(
      row.retainedMemberCount,
      "ack retainedMemberCount",
    ),
    missingMemberSetSha256: pattern(
      row.missingMemberSetSha256,
      "ack missingMemberSetSha256",
      SHA256,
    ),
    missingMemberCount: nonNegativeInteger(
      row.missingMemberCount,
      "ack missingMemberCount",
    ),
    packageManifestSha256: pattern(
      row.packageManifestSha256,
      "ack packageManifestSha256",
      SHA256,
    ),
    packageManifestByteSize: positiveInteger(
      row.packageManifestByteSize,
      "ack packageManifestByteSize",
    ),
    packageMemberSetSha256: pattern(
      row.packageMemberSetSha256,
      "ack packageMemberSetSha256",
      SHA256,
    ),
    packageMemberCount: positiveInteger(
      row.packageMemberCount,
      "ack packageMemberCount",
    ),
    migrationReceiptSha256: pattern(
      row.migrationReceiptSha256,
      "ack migrationReceiptSha256",
      SHA256,
    ),
    migrationReceiptByteSize: positiveInteger(
      row.migrationReceiptByteSize,
      "ack migrationReceiptByteSize",
    ),
    quarantinedAt: isoTimestamp(row.quarantinedAt, "ack quarantinedAt"),
  };
}

function ackFromRow(
  row: typeof solverEvidenceIncompleteQuarantines.$inferSelect,
  receipt: IncompleteEvidenceQuarantineReceipt,
): IncompleteEvidenceQuarantineAck {
  return {
    schemaVersion: 1,
    state: "incomplete_quarantined",
    registrationKind: "incomplete_evidence_quarantine",
    quarantineReason: "terminal_uningested_incomplete_archive",
    jobId: receipt.jobId,
    evidencePath: receipt.evidencePath,
    storedSha256: receipt.remote.storedSha256,
    generation: receipt.remote.generation,
    quarantineId: row.id,
    blobId: row.blobId,
    originalManifestSha256: row.originalManifestSha256,
    originalManifestByteSize: row.originalManifestByteSize,
    expectedMemberSetSha256: row.expectedMemberSetSha256,
    expectedMemberCount: row.expectedMemberCount,
    retainedMemberSetSha256: row.retainedMemberSetSha256,
    retainedMemberCount: row.retainedMemberCount,
    missingMemberSetSha256: row.missingMemberSetSha256,
    missingMemberCount: row.missingMemberCount,
    packageManifestSha256: row.packageManifestSha256,
    packageManifestByteSize: row.packageManifestByteSize,
    packageMemberSetSha256: row.packageMemberSetSha256,
    packageMemberCount: row.packageMemberCount,
    migrationReceiptSha256: row.migrationReceiptSha256,
    migrationReceiptByteSize: row.migrationReceiptByteSize,
    quarantinedAt: row.createdAt.toISOString(),
  };
}

function rowValues(
  document: ReceiptDocument,
  context: Awaited<ReturnType<typeof exactContext>>,
  blobId: string,
) {
  const { receipt } = document;
  const retainedIdentities = receipt.retainedMembers.map(
    ({ path, sha256, byteSize }) => ({ path, sha256, byteSize }),
  );
  return {
    simJobId: context.simJob.id,
    engineJobId: receipt.jobId,
    engineCaseSlug: context.engineCaseSlug,
    evidencePath: receipt.evidencePath,
    quarantineReason: "terminal_uningested_incomplete_archive" as const,
    blobId,
    originalManifestSha256: receipt.originalManifest.sha256,
    originalManifestByteSize: receipt.originalManifest.byteSize,
    expectedMemberSetSha256: incompleteMemberSetSha256(receipt.expectedMembers),
    expectedMemberCount: receipt.expectedMembers.length,
    retainedMemberSetSha256: incompleteMemberSetSha256(retainedIdentities),
    retainedMemberCount: receipt.retainedMembers.length,
    missingMemberSetSha256: incompleteMemberSetSha256(receipt.missingMembers),
    missingMemberCount: receipt.missingMembers.length,
    expectedMembers: receipt.expectedMembers,
    retainedMembers: receipt.retainedMembers,
    missingMembers: receipt.missingMembers,
    sourceArchives: receipt.sourceArchives,
    packageManifestSha256: receipt.packageManifest.sha256,
    packageManifestByteSize: receipt.packageManifest.byteSize,
    packageMemberSetSha256: incompleteMemberSetSha256(receipt.packageMembers),
    packageMemberCount: receipt.packageMembers.length,
    packageMembers: receipt.packageMembers,
    migrationReceiptSha256: document.registrationReceiptSha256,
    migrationReceiptByteSize: document.registrationReceiptByteSize,
    verificationMode: receipt.verificationMode,
    remoteVerifiedAt: new Date(receipt.verifiedAt),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireRowMatches(
  row: typeof solverEvidenceIncompleteQuarantines.$inferSelect,
  values: ReturnType<typeof rowValues>,
): void {
  for (const key of [
    "simJobId",
    "engineJobId",
    "engineCaseSlug",
    "evidencePath",
    "quarantineReason",
    "blobId",
    "originalManifestSha256",
    "originalManifestByteSize",
    "expectedMemberSetSha256",
    "expectedMemberCount",
    "retainedMemberSetSha256",
    "retainedMemberCount",
    "missingMemberSetSha256",
    "missingMemberCount",
    "packageManifestSha256",
    "packageManifestByteSize",
    "packageMemberSetSha256",
    "packageMemberCount",
    "migrationReceiptSha256",
    "migrationReceiptByteSize",
    "verificationMode",
  ] as const) {
    if (row[key] !== values[key]) {
      throw new Error(`existing incomplete quarantine conflicts with ${key}`);
    }
  }
  for (const key of [
    "expectedMembers",
    "retainedMembers",
    "missingMembers",
    "sourceArchives",
    "packageMembers",
  ] as const) {
    if (stableJson(row[key]) !== stableJson(values[key])) {
      throw new Error(`existing incomplete quarantine conflicts with ${key}`);
    }
  }
  if (row.remoteVerifiedAt.getTime() !== values.remoteVerifiedAt.getTime()) {
    throw new Error("existing incomplete quarantine conflicts with remoteVerifiedAt");
  }
}

async function ownershipCounts(db: DB) {
  const [[resultCount], [attemptCount], [artifactCount], [archiveCount]] =
    await Promise.all([
      db.select({ value: count() }).from(results),
      db.select({ value: count() }).from(resultAttempts),
      db.select({ value: count() }).from(solverEvidenceArtifacts),
      db.select({ value: count() }).from(solverEvidenceArchives),
    ]);
  return {
    results: resultCount!.value,
    attempts: attemptCount!.value,
    artifacts: artifactCount!.value,
    archives: archiveCount!.value,
  };
}

export async function planIncompleteEvidenceQuarantine(opts: {
  db: DB;
  document: ReceiptDocument;
}) {
  const context = await exactContext(opts.db, opts.document.receipt);
  const [existing] = await opts.db
    .select()
    .from(solverEvidenceIncompleteQuarantines)
    .where(
      and(
        eq(
          solverEvidenceIncompleteQuarantines.engineJobId,
          opts.document.receipt.jobId,
        ),
        eq(
          solverEvidenceIncompleteQuarantines.evidencePath,
          opts.document.receipt.evidencePath,
        ),
      ),
    )
    .limit(1);
  if (existing) {
    const [blob] = await opts.db
      .select()
      .from(solverEvidenceBlobs)
      .where(eq(solverEvidenceBlobs.id, existing.blobId))
      .limit(1);
    if (!blob) throw new Error("existing incomplete quarantine lost its blob");
    requireBlobMatches(blob, opts.document.receipt);
    requireRowMatches(existing, rowValues(opts.document, context, blob.id));
  }
  return {
    status: existing ? "already-incomplete-quarantined" : "planned-incomplete-quarantine",
    jobId: opts.document.receipt.jobId,
    simJobId: context.simJob.id,
    evidencePath: opts.document.receipt.evidencePath,
    retainedMemberCount: opts.document.receipt.retainedMembers.length,
    missingMemberCount: opts.document.receipt.missingMembers.length,
  };
}

export async function registerIncompleteEvidenceQuarantine(opts: {
  db: DB;
  receiptPath: string;
  mediaRoot: string;
  writeAck?: boolean;
}): Promise<IncompleteEvidenceQuarantineAck> {
  const document = await readIncompleteEvidenceQuarantineReceipt(
    opts.receiptPath,
    opts.mediaRoot,
  );
  const ackPath = join(dirname(opts.receiptPath), INCOMPLETE_DATABASE_ACK_NAME);
  let retainedAck: IncompleteEvidenceQuarantineAck | null = null;
  try {
    retainedAck = parseIncompleteAck(JSON.parse(await readFile(ackPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (document.receipt.state === "complete") {
    if (!retainedAck || !document.receipt.databaseAcknowledgement) {
      throw new Error("completed receipt has no database acknowledgement");
    }
    if (
      stableJson(retainedAck) !==
      stableJson(document.receipt.databaseAcknowledgement)
    ) {
      throw new Error("completed receipt embeds a conflicting acknowledgement");
    }
    if (
      retainedAck.migrationReceiptSha256 !==
        document.registrationReceiptSha256 ||
      retainedAck.migrationReceiptByteSize !==
        document.registrationReceiptByteSize
    ) {
      throw new Error("completed receipt has a conflicting pass-1 identity");
    }
  }

  const ack = await opts.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await tx.execute(
      sql.raw(`
        LOCK TABLE sim_jobs, results, result_attempts,
          solver_evidence_artifacts, solver_evidence_archives,
          solver_evidence_blobs, solver_evidence_incomplete_quarantines,
          solver_evidence_orphan_quarantines
        IN SHARE ROW EXCLUSIVE MODE
      `),
    );
    const before = await ownershipCounts(tx);
    const context = await exactContext(tx, document.receipt);

    const [existing] = await tx
      .select()
      .from(solverEvidenceIncompleteQuarantines)
      .where(
        and(
          eq(
            solverEvidenceIncompleteQuarantines.engineJobId,
            document.receipt.jobId,
          ),
          eq(
            solverEvidenceIncompleteQuarantines.evidencePath,
            document.receipt.evidencePath,
          ),
        ),
      )
      .limit(1);
    if (existing) {
      const [blob] = await tx
        .select()
        .from(solverEvidenceBlobs)
        .where(eq(solverEvidenceBlobs.id, existing.blobId))
        .limit(1);
      if (!blob) throw new Error("existing incomplete quarantine lost its blob");
      requireBlobMatches(blob, document.receipt);
      requireRowMatches(existing, rowValues(document, context, blob.id));
      const after = await ownershipCounts(tx);
      if (stableJson(before) !== stableJson(after)) {
        throw new Error("incomplete quarantine replay mutated solver ownership tables");
      }
      const replay = ackFromRow(existing, document.receipt);
      if (retainedAck && stableJson(retainedAck) !== stableJson(replay)) {
        throw new Error("retained acknowledgement conflicts with database truth");
      }
      return replay;
    }
    if (document.receipt.state === "complete" || retainedAck) {
      throw new Error(
        "database acknowledgement exists without its immutable quarantine row",
      );
    }

    const blobValues = {
      backend: "gcs" as const,
      bucket: document.receipt.remote.bucket,
      objectKey: document.receipt.remote.objectKey,
      generation: document.receipt.remote.generation,
      compression: "zstd" as const,
      mimeType: "application/zstd",
      sha256: document.receipt.remote.storedSha256,
      byteSize: document.receipt.remote.storedSize,
      crc32c: document.receipt.remote.crc32c,
      uncompressedTarSha256: document.receipt.remote.tarSha256,
      uncompressedTarByteSize: document.receipt.remote.tarSize,
      verifiedAt: new Date(document.receipt.verifiedAt),
      metadata: {
        preservationKind: "incomplete_evidence_quarantine",
        quarantineReason: "terminal_uningested_incomplete_archive",
        engineJobId: document.receipt.jobId,
        evidencePath: document.receipt.evidencePath,
        originalManifestSha256: document.receipt.originalManifest.sha256,
        packageManifestSha256: document.receipt.packageManifest.sha256,
        retainedMemberCount: document.receipt.retainedMembers.length,
        missingMemberCount: document.receipt.missingMembers.length,
      },
    };
    const [insertedBlob] = await tx
      .insert(solverEvidenceBlobs)
      .values(blobValues)
      .onConflictDoNothing()
      .returning();
    let blob = insertedBlob;
    if (!blob) {
      [blob] = await tx
        .select()
        .from(solverEvidenceBlobs)
        .where(
          and(
            eq(solverEvidenceBlobs.backend, "gcs"),
            eq(solverEvidenceBlobs.bucket, document.receipt.remote.bucket),
            eq(solverEvidenceBlobs.objectKey, document.receipt.remote.objectKey),
            eq(solverEvidenceBlobs.generation, document.receipt.remote.generation),
          ),
        )
        .limit(1);
    }
    if (!blob) throw new Error("failed to register incomplete quarantine blob");
    requireBlobMatches(blob, document.receipt);

    const [row] = await tx
      .insert(solverEvidenceIncompleteQuarantines)
      .values(rowValues(document, context, blob.id))
      .returning();
    if (!row) throw new Error("failed to register incomplete evidence quarantine");
    const after = await ownershipCounts(tx);
    if (stableJson(before) !== stableJson(after)) {
      throw new Error("incomplete quarantine mutated solver ownership tables");
    }
    return ackFromRow(row, document.receipt);
  });

  if (retainedAck && stableJson(retainedAck) !== stableJson(ack)) {
    throw new Error("retained acknowledgement conflicts with registration");
  }
  if (opts.writeAck !== false && !retainedAck) {
    await atomicWriteJson(ackPath, ack);
  }
  return ack;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${INCOMPLETE_DATABASE_ACK_NAME}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let execute = false;
  let jobId: string | null = null;
  let evidencePath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--execute") {
      if (execute) throw new Error("--execute may be supplied only once");
      execute = true;
      continue;
    }
    if (arg === "--job-id" || arg === "--evidence-path") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires one exact value`);
      }
      index += 1;
      if (arg === "--job-id") {
        if (jobId != null) throw new Error("--job-id may be supplied only once");
        jobId = safeRelative(value, "--job-id");
        if (jobId.includes("/")) throw new Error("--job-id must be one segment");
      } else {
        if (evidencePath != null) {
          throw new Error("--evidence-path may be supplied only once");
        }
        evidencePath = safeRelative(value, "--evidence-path");
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (jobId == null || evidencePath == null) {
    throw new Error("exactly one --job-id and --evidence-path are required");
  }
  const mediaRoot = resolve(process.env.MEDIA_DIR ?? "/data/airfoilfoam");
  const receiptPath = resolve(
    mediaRoot,
    "jobs",
    jobId,
    evidencePath,
    INCOMPLETE_RECEIPT_NAME,
  );
  const { db, sql: client } = makeContext();
  let failures = 0;
  try {
    try {
      const document = await readIncompleteEvidenceQuarantineReceipt(
        receiptPath,
        mediaRoot,
      );
      if (execute) {
        const output = await registerIncompleteEvidenceQuarantine({
          db,
          receiptPath,
          mediaRoot,
        });
        console.log(JSON.stringify({ status: output.state, ...output }));
      } else {
        const output = await planIncompleteEvidenceQuarantine({
          db,
          document,
        });
        console.log(JSON.stringify(output));
      }
    } catch (error) {
      failures += 1;
      console.error(
        JSON.stringify({
          status: "failed",
          receiptPath,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  } finally {
    await client.end();
  }
  console.error(
    JSON.stringify({
      mode: execute ? "execute" : "dry-run",
      processed: 1,
      failed: failures,
    }),
  );
  return failures ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}
