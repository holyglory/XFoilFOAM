import {
  type DB,
  resultAttempts,
  results,
  simJobs,
  solverEvidenceArchives,
  solverEvidenceArtifactMembers,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  solverEvidenceOrphanQuarantines,
} from "@aerodb/db";
import type {
  EngineClient,
  EngineEvidenceArtifact,
  PolarPoint,
} from "@aerodb/engine-client";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Dirent } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

import { makeContext } from "./config";
import {
  manifestMemberSetSha256,
  parseEvidenceManifest,
} from "./evidence-manifest";
import { registerEvidenceArtifacts } from "./ingest";

export const MIGRATION_RECEIPT_NAME = "storage_migration.json";
export const DATABASE_ACK_NAME = "storage_migration.database.json";
const SHA256 = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC32C = /^[A-Za-z0-9+/]{6}==$/;
const MEMBER_KINDS = new Set([
  "manifest",
  "vtk_window",
  "time_directory",
  "log",
  "force_coefficients",
  "mesh",
  "dictionary",
  "field_data",
]);

interface MigrationReceipt {
  schemaVersion: 1;
  state: "awaiting_database_registration" | "complete";
  jobId: string;
  evidencePath: string;
  archive: {
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
  sourceArchives: Array<{
    path: string;
    compression: "gzip" | "zstd";
    sha256: string;
    byteSize: number;
    uncompressedTarSha256?: string;
    uncompressedTarByteSize?: number;
  }>;
  verificationMode: string | null;
  verifiedAt: string | null;
}

export interface RegisteredEvidenceStorageDatabaseAck {
  schemaVersion: 1;
  state: "registered";
  jobId: string;
  evidencePath: string;
  storedSha256: string;
  generation: string;
  resultId: string;
  resultAttemptId: string;
  sourceArtifactId: string;
  archiveId: string;
  registeredAt: string;
  quarantineId?: never;
  blobId?: never;
}

export interface OrphanEvidenceStorageDatabaseAck {
  schemaVersion: 1;
  state: "quarantined";
  registrationKind: "orphan_evidence_quarantine";
  quarantineReason: "terminal_engine_evidence_not_ingested";
  jobId: string;
  evidencePath: string;
  storedSha256: string;
  generation: string;
  quarantineId: string;
  sourceArtifactId: string;
  blobId: string;
  manifestSha256: string;
  manifestByteSize: number;
  archiveMemberSetSha256: string;
  archiveMemberCount: number;
  migrationReceiptSha256: string;
  migrationReceiptByteSize: number;
  quarantinedAt: string;
  resultId?: never;
  resultAttemptId?: never;
  archiveId?: never;
  registeredAt?: never;
}

export type EvidenceStorageDatabaseAck =
  | RegisteredEvidenceStorageDatabaseAck
  | OrphanEvidenceStorageDatabaseAck;

interface MigrationReceiptDocument {
  receipt: MigrationReceipt;
  bytes: Buffer;
  sha256: string;
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

function pattern(value: unknown, label: string, regex: RegExp): string {
  const text = exactString(value, label);
  if (!regex.test(text)) throw new Error(`${label} is malformed`);
  return text;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const text = exactString(value, label);
  if (!Number.isFinite(new Date(text).getTime())) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return text;
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

function requireContentAddressedObjectKey(
  objectKey: string,
  storedSha256: string,
  label: string,
): void {
  const suffix = `sha256/${storedSha256.slice(0, 2)}/${storedSha256}.tar.zst`;
  if (objectKey !== suffix && !objectKey.endsWith(`/${suffix}`)) {
    throw new Error(`${label} must use the content-addressed ${suffix} form`);
  }
}

export function parseEvidenceMigrationReceipt(
  value: unknown,
  receiptPath: string,
  mediaRoot: string,
): MigrationReceipt {
  const raw = object(value, "migration receipt");
  if (raw.schemaVersion !== 1)
    throw new Error("unsupported migration receipt schema");
  if (
    raw.state !== "awaiting_database_registration" &&
    raw.state !== "complete"
  ) {
    throw new Error("migration receipt is not database-registerable");
  }
  const jobId = safeRelative(raw.jobId, "jobId");
  if (jobId.includes("/")) throw new Error("jobId must be one path segment");
  const evidencePath = safeRelative(raw.evidencePath, "evidencePath");
  const archive = object(raw.archive, "archive");
  const remote = object(raw.remote, "remote");
  const rawSources = raw.sourceArchives ?? [];
  if (!Array.isArray(rawSources)) {
    throw new Error("sourceArchives must be an array");
  }
  const sourceArchives = rawSources.map((value, index) => {
    const source = object(value, `source archive ${index}`);
    const compression = source.compression;
    if (compression !== "gzip" && compression !== "zstd") {
      throw new Error(`source archive ${index} compression is unsupported`);
    }
    const parsed: MigrationReceipt["sourceArchives"][number] = {
      path: safeRelative(source.path, `source archive ${index} path`),
      compression,
      sha256: pattern(source.sha256, `source archive ${index} sha256`, SHA256),
      byteSize: positiveSafeInteger(
        source.byteSize,
        `source archive ${index} byteSize`,
      ),
    };
    const hasTarSha = source.uncompressedTarSha256 != null;
    const hasTarSize = source.uncompressedTarByteSize != null;
    if (hasTarSha !== hasTarSize) {
      throw new Error(
        `source archive ${index} uncompressed tar identity is incomplete`,
      );
    }
    if (hasTarSha) {
      parsed.uncompressedTarSha256 = pattern(
        source.uncompressedTarSha256,
        `source archive ${index} uncompressedTarSha256`,
        SHA256,
      );
      parsed.uncompressedTarByteSize = positiveSafeInteger(
        source.uncompressedTarByteSize,
        `source archive ${index} uncompressedTarByteSize`,
      );
    }
    return parsed;
  });
  const remoteStoredSha256 = pattern(
    remote.storedSha256,
    "remote storedSha256",
    SHA256,
  );
  const remoteObjectKey = safeRelative(remote.objectKey, "remote objectKey");
  requireContentAddressedObjectKey(
    remoteObjectKey,
    remoteStoredSha256,
    "remote objectKey",
  );
  const parsed: MigrationReceipt = {
    schemaVersion: 1,
    state: raw.state,
    jobId,
    evidencePath,
    archive: {
      storedSha256: pattern(
        archive.storedSha256,
        "archive storedSha256",
        SHA256,
      ),
      storedByteSize: positiveSafeInteger(
        archive.storedByteSize,
        "archive storedByteSize",
      ),
      uncompressedTarSha256: pattern(
        archive.uncompressedTarSha256,
        "archive uncompressedTarSha256",
        SHA256,
      ),
      uncompressedTarByteSize: positiveSafeInteger(
        archive.uncompressedTarByteSize,
        "archive uncompressedTarByteSize",
      ),
      zstdLevel: positiveSafeInteger(archive.zstdLevel, "archive zstdLevel"),
    },
    remote: {
      schemaVersion:
        remote.schemaVersion === 1
          ? 1
          : (() => {
              throw new Error("unsupported remote pointer schema");
            })(),
      format:
        remote.format === "tar+zstd"
          ? "tar+zstd"
          : (() => {
              throw new Error("remote format must be tar+zstd");
            })(),
      bucket: exactString(remote.bucket, "remote bucket"),
      objectKey: remoteObjectKey,
      generation: pattern(remote.generation, "remote generation", GENERATION),
      storedSha256: remoteStoredSha256,
      storedSize: positiveSafeInteger(remote.storedSize, "remote storedSize"),
      tarSha256: pattern(remote.tarSha256, "remote tarSha256", SHA256),
      tarSize: positiveSafeInteger(remote.tarSize, "remote tarSize"),
      crc32c: pattern(remote.crc32c, "remote crc32c", CRC32C),
      zstdLevel: positiveSafeInteger(remote.zstdLevel, "remote zstdLevel"),
      createdAt: exactString(remote.createdAt, "remote createdAt"),
    },
    sourceArchives,
    verificationMode:
      raw.verificationMode == null
        ? null
        : exactString(raw.verificationMode, "verificationMode"),
    verifiedAt:
      raw.verifiedAt == null
        ? null
        : isoTimestamp(raw.verifiedAt, "verifiedAt"),
  };
  if (!Number.isFinite(new Date(parsed.remote.createdAt).getTime())) {
    throw new Error("remote createdAt must be an ISO timestamp");
  }
  if (
    parsed.archive.storedSha256 !== parsed.remote.storedSha256 ||
    parsed.archive.storedByteSize !== parsed.remote.storedSize ||
    parsed.archive.uncompressedTarSha256 !== parsed.remote.tarSha256 ||
    parsed.archive.uncompressedTarByteSize !== parsed.remote.tarSize ||
    parsed.archive.zstdLevel !== parsed.remote.zstdLevel
  ) {
    throw new Error("receipt archive does not match its remote pointer");
  }
  const expectedPath = resolve(
    mediaRoot,
    "jobs",
    parsed.jobId,
    parsed.evidencePath,
    MIGRATION_RECEIPT_NAME,
  );
  if (resolve(receiptPath) !== expectedPath) {
    throw new Error(
      "migration receipt path does not match its job/evidence identity",
    );
  }
  return parsed;
}

async function readReceiptDocument(
  receiptPath: string,
  mediaRoot: string,
): Promise<MigrationReceiptDocument> {
  const bytes = await readFile(receiptPath);
  const raw = JSON.parse(bytes.toString("utf8"));
  return {
    receipt: parseEvidenceMigrationReceipt(raw, receiptPath, mediaRoot),
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sourceKeys(receipt: MigrationReceipt): string[] {
  const base = `jobs/${receipt.jobId}/${receipt.evidencePath}`;
  return [
    `${base}/engine_evidence.tar.zst`,
    `${base}/engine_evidence.tar.gz`,
    `${base}/openfoam_evidence.tar.gz`,
  ];
}

function evidenceBaseOf(
  row: typeof solverEvidenceArtifacts.$inferSelect,
  receipt: MigrationReceipt,
): string {
  const evidenceBase = safeRelative(
    row.metadata?.evidenceBase,
    "source artifact evidenceBase",
  );
  if (
    receipt.evidencePath !== evidenceBase &&
    !receipt.evidencePath.endsWith(`/${evidenceBase}`)
  ) {
    throw new Error("receipt evidence path does not own source evidenceBase");
  }
  return evidenceBase;
}

function memberPathOf(
  row: typeof solverEvidenceArtifacts.$inferSelect,
  receipt: MigrationReceipt,
): string {
  const baseParts = evidenceBaseOf(row, receipt).split("/");
  const storedParts = safeRelative(
    row.storageKey,
    "stored artifact path",
  ).split("/");
  const offsets: number[] = [];
  for (let index = 0; index <= storedParts.length - baseParts.length; index++) {
    if (
      baseParts.every((part, offset) => storedParts[index + offset] === part)
    ) {
      offsets.push(index);
    }
  }
  if (offsets.length !== 1) {
    throw new Error(
      "stored evidence artifact path does not identify one unambiguous evidenceBase",
    );
  }
  const memberParts = storedParts.slice(offsets[0] + baseParts.length);
  if (!memberParts.length) {
    throw new Error("stored evidence artifact path names evidenceBase itself");
  }
  return memberParts.join("/");
}

interface ManifestValidation {
  expected: Array<typeof solverEvidenceArtifacts.$inferSelect>;
  memberPaths: Map<string, string>;
}

async function validateManifestArtifacts(
  db: DB,
  receipt: MigrationReceipt,
  receiptPath: string,
  resultId: string,
  resultAttemptId: string,
): Promise<ManifestValidation> {
  const artifacts = await db
    .select()
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, resultId),
        eq(solverEvidenceArtifacts.resultAttemptId, resultAttemptId),
      ),
    );
  const owned = artifacts.filter((artifact) => {
    if (artifact.metadata?.evidenceBase == null) return false;
    return evidenceBaseOf(artifact, receipt) === artifact.metadata.evidenceBase;
  });
  const manifestPath = join(dirname(receiptPath), "evidence_manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const manifestArtifact = owned.filter(
    (artifact) => artifact.kind === "manifest",
  );
  if (manifestArtifact.length !== 1) {
    throw new Error(
      `database must contain one exact manifest artifact; found ${manifestArtifact.length}`,
    );
  }
  if (
    manifestArtifact[0].sha256 !== manifestSha256 ||
    manifestArtifact[0].byteSize !== manifestBytes.byteLength
  ) {
    throw new Error(
      "database manifest artifact checksum or byte size does not match retained evidence_manifest.json",
    );
  }

  const parsed = parseEvidenceManifest(manifestBytes);
  const artifactsByMember = new Map<
    string,
    Array<typeof solverEvidenceArtifacts.$inferSelect>
  >();
  for (const artifact of owned) {
    if (
      artifact.kind === "engine_bundle" ||
      artifact.kind === "openfoam_bundle"
    ) {
      continue;
    }
    const memberPath = memberPathOf(artifact, receipt);
    const rows = artifactsByMember.get(memberPath) ?? [];
    rows.push(artifact);
    artifactsByMember.set(memberPath, rows);
  }
  const expected: Array<typeof solverEvidenceArtifacts.$inferSelect> = [];
  const memberPaths = new Map<string, string>();
  for (const entry of parsed.memberSet) {
    const matches = artifactsByMember.get(entry.path) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `database must contain exactly one artifact for bundled manifest member ${entry.path}; found ${matches.length}`,
      );
    }
    const artifact = matches[0]!;
    if (!MEMBER_KINDS.has(artifact.kind)) {
      throw new Error(
        `bundled manifest member ${entry.path} has non-archive artifact kind ${artifact.kind}`,
      );
    }
    if (
      artifact.sha256 !== entry.sha256 ||
      artifact.byteSize !== entry.byteSize
    ) {
      throw new Error(
        `database artifact ${artifact.id} does not match manifest member ${entry.path}`,
      );
    }
    expected.push(artifact);
    const memberPath = entry.path;
    memberPaths.set(artifact.id, memberPath);
  }
  for (const entry of parsed.excluded) {
    const matches = artifactsByMember.get(entry.path) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `database must contain exactly one separately stored artifact for excluded manifest member ${entry.path}; found ${matches.length}`,
      );
    }
    const artifact = matches[0]!;
    if (
      artifact.sha256 !== entry.sha256 ||
      artifact.byteSize !== entry.byteSize
    ) {
      throw new Error(
        `excluded database artifact ${artifact.id} does not match manifest member ${entry.path}`,
      );
    }
  }
  const allowedMemberPaths = new Set(
    parsed.memberSet.map((entry) => entry.path),
  );
  for (const artifact of owned.filter((row) => MEMBER_KINDS.has(row.kind))) {
    const memberPath = memberPathOf(artifact, receipt);
    if (!allowedMemberPaths.has(memberPath)) {
      throw new Error(
        `database archive artifact ${artifact.id} is not a bundled manifest member (${memberPath})`,
      );
    }
  }
  return { expected, memberPaths };
}

