import {
  type DB,
  solverEvidenceArchives,
  solverEvidenceArtifactMembers,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
} from "@aerodb/db";
import type {
  EngineClient,
  EngineEvidenceArtifact,
  PolarPoint,
} from "@aerodb/engine-client";
import { and, eq, inArray } from "drizzle-orm";
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
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

import { makeContext } from "./config";
import { parseEvidenceManifest } from "./evidence-manifest";
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
}

export interface EvidenceStorageDatabaseAck {
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

function safeRelative(value: unknown, label: string): string {
  const text = exactString(value, label);
  if (
    text.startsWith("/") ||
    text.includes("\\") ||
    text.includes("\0") ||
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
  if (raw.schemaVersion !== 1) throw new Error("unsupported migration receipt schema");
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
      storedSha256: pattern(archive.storedSha256, "archive storedSha256", SHA256),
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
      schemaVersion: remote.schemaVersion === 1 ? 1 : (() => {
        throw new Error("unsupported remote pointer schema");
      })(),
      format: remote.format === "tar+zstd" ? "tar+zstd" : (() => {
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
    throw new Error("migration receipt path does not match its job/evidence identity");
  }
  return parsed;
}

async function readReceipt(
  receiptPath: string,
  mediaRoot: string,
): Promise<MigrationReceipt> {
  const raw = JSON.parse(await readFile(receiptPath, "utf8"));
  return parseEvidenceMigrationReceipt(raw, receiptPath, mediaRoot);
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
    if (baseParts.every((part, offset) => storedParts[index + offset] === part)) {
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
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
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
    if (artifact.kind === "engine_bundle" || artifact.kind === "openfoam_bundle") {
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
  const allowedMemberPaths = new Set(parsed.memberSet.map((entry) => entry.path));
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

async function findExactSource(db: DB, receipt: MigrationReceipt) {
  const rows = await db
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
  if (!source.engineCaseSlug) throw new Error("source artifact has no case slug");
  evidenceBaseOf(source, receipt);
  return source;
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
): Promise<EvidenceStorageDatabaseAck> {
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
      eq(
        solverEvidenceArtifacts.id,
        solverEvidenceArchives.sourceArtifactId,
      ),
    )
    .where(
      and(
        eq(solverEvidenceArchives.resultId, source.resultId!),
        eq(solverEvidenceArchives.resultAttemptId, source.resultAttemptId!),
        eq(solverEvidenceArchives.state, "current"),
      ),
    );
  if (rows.length !== 1) throw new Error("database has no unique current evidence archive");
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
    throw new Error("current database archive does not match migration receipt");
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
  ack: EvidenceStorageDatabaseAck,
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
      eq(
        solverEvidenceArtifactMembers.artifactId,
        solverEvidenceArtifacts.id,
      ),
    )
    .where(
      eq(
        solverEvidenceArtifactMembers.archiveId,
        ack.archiveId,
      ),
    );
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
  const receipt = await readReceipt(opts.receiptPath, opts.mediaRoot);
  const ackPath = join(dirname(opts.receiptPath), DATABASE_ACK_NAME);
  try {
    const existing = JSON.parse(await readFile(ackPath, "utf8"));
    const parsed = object(existing, "database acknowledgement");
    if (
      parsed.state !== "registered" ||
      parsed.storedSha256 !== receipt.remote.storedSha256 ||
      parsed.generation !== receipt.remote.generation ||
      parsed.jobId !== receipt.jobId ||
      parsed.evidencePath !== receipt.evidencePath
    ) {
      throw new Error("existing database acknowledgement conflicts with receipt");
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
    return existing as EvidenceStorageDatabaseAck;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  const engineOrigin = source.engineUrl?.match(/^(.*)\/jobs\/[^/]+\/files\//)?.[1];
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
  const temporary = join(dirname(path), `.${DATABASE_ACK_NAME}.${randomUUID()}.tmp`);
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
    if (safe.includes("/")) throw new Error("--job-id must be one path segment");
    return safe;
  });
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
  return found;
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
  args.forEach((arg, index) => {
    if (arg === "--job-id") jobIds.add(args[index + 1] ?? "");
  });
  const mediaRoot = resolve(process.env.MEDIA_DIR ?? "/data/airfoilfoam");
  const receipts = await discoverEvidenceMigrationReceipts(mediaRoot, {
    jobIds,
    limit,
  });
  const { db, sql, engine } = makeContext();
  let failed = 0;
  let processed = 0;
  try {
    for (const receiptPath of receipts) {
      processed += 1;
      try {
        const receipt = await readReceipt(receiptPath, mediaRoot);
        if (!execute) {
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
        console.log(JSON.stringify({ status: "registered", ...ack }));
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
  console.error(JSON.stringify({ mode: execute ? "execute" : "dry-run", processed, failed }));
  return failed ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}