async function exactSourceRows(db: DB, receipt: MigrationReceipt) {
  return db
    .select()
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.engineJobId, receipt.jobId),
        inArray(solverEvidenceArtifacts.storageKey, sourceKeys(receipt)),
        inArray(solverEvidenceArtifacts.kind, [
          "engine_bundle",
          "openfoam_bundle",
        ]),
      ),
    );
}

async function findExactSource(db: DB, receipt: MigrationReceipt) {
  const rows = await exactSourceRows(db, receipt);
  const owned = rows.filter(
    (row) => row.resultId && row.resultAttemptId && row.simJobId,
  );
  const owners = new Set(
    owned.map(
      (row) => `${row.resultId}:${row.resultAttemptId}:${row.simJobId}`,
    ),
  );
  if (owners.size !== 1) {
    throw new Error(
      `receipt must resolve to one exact result attempt; found ${owners.size}`,
    );
  }
  const canonicalKey = sourceKeys(receipt)[0];
  const source =
    owned.find(
      (row) =>
        row.storageKey === canonicalKey &&
        row.kind === "engine_bundle" &&
        row.sha256 === receipt.remote.storedSha256,
    ) ??
    owned.find((row) => row.kind === "engine_bundle") ??
    owned.find((row) => row.kind === "openfoam_bundle");
  if (!source) throw new Error("receipt has no exact bundle source artifact");
  if (source.aoaDeg == null || !Number.isFinite(source.aoaDeg)) {
    throw new Error("source artifact has no exact AoA");
  }
  if (!source.engineCaseSlug)
    throw new Error("source artifact has no case slug");
  evidenceBaseOf(source, receipt);
  return source;
}

function exactEvidencePathIdentity(receipt: MigrationReceipt): {
  engineCaseSlug: string;
  evidenceBase: string;
} {
  const parts = receipt.evidencePath.split("/");
  if (parts[0] !== "cases" || parts.length < 3) {
    throw new Error(
      "orphan evidence path must be cases/<exact-case-slug>/<evidence-base>",
    );
  }
  const engineCaseSlug = safeRelative(parts[1], "engine case slug");
  if (engineCaseSlug.includes("/")) {
    throw new Error("engine case slug must be one path segment");
  }
  const evidenceBase = safeRelative(
    parts.slice(2).join("/"),
    "orphan evidence base",
  );
  return { engineCaseSlug, evidenceBase };
}

interface OrphanManifestProvenance {
  manifestSha256: string;
  manifestByteSize: number;
  archiveMembers: Array<{ path: string; sha256: string; byteSize: number }>;
  archiveMemberSetSha256: string;
}

async function orphanManifestProvenance(
  receipt: MigrationReceipt,
  receiptPath: string,
): Promise<OrphanManifestProvenance> {
  if (!receipt.sourceArchives.length) {
    throw new Error(
      "orphan quarantine requires exact retained source archive provenance",
    );
  }
  const manifestBytes = await readFile(
    join(dirname(receiptPath), "evidence_manifest.json"),
  );
  const parsed = parseEvidenceManifest(manifestBytes);
  const expectedVerification = `archive+manifest+all-members-restore:${parsed.bundled.length}`;
  if (receipt.verificationMode !== expectedVerification) {
    throw new Error(
      `orphan receipt must prove ${expectedVerification}; got ${receipt.verificationMode ?? "none"}`,
    );
  }
  if (!receipt.verifiedAt) {
    throw new Error(
      "orphan receipt lacks the remote all-member verification time",
    );
  }
  return {
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    manifestByteSize: manifestBytes.byteLength,
    archiveMembers: parsed.memberSet,
    archiveMemberSetSha256: manifestMemberSetSha256(parsed.memberSet),
  };
}

function orphanAckFromRow(
  row: typeof solverEvidenceOrphanQuarantines.$inferSelect,
  receipt: MigrationReceipt,
): OrphanEvidenceStorageDatabaseAck {
  return {
    schemaVersion: 1,
    state: "quarantined",
    registrationKind: "orphan_evidence_quarantine",
    quarantineReason: "terminal_engine_evidence_not_ingested",
    jobId: receipt.jobId,
    evidencePath: receipt.evidencePath,
    storedSha256: receipt.remote.storedSha256,
    generation: receipt.remote.generation,
    quarantineId: row.id,
    sourceArtifactId: row.sourceArtifactId,
    blobId: row.blobId,
    manifestSha256: row.manifestSha256,
    manifestByteSize: row.manifestByteSize,
    archiveMemberSetSha256: row.archiveMemberSetSha256,
    archiveMemberCount: row.archiveMemberCount,
    migrationReceiptSha256: row.migrationReceiptSha256,
    migrationReceiptByteSize: row.migrationReceiptByteSize,
    quarantinedAt: row.createdAt.toISOString(),
  };
}

function requireOrphanRowMatchesReceipt(
  row: typeof solverEvidenceOrphanQuarantines.$inferSelect,
  receipt: MigrationReceipt,
  provenance: OrphanManifestProvenance,
): void {
  if (
    row.engineJobId !== receipt.jobId ||
    row.evidencePath !== receipt.evidencePath ||
    row.manifestSha256 !== provenance.manifestSha256 ||
    row.manifestByteSize !== provenance.manifestByteSize ||
    row.archiveMemberSetSha256 !== provenance.archiveMemberSetSha256 ||
    row.archiveMemberCount !== provenance.archiveMembers.length ||
    manifestMemberSetSha256(row.archiveMembers) !==
      provenance.archiveMemberSetSha256
  ) {
    throw new Error(
      "existing orphan quarantine conflicts with migration receipt",
    );
  }
}

async function exactOrphanOwnerContext(
  db: DB,
  receipt: MigrationReceipt,
): Promise<{
  simJob: typeof simJobs.$inferSelect;
  engineCaseSlug: string;
  evidenceBase: string;
}> {
  const { engineCaseSlug, evidenceBase } = exactEvidencePathIdentity(receipt);
  const jobs = await db
    .select()
    .from(simJobs)
    .where(eq(simJobs.engineJobId, receipt.jobId));
  if (jobs.length !== 1) {
    throw new Error(
      `orphan receipt must resolve to one exact sim job; found ${jobs.length}`,
    );
  }
  const simJob = jobs[0]!;
  if (!new Set<string>(["done", "failed", "cancelled"]).has(simJob.status)) {
    throw new Error(`orphan sim job is ${simJob.status}, not terminal`);
  }

  const [attemptOwner, resultOwner] = await Promise.all([
    db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.simJobId, simJob.id),
          eq(resultAttempts.engineJobId, receipt.jobId),
          eq(resultAttempts.engineCaseSlug, engineCaseSlug),
        ),
      )
      .limit(1),
    db
      .select({ id: results.id })
      .from(results)
      .where(
        and(
          eq(results.simJobId, simJob.id),
          eq(results.engineJobId, receipt.jobId),
          eq(results.engineCaseSlug, engineCaseSlug),
        ),
      )
      .limit(1),
  ]);
  if (attemptOwner.length || resultOwner.length) {
    throw new Error(
      "exact result ownership exists; receipt cannot use orphan quarantine",
    );
  }
  return { simJob, engineCaseSlug, evidenceBase };
}

function requireOrphanBlobMatches(
  blob: typeof solverEvidenceBlobs.$inferSelect,
  receipt: MigrationReceipt,
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
    throw new Error(
      "orphan quarantine GCS blob conflicts with migration receipt",
    );
  }
}

function requireOrphanArtifactMatches(
  artifact: typeof solverEvidenceArtifacts.$inferSelect,
  receipt: MigrationReceipt,
  context: Awaited<ReturnType<typeof exactOrphanOwnerContext>>,
  blob: typeof solverEvidenceBlobs.$inferSelect,
): void {
  const metadata = artifact.metadata ?? {};
  if (
    artifact.resultId !== null ||
    artifact.resultAttemptId !== null ||
    artifact.aoaDeg !== null ||
    artifact.airfoilId !== context.simJob.airfoilId ||
    artifact.simJobId !== context.simJob.id ||
    artifact.engineJobId !== receipt.jobId ||
    artifact.engineCaseSlug !== context.engineCaseSlug ||
    artifact.methodKey !== context.simJob.methodKey ||
    artifact.solverImplementationId !== context.simJob.solverImplementationId ||
    artifact.solverRuntimeBuildId !== context.simJob.solverRuntimeBuildId ||
    artifact.kind !== "engine_bundle" ||
    artifact.storageKey !== sourceKeys(receipt)[0] ||
    artifact.mimeType !== "application/zstd" ||
    artifact.sha256 !== blob.sha256 ||
    artifact.byteSize !== blob.byteSize ||
    metadata.evidenceBase !== context.evidenceBase ||
    metadata.storageBackend !== "gcs" ||
    metadata.bucket !== receipt.remote.bucket ||
    metadata.objectKey !== receipt.remote.objectKey ||
    metadata.generation !== receipt.remote.generation ||
    metadata.crc32c !== receipt.remote.crc32c ||
    metadata.uncompressedTarSha256 !== receipt.remote.tarSha256 ||
    metadata.uncompressedTarByteSize !== receipt.remote.tarSize
  ) {
    throw new Error(
      "orphan quarantine source artifact conflicts with exact job/path/blob provenance",
    );
  }
}

async function registerOrphanEvidenceQuarantine(opts: {
  db: DB;
  engine: EngineClient;
  document: MigrationReceiptDocument;
  receiptPath: string;
}): Promise<OrphanEvidenceStorageDatabaseAck> {
  const { receipt } = opts.document;
  const provenance = await orphanManifestProvenance(receipt, opts.receiptPath);
  return opts.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // This one-time backfill takes a short table-level writer fence so a
    // concurrent delayed ingest cannot create an exact result owner between
    // the zero-owner check and quarantine insert.  No aerodynamic lookup or
    // rounded AoA participates in the decision.
    await tx.execute(
      sql.raw(`
      LOCK TABLE sim_jobs, results, result_attempts,
        solver_evidence_artifacts, solver_evidence_blobs,
        solver_evidence_orphan_quarantines
      IN SHARE ROW EXCLUSIVE MODE
    `),
    );

    const sourceRows = await exactSourceRows(tx, receipt);
    const owned = sourceRows.filter(
      (row) => row.resultId || row.resultAttemptId,
    );
    if (owned.length) {
      throw new Error(
        `orphan fallback requires zero exact source owners; found ${owned.length}`,
      );
    }
    const context = await exactOrphanOwnerContext(tx, receipt);
    const [existing] = await tx
      .select()
      .from(solverEvidenceOrphanQuarantines)
      .where(
        and(
          eq(solverEvidenceOrphanQuarantines.engineJobId, receipt.jobId),
          eq(
            solverEvidenceOrphanQuarantines.evidencePath,
            receipt.evidencePath,
          ),
        ),
      )
      .limit(1);
    if (existing) {
      requireOrphanRowMatchesReceipt(existing, receipt, provenance);
      const [[blob], [artifact]] = await Promise.all([
        tx
          .select()
          .from(solverEvidenceBlobs)
          .where(eq(solverEvidenceBlobs.id, existing.blobId))
          .limit(1),
        tx
          .select()
          .from(solverEvidenceArtifacts)
          .where(eq(solverEvidenceArtifacts.id, existing.sourceArtifactId))
          .limit(1),
      ]);
      if (!blob || !artifact) {
        throw new Error("existing orphan quarantine lost its blob or artifact");
      }
      requireOrphanBlobMatches(blob, receipt);
      requireOrphanArtifactMatches(artifact, receipt, context, blob);
      return orphanAckFromRow(existing, receipt);
    }

    const blobValues = {
      backend: "gcs" as const,
      bucket: receipt.remote.bucket,
      objectKey: receipt.remote.objectKey,
      generation: receipt.remote.generation,
      compression: "zstd" as const,
      mimeType: "application/zstd",
      sha256: receipt.remote.storedSha256,
      byteSize: receipt.remote.storedSize,
      crc32c: receipt.remote.crc32c,
      uncompressedTarSha256: receipt.remote.tarSha256,
      uncompressedTarByteSize: receipt.remote.tarSize,
      verifiedAt: new Date(receipt.verifiedAt!),
      metadata: {
        preservationKind: "orphan_evidence_quarantine",
        engineJobId: receipt.jobId,
        evidencePath: receipt.evidencePath,
        manifestSha256: provenance.manifestSha256,
        archiveMemberSetSha256: provenance.archiveMemberSetSha256,
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
            eq(solverEvidenceBlobs.bucket, receipt.remote.bucket),
            eq(solverEvidenceBlobs.objectKey, receipt.remote.objectKey),
            eq(solverEvidenceBlobs.generation, receipt.remote.generation),
          ),
        )
        .limit(1);
    }
    if (!blob) throw new Error("failed to register orphan GCS blob");
    requireOrphanBlobMatches(blob, receipt);

    const canonicalStorageKey = sourceKeys(receipt)[0]!;
    const existingCanonicalArtifacts = sourceRows.filter(
      (row) =>
        row.storageKey === canonicalStorageKey && row.kind === "engine_bundle",
    );
    if (existingCanonicalArtifacts.length > 1) {
      throw new Error(
        "orphan receipt has ambiguous unbound canonical bundle artifacts",
      );
    }
    let artifact = existingCanonicalArtifacts[0];
    if (!artifact) {
      [artifact] = await tx
        .insert(solverEvidenceArtifacts)
        .values({
          resultId: null,
          resultAttemptId: null,
          airfoilId: context.simJob.airfoilId,
          simJobId: context.simJob.id,
          engineJobId: receipt.jobId,
          engineCaseSlug: context.engineCaseSlug,
          methodKey: context.simJob.methodKey,
          solverImplementationId: context.simJob.solverImplementationId,
          solverRuntimeBuildId: context.simJob.solverRuntimeBuildId,
          aoaDeg: null,
          kind: "engine_bundle",
          field: null,
          role: "evidence",
          storageKey: canonicalStorageKey,
          mimeType: "application/zstd",
          sha256: receipt.remote.storedSha256,
          byteSize: receipt.remote.storedSize,
          engineUrl: `${opts.engine.baseUrl.replace(/\/$/, "")}/jobs/${encodeURIComponent(receipt.jobId)}/files/${receipt.evidencePath}/engine_evidence.tar.zst`,
          metadata: {
            evidenceBase: context.evidenceBase,
            preservationKind: "orphan_evidence_quarantine",
            storageBackend: "gcs",
            bucket: receipt.remote.bucket,
            objectKey: receipt.remote.objectKey,
            generation: receipt.remote.generation,
            crc32c: receipt.remote.crc32c,
            compression: "zstd",
            archiveFormat: "tar+zstd",
            zstdLevel: receipt.remote.zstdLevel,
            uncompressedTarSha256: receipt.remote.tarSha256,
            uncompressedTarByteSize: receipt.remote.tarSize,
            verifiedAt: receipt.verifiedAt,
            pointerPath: "engine_evidence.remote.json",
            migrationReceipt: MIGRATION_RECEIPT_NAME,
            manifestSha256: provenance.manifestSha256,
            archiveMemberSetSha256: provenance.archiveMemberSetSha256,
            archiveMemberCount: provenance.archiveMembers.length,
          },
        })
        .returning();
    }
    if (!artifact) throw new Error("failed to register orphan bundle artifact");
    requireOrphanArtifactMatches(artifact, receipt, context, blob);

    const [quarantine] = await tx
      .insert(solverEvidenceOrphanQuarantines)
      .values({
        simJobId: context.simJob.id,
        engineJobId: receipt.jobId,
        engineCaseSlug: context.engineCaseSlug,
        evidencePath: receipt.evidencePath,
        quarantineReason: "terminal_engine_evidence_not_ingested",
        sourceArtifactId: artifact.id,
        blobId: blob.id,
        manifestSha256: provenance.manifestSha256,
        manifestByteSize: provenance.manifestByteSize,
        archiveMemberSetSha256: provenance.archiveMemberSetSha256,
        archiveMemberCount: provenance.archiveMembers.length,
        archiveMembers: provenance.archiveMembers,
        sourceArchives: receipt.sourceArchives,
        migrationReceiptSha256: opts.document.sha256,
        migrationReceiptByteSize: opts.document.bytes.byteLength,
        verificationMode: receipt.verificationMode!,
        remoteVerifiedAt: new Date(receipt.verifiedAt!),
      })
      .returning();
    if (!quarantine) {
      throw new Error("failed to register immutable orphan quarantine");
    }
    return orphanAckFromRow(quarantine, receipt);
  });
}

function artifactForReceipt(
  receipt: MigrationReceipt,
  source: typeof solverEvidenceArtifacts.$inferSelect,
): EngineEvidenceArtifact {
  const evidenceBase = evidenceBaseOf(source, receipt);
  return {
    kind: "engine_bundle",
    path: `${evidenceBase}/engine_evidence.tar.zst`,
    url: `/jobs/${receipt.jobId}/files/${receipt.evidencePath}/engine_evidence.tar.zst`,
    mime_type: "application/zstd",
    sha256: receipt.remote.storedSha256,
    byte_size: receipt.remote.storedSize,
    role: "evidence",
    metadata: {
      evidenceBase,
      engineNamespace: source.metadata?.engineNamespace ?? null,
      methodKey: source.methodKey,
      fileCount: source.metadata?.fileCount ?? null,
      windowStart: source.metadata?.windowStart ?? null,
      windowEnd: source.metadata?.windowEnd ?? null,
      storageBackend: "gcs",
      bucket: receipt.remote.bucket,
      objectKey: receipt.remote.objectKey,
      generation: receipt.remote.generation,
      crc32c: receipt.remote.crc32c,
      compression: "zstd",
      archiveFormat: "tar+zstd",
      zstdLevel: receipt.remote.zstdLevel,
      uncompressedTarSha256: receipt.remote.tarSha256,
      uncompressedTarByteSize: receipt.remote.tarSize,
      verifiedAt: receipt.remote.createdAt,
      pointerPath: "engine_evidence.remote.json",
      migrationReceipt: MIGRATION_RECEIPT_NAME,
    },
  };
}

async function currentArchiveAck(
  db: DB,
  receipt: MigrationReceipt,
  source: typeof solverEvidenceArtifacts.$inferSelect,
): Promise<RegisteredEvidenceStorageDatabaseAck> {
  const rows = await db
    .select({
      archive: solverEvidenceArchives,
      blob: solverEvidenceBlobs,
      artifact: solverEvidenceArtifacts,
    })
    .from(solverEvidenceArchives)
    .innerJoin(
      solverEvidenceBlobs,
      eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
    )
    .innerJoin(
      solverEvidenceArtifacts,
      eq(solverEvidenceArtifacts.id, solverEvidenceArchives.sourceArtifactId),
    )
    .where(
      and(
        eq(solverEvidenceArchives.resultId, source.resultId!),
        eq(solverEvidenceArchives.resultAttemptId, source.resultAttemptId!),
        eq(solverEvidenceArchives.state, "current"),
      ),
    );
  if (rows.length !== 1)
    throw new Error("database has no unique current evidence archive");
  const row = rows[0];
  if (
    row.blob.backend !== "gcs" ||
    row.blob.bucket !== receipt.remote.bucket ||
    row.blob.objectKey !== receipt.remote.objectKey ||
    row.blob.generation !== receipt.remote.generation ||
    row.blob.sha256 !== receipt.remote.storedSha256 ||
    row.blob.byteSize !== receipt.remote.storedSize ||
    row.blob.uncompressedTarSha256 !== receipt.remote.tarSha256 ||
    row.blob.uncompressedTarByteSize !== receipt.remote.tarSize ||
    row.artifact.kind !== "engine_bundle" ||
    row.artifact.resultId !== source.resultId ||
    row.artifact.resultAttemptId !== source.resultAttemptId
  ) {
    throw new Error(
      "current database archive does not match migration receipt",
    );
  }
  return {
    schemaVersion: 1,
    state: "registered",
    jobId: receipt.jobId,
    evidencePath: receipt.evidencePath,
    storedSha256: receipt.remote.storedSha256,
    generation: receipt.remote.generation,
    resultId: source.resultId!,
    resultAttemptId: source.resultAttemptId!,
    sourceArtifactId: row.artifact.id,
    archiveId: row.archive.id,
    registeredAt: new Date().toISOString(),
  };
}

async function validateMemberCoverage(
  db: DB,
  ack: RegisteredEvidenceStorageDatabaseAck,
  manifest: ManifestValidation,
): Promise<void> {
  const rows = await db
    .select({
      artifact: solverEvidenceArtifacts,
      memberPath: solverEvidenceArtifactMembers.memberPath,
    })
    .from(solverEvidenceArtifactMembers)
    .innerJoin(
      solverEvidenceArtifacts,
      eq(solverEvidenceArtifactMembers.artifactId, solverEvidenceArtifacts.id),
    )
    .where(eq(solverEvidenceArtifactMembers.archiveId, ack.archiveId));
  const expectedIds = new Set(manifest.expected.map((artifact) => artifact.id));
  if (
    rows.length !== manifest.expected.length ||
    rows.some(
      (row) =>
        !expectedIds.has(row.artifact.id) ||
        row.artifact.resultId !== ack.resultId ||
        row.artifact.resultAttemptId !== ack.resultAttemptId ||
        manifest.memberPaths.get(row.artifact.id) !== row.memberPath,
    )
  ) {
    throw new Error(
      "archive member registration is incomplete or contains a foreign/mismatched mapping",
    );
  }
}

export async function registerEvidenceMigrationReceipt(opts: {
  db: DB;
  engine: EngineClient;
  receiptPath: string;
  mediaRoot: string;
  writeAck?: boolean;
}): Promise<EvidenceStorageDatabaseAck> {
  const document = await readReceiptDocument(opts.receiptPath, opts.mediaRoot);
  const { receipt } = document;
  const ackPath = join(dirname(opts.receiptPath), DATABASE_ACK_NAME);
  try {
    const existing = JSON.parse(await readFile(ackPath, "utf8"));
    const parsed = object(existing, "database acknowledgement");
    if (
      parsed.storedSha256 !== receipt.remote.storedSha256 ||
      parsed.generation !== receipt.remote.generation ||
      parsed.jobId !== receipt.jobId ||
      parsed.evidencePath !== receipt.evidencePath
    ) {
      throw new Error(
        "existing database acknowledgement conflicts with receipt",
      );
    }
    if (parsed.state === "quarantined") {
      if (parsed.registrationKind !== "orphan_evidence_quarantine") {
        throw new Error("existing orphan acknowledgement has the wrong kind");
      }
      if (parsed.quarantineReason !== "terminal_engine_evidence_not_ingested") {
        throw new Error("existing orphan acknowledgement has the wrong reason");
      }
      const current = await registerOrphanEvidenceQuarantine({
        db: opts.db,
        engine: opts.engine,
        document,
        receiptPath: opts.receiptPath,
      });
      for (const key of [
        "quarantineId",
        "sourceArtifactId",
        "blobId",
        "manifestSha256",
        "manifestByteSize",
        "archiveMemberSetSha256",
        "archiveMemberCount",
        "migrationReceiptSha256",
        "migrationReceiptByteSize",
        "quarantinedAt",
      ] as const) {
        if (parsed[key] !== current[key]) {
          throw new Error(
            `existing orphan acknowledgement no longer matches ${key}`,
          );
        }
      }
      return existing as OrphanEvidenceStorageDatabaseAck;
    }
    if (parsed.state !== "registered") {
      throw new Error("existing database acknowledgement has an unknown state");
    }
    const source = await findExactSource(opts.db, receipt);
    const manifest = await validateManifestArtifacts(
      opts.db,
      receipt,
      opts.receiptPath,
      source.resultId!,
      source.resultAttemptId!,
    );
    const current = await currentArchiveAck(opts.db, receipt, source);
    for (const key of [
      "resultId",
      "resultAttemptId",
      "sourceArtifactId",
      "archiveId",
    ] as const) {
      if (parsed[key] !== current[key]) {
        throw new Error(
          `existing database acknowledgement no longer matches ${key}`,
        );
      }
    }
    await validateMemberCoverage(opts.db, current, manifest);
    return existing as RegisteredEvidenceStorageDatabaseAck;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const sourceRows = await exactSourceRows(opts.db, receipt);
  const ownerKeys = new Set(
    sourceRows
      .filter((row) => row.resultId && row.resultAttemptId && row.simJobId)
      .map((row) => `${row.resultId}:${row.resultAttemptId}:${row.simJobId}`),
  );
  if (ownerKeys.size === 0) {
    const ack = await registerOrphanEvidenceQuarantine({
      db: opts.db,
      engine: opts.engine,
      document,
      receiptPath: opts.receiptPath,
    });
    if (opts.writeAck !== false) await atomicWriteJson(ackPath, ack);
    return ack;
  }
  if (ownerKeys.size !== 1) {
    throw new Error(
      `receipt must resolve to one exact result attempt; found ${ownerKeys.size}`,
    );
  }
  const source = await findExactSource(opts.db, receipt);
  const manifest = await validateManifestArtifacts(
    opts.db,
    receipt,
    opts.receiptPath,
    source.resultId!,
    source.resultAttemptId!,
  );
  const artifact = artifactForReceipt(receipt, source);
  const engineOrigin = source.engineUrl?.match(
    /^(.*)\/jobs\/[^/]+\/files\//,
  )?.[1];
  const registrationEngine = {
    baseUrl: engineOrigin ?? opts.engine.baseUrl,
  } as EngineClient;
  await registerEvidenceArtifacts({
    db: opts.db,
    engine: registrationEngine,
    resultId: source.resultId!,
    resultAttemptId: source.resultAttemptId!,
    airfoilId: source.airfoilId,
    simJobId: source.simJobId!,
    engineJobId: receipt.jobId,
    point: {
      aoa_deg: source.aoaDeg!,
      case_slug: source.engineCaseSlug!,
      method_key: source.methodKey ?? undefined,
    } as PolarPoint,
    artifact,
    runtime:
      source.solverImplementationId && source.solverRuntimeBuildId
        ? {
            solverImplementationId: source.solverImplementationId,
            solverRuntimeBuildId: source.solverRuntimeBuildId,
          }
        : undefined,
  });
  const ack = await currentArchiveAck(opts.db, receipt, source);
  await validateMemberCoverage(opts.db, ack, manifest);
  if (opts.writeAck !== false) await atomicWriteJson(ackPath, ack);
  return ack;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${DATABASE_ACK_NAME}.${randomUUID()}.tmp`,
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

const DISCOVERY_PRUNE_DIRS = new Set([
  "VTK",
  "openfoam",
  "time_directories",
  "frames",
  "images",
  "scaled_media",
  "custom_renders",
  "constant",
  "system",
  "postProcessing",
  "dynamicCode",
]);

type ReadDirectory = (path: string) => Promise<Dirent[]>;

export async function discoverEvidenceMigrationReceipts(
  mediaRoot: string,
  opts: {
    jobIds?: ReadonlySet<string>;
    evidencePaths?: Iterable<string>;
    limit?: number | null;
    readDirectory?: ReadDirectory;
  } = {},
): Promise<string[]> {
  const jobsRoot = join(mediaRoot, "jobs");
  const readDirectory =
    opts.readDirectory ??
    ((path: string) => readdir(path, { withFileTypes: true }));
  const limit = opts.limit ?? null;
  const requested = [...(opts.jobIds ?? [])].map((jobId) => {
    const safe = safeRelative(jobId, "--job-id");
    if (safe.includes("/"))
      throw new Error("--job-id must be one path segment");
    return safe;
  });
  const requestedEvidencePaths = [
    ...new Set(
      [...(opts.evidencePaths ?? [])].map((evidencePath) =>
        safeRelative(evidencePath, "--evidence-path"),
      ),
    ),
  ].sort();
  if (requestedEvidencePaths.length) {
    if (requested.length !== 1) {
      throw new Error("--evidence-path requires exactly one --job-id");
    }
    if (limit != null) {
      throw new Error("--evidence-path cannot be combined with --limit");
    }
  }
  let jobRoots: string[];
  if (requested.length) {
    // Never enumerate siblings for an explicit trial/batch selection.
    jobRoots = requested.sort().map((jobId) => join(jobsRoot, jobId));
  } else {
    let entries;
    try {
      entries = await readDirectory(jobsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    jobRoots = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(jobsRoot, entry.name))
      .sort();
  }
  const found: string[] = [];
  for (const jobRoot of jobRoots) {
    if (limit != null && found.length >= limit) break;
    const stack = [join(jobRoot, "cases")];
    while (stack.length && (limit == null || found.length < limit)) {
      const current = stack.pop()!;
      if (basename(current) === "evidence") {
        const receipt = join(current, MIGRATION_RECEIPT_NAME);
        try {
          if ((await stat(receipt)).isFile()) found.push(receipt);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        continue;
      }
      let entries;
      try {
        entries = await readDirectory(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const directories = entries
        .filter((entry) => {
          if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
          if (DISCOVERY_PRUNE_DIRS.has(entry.name)) return false;
          if (/^processor\d+$/.test(entry.name)) return false;
          if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(entry.name)) return false;
          return true;
        })
        .map((entry) => join(current, entry.name))
        .sort()
        .reverse();
      for (const path of directories) {
        stack.push(path);
      }
    }
  }
  if (requestedEvidencePaths.length) {
    const jobRoot = jobRoots[0]!;
    const receiptsByEvidencePath = new Map<string, string>();
    for (const receiptPath of found) {
      const evidencePath = relative(jobRoot, dirname(receiptPath))
        .split(sep)
        .join("/");
      if (!requestedEvidencePaths.includes(evidencePath)) continue;
      if (receiptsByEvidencePath.has(evidencePath)) {
        throw new Error(
          `--evidence-path resolved more than once: ${evidencePath}`,
        );
      }
      receiptsByEvidencePath.set(evidencePath, receiptPath);
    }
    const missing = requestedEvidencePaths.filter(
      (evidencePath) => !receiptsByEvidencePath.has(evidencePath),
    );
    if (missing.length) {
      throw new Error(
        `--evidence-path did not resolve in the exact job: ${missing.join(", ")}`,
      );
    }
    return requestedEvidencePaths.map(
      (evidencePath) => receiptsByEvidencePath.get(evidencePath)!,
    );
  }
  return found;
}

export function evidenceMigrationExecutionLog(
  acknowledgement: EvidenceStorageDatabaseAck,
): EvidenceStorageDatabaseAck & {
  status: EvidenceStorageDatabaseAck["state"];
} {
  return { status: acknowledgement.state, ...acknowledgement };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const continueOnError = args.includes("--continue-on-error");
  const limitIndex = args.indexOf("--limit");
  const limit =
    limitIndex >= 0 ? Number.parseInt(args[limitIndex + 1] ?? "", 10) : null;
  if (limit != null && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  const jobIds = new Set<string>();
  const jobIdArgs: string[] = [];
  const evidencePaths = new Set<string>();
  const evidencePathArgs: string[] = [];
  args.forEach((arg, index) => {
    if (arg === "--job-id") {
      const jobId = args[index + 1] ?? "";
      jobIdArgs.push(jobId);
      jobIds.add(jobId);
    }
    if (arg === "--evidence-path") {
      const evidencePath = args[index + 1] ?? "";
      evidencePathArgs.push(evidencePath);
      evidencePaths.add(evidencePath);
    }
  });
  if (evidencePathArgs.length && jobIdArgs.length !== 1) {
    throw new Error("--evidence-path requires exactly one --job-id option");
  }
  if (evidencePathArgs.length && limit != null) {
    throw new Error("--evidence-path cannot be combined with --limit");
  }
  const mediaRoot = resolve(process.env.MEDIA_DIR ?? "/data/airfoilfoam");
  const receipts = await discoverEvidenceMigrationReceipts(mediaRoot, {
    jobIds,
    evidencePaths,
    limit,
  });
  const { db, sql, engine } = makeContext();
  let failed = 0;
  let processed = 0;
  try {
    for (const receiptPath of receipts) {
      processed += 1;
      try {
        const document = await readReceiptDocument(receiptPath, mediaRoot);
        const { receipt } = document;
        if (!execute) {
          const sourceRows = await exactSourceRows(db, receipt);
          const ownerKeys = new Set(
            sourceRows
              .filter(
                (row) => row.resultId && row.resultAttemptId && row.simJobId,
              )
              .map(
                (row) =>
                  `${row.resultId}:${row.resultAttemptId}:${row.simJobId}`,
              ),
          );
          if (ownerKeys.size === 0) {
            const context = await exactOrphanOwnerContext(db, receipt);
            const provenance = await orphanManifestProvenance(
              receipt,
              receiptPath,
            );
            console.log(
              JSON.stringify({
                status: "planned-quarantine",
                jobId: receipt.jobId,
                simJobId: context.simJob.id,
                engineCaseSlug: context.engineCaseSlug,
                evidencePath: receipt.evidencePath,
                manifestSha256: provenance.manifestSha256,
                archiveMemberCount: provenance.archiveMembers.length,
              }),
            );
            continue;
          }
          if (ownerKeys.size !== 1) {
            throw new Error(
              `receipt must resolve to one exact result attempt; found ${ownerKeys.size}`,
            );
          }
          const source = await findExactSource(db, receipt);
          console.log(
            JSON.stringify({
              status: "planned",
              jobId: receipt.jobId,
              evidencePath: receipt.evidencePath,
              resultId: source.resultId,
              resultAttemptId: source.resultAttemptId,
            }),
          );
          continue;
        }
        const ack = await registerEvidenceMigrationReceipt({
          db,
          engine,
          receiptPath,
          mediaRoot,
        });
        console.log(JSON.stringify(evidenceMigrationExecutionLog(ack)));
      } catch (error) {
        failed += 1;
        console.error(
          JSON.stringify({
            status: "failed",
            receiptPath,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        if (!continueOnError) break;
      }
    }
  } finally {
    await sql.end();
  }
  console.error(
    JSON.stringify({
      mode: execute ? "execute" : "dry-run",
      processed,
      failed,
    }),
  );
  return failed ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}
