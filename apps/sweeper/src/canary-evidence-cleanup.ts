import {
  type DB,
  getOpenCfd2606CanaryAttestation,
  solverCanaryObjectCleanupReceipts,
  solverCanaryObjectCleanupReservations,
} from "@aerodb/db";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC32C = /^[A-Za-z0-9+/]{6}==$/;
const MAX_GCS_GENERATION = 18_446_744_073_709_551_615n;
const RECEIPT_KIND = "opencfd2606-canary-gcs-cleanup-receipt";

type JsonObject = Record<string, unknown>;

export interface CanaryCleanupTarget {
  bucket: string;
  objectKey: string;
  generation: string;
  sha256: string;
  byteSize: number;
  crc32c: string;
}

export interface CanaryCleanupOwnership {
  blobCount: number;
  artifactCount: number;
  archiveCount: number;
  orphanQuarantineCount: number;
  incompleteQuarantineCount: number;
}

export interface CanaryCleanupReservationDocument {
  schemaVersion: 1;
  kind: "opencfd2606-canary-gcs-cleanup-reservation";
  reservationId: string;
  reservedAt: string;
  reservedBy: string;
  attestation: {
    id: string;
    receiptSha256: string;
    canonicalReceipt: string;
  };
  target: CanaryCleanupTarget;
  ownershipAtReservation: CanaryCleanupOwnership;
}

export interface CanaryCleanupReceipt {
  schemaVersion: 1;
  kind: typeof RECEIPT_KIND;
  reservationId: string;
  attestationId: string;
  target: CanaryCleanupTarget;
  preDeleteObservation:
    | ({ status: "present" } & CanaryCleanupTarget)
    | { status: "absent" };
  postDeleteObservation: { status: "absent" };
  outcome: "deleted" | "already_absent_after_reservation";
  deletedAt: string;
  operator: string;
}

export interface CanaryCleanupPlanRow {
  target: CanaryCleanupTarget;
  ownership: CanaryCleanupOwnership;
  status: "eligible" | "owned" | "reserved" | "complete";
  reservationId: string | null;
  receiptId: string | null;
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return value;
}

function pattern(value: unknown, label: string, expected: RegExp): string {
  const parsed = exactString(value, label);
  if (!expected.test(parsed)) throw new Error(`${label} has an invalid format`);
  return parsed;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("canonical JSON cannot encode undefined");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const source = value as JsonObject;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

const sha256Text = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function safeObjectPrefix(value: unknown): string {
  const prefix = exactString(value, "attestation evidence object prefix");
  if (
    prefix.startsWith("/") ||
    prefix.includes("\\") ||
    prefix.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("attestation evidence object prefix is unsafe");
  }
  return prefix;
}

function targetKey(target: CanaryCleanupTarget): string {
  return `${target.bucket}\u001f${target.objectKey}\u001f${target.generation}`;
}

/**
 * Extract only exact engine bundles from the immutable canary receipt.  Every
 * non-bundle artifact shares the same archive binding, but counting it would
 * turn one object into many cleanup claims.
 */
export function canaryCleanupTargets(receiptValue: unknown): CanaryCleanupTarget[] {
  const receipt = object(receiptValue, "canary attestation receipt");
  if (receipt.schema_version !== 1 || receipt.status !== "ok") {
    throw new Error("canary attestation receipt is not a successful schema-v1 receipt");
  }
  const engine = object(receipt.engine, "canary attestation engine");
  if (
    engine.family !== "openfoam" ||
    engine.distribution !== "opencfd" ||
    engine.version !== "2606"
  ) {
    throw new Error("canary attestation is not OpenCFD 2606");
  }
  const evidenceStorage = object(
    receipt.evidence_storage,
    "canary attestation evidence storage",
  );
  if (
    evidenceStorage.backend !== "gcs" ||
    evidenceStorage.archive_format !== "tar+zstd" ||
    evidenceStorage.compression !== "zstd" ||
    evidenceStorage.local_disposition !== "remote-only"
  ) {
    throw new Error("canary attestation is not the remote-only GCS tar+Zstandard contract");
  }
  const bucket = exactString(evidenceStorage.bucket, "attestation GCS bucket");
  const prefix = safeObjectPrefix(evidenceStorage.object_prefix);
  const targets = new Map<string, CanaryCleanupTarget>();
  for (const [jobIndex, jobValue] of array(receipt.jobs, "canary jobs").entries()) {
    const job = object(jobValue, `canary jobs[${jobIndex}]`);
    for (const [pointIndex, pointValue] of array(
      job.points,
      `canary jobs[${jobIndex}].points`,
    ).entries()) {
      const point = object(
        pointValue,
        `canary jobs[${jobIndex}].points[${pointIndex}]`,
      );
      for (const [artifactIndex, artifactValue] of array(
        point.artifacts,
        `canary jobs[${jobIndex}].points[${pointIndex}].artifacts`,
      ).entries()) {
        const artifact = object(
          artifactValue,
          `canary artifact ${jobIndex}/${pointIndex}/${artifactIndex}`,
        );
        if (artifact.kind !== "engine_bundle") continue;
        const artifactSha256 = pattern(
          artifact.sha256,
          "canary bundle SHA-256",
          SHA256,
        );
        const artifactByteSize = positiveSafeInteger(
          artifact.byte_size,
          "canary bundle byte size",
        );
        const storage = object(artifact.storage, "canary bundle storage");
        const generation = pattern(
          storage.generation,
          "canary bundle generation",
          GENERATION,
        );
        if (BigInt(generation) > MAX_GCS_GENERATION) {
          throw new Error("canary bundle generation exceeds GCS uint64");
        }
        const target: CanaryCleanupTarget = {
          bucket: exactString(storage.bucket, "canary bundle bucket"),
          objectKey: exactString(storage.object_key, "canary bundle object key"),
          generation,
          sha256: pattern(storage.stored_sha256, "canary stored SHA-256", SHA256),
          byteSize: positiveSafeInteger(
            storage.stored_byte_size,
            "canary stored byte size",
          ),
          crc32c: pattern(storage.crc32c, "canary CRC32C", CRC32C),
        };
        const expectedKey = `${prefix}/sha256/${target.sha256.slice(0, 2)}/${target.sha256}.tar.zst`;
        if (
          target.bucket !== bucket ||
          target.objectKey !== expectedKey ||
          target.sha256 !== artifactSha256 ||
          target.byteSize !== artifactByteSize
        ) {
          throw new Error("canary bundle target differs from its attested content identity");
        }
        const key = targetKey(target);
        const prior = targets.get(key);
        if (prior && canonicalJson(prior) !== canonicalJson(target)) {
          throw new Error("one canary generation has conflicting attested identities");
        }
        targets.set(key, target);
      }
    }
  }
  if (targets.size === 0) {
    throw new Error("canary attestation contains no engine_bundle objects");
  }
  return [...targets.values()].sort((left, right) =>
    targetKey(left).localeCompare(targetKey(right)),
  );
}

async function attestationAndTargets(db: DB, attestationId: string) {
  const attestation = await getOpenCfd2606CanaryAttestation(db, attestationId);
  const canonicalReceipt = canonicalJson(attestation.receipt);
  const actualDigest = sha256Text(canonicalReceipt);
  if (actualDigest !== attestation.receiptSha256) {
    throw new Error("durable canary attestation receipt digest does not match its JSON");
  }
  return {
    attestation,
    canonicalReceipt,
    targets: canaryCleanupTargets(attestation.receipt),
  };
}

async function ownershipFor(
  db: DB,
  target: CanaryCleanupTarget,
): Promise<CanaryCleanupOwnership> {
  const [row] = (await db.execute(sql`
    WITH matching_blobs AS (
      SELECT id
      FROM solver_evidence_blobs
      WHERE backend = 'gcs'
        AND bucket = ${target.bucket}
        AND object_key = ${target.objectKey}
        AND generation = ${target.generation}
    )
    SELECT
      (SELECT count(*) FROM matching_blobs)::int AS blob_count,
      (
        SELECT count(*) FROM solver_evidence_artifacts artifact
        WHERE (
          artifact.metadata ->> 'storageBackend' = 'gcs'
          AND artifact.metadata ->> 'bucket' = ${target.bucket}
          AND artifact.metadata ->> 'objectKey' = ${target.objectKey}
          AND artifact.metadata ->> 'generation' = ${target.generation}
        ) OR (
          artifact.metadata -> 'storage' ->> 'backend' = 'gcs'
          AND artifact.metadata -> 'storage' ->> 'bucket' = ${target.bucket}
          AND artifact.metadata -> 'storage' ->> 'object_key' = ${target.objectKey}
          AND artifact.metadata -> 'storage' ->> 'generation' = ${target.generation}
        )
      )::int AS artifact_count,
      (
        SELECT count(*) FROM solver_evidence_archives archive
        WHERE archive.blob_id IN (SELECT id FROM matching_blobs)
      )::int AS archive_count,
      (
        SELECT count(*) FROM solver_evidence_orphan_quarantines quarantine
        WHERE quarantine.blob_id IN (SELECT id FROM matching_blobs)
      )::int AS orphan_quarantine_count,
      (
        SELECT count(*) FROM solver_evidence_incomplete_quarantines quarantine
        WHERE quarantine.blob_id IN (SELECT id FROM matching_blobs)
      )::int AS incomplete_quarantine_count
  `)) as unknown as Array<{
    blob_count: number;
    artifact_count: number;
    archive_count: number;
    orphan_quarantine_count: number;
    incomplete_quarantine_count: number;
  }>;
  if (!row) throw new Error("canary cleanup ownership query returned no row");
  return {
    blobCount: Number(row.blob_count),
    artifactCount: Number(row.artifact_count),
    archiveCount: Number(row.archive_count),
    orphanQuarantineCount: Number(row.orphan_quarantine_count),
    incompleteQuarantineCount: Number(row.incomplete_quarantine_count),
  };
}

const hasOwnership = (ownership: CanaryCleanupOwnership): boolean =>
  Object.values(ownership).some((count) => count !== 0);

async function existingReservation(db: DB, target: CanaryCleanupTarget) {
  const [row] = await db
    .select({
      reservation: solverCanaryObjectCleanupReservations,
      receiptId: solverCanaryObjectCleanupReceipts.id,
    })
    .from(solverCanaryObjectCleanupReservations)
    .leftJoin(
      solverCanaryObjectCleanupReceipts,
      eq(
        solverCanaryObjectCleanupReceipts.cleanupReservationId,
        solverCanaryObjectCleanupReservations.id,
      ),
    )
    .where(
      and(
        eq(solverCanaryObjectCleanupReservations.bucket, target.bucket),
        eq(solverCanaryObjectCleanupReservations.objectKey, target.objectKey),
        eq(solverCanaryObjectCleanupReservations.generation, target.generation),
      ),
    )
    .limit(1);
  return row;
}

export async function planCanaryEvidenceCleanup(
  db: DB,
  attestationId: string,
): Promise<CanaryCleanupPlanRow[]> {
  const { targets } = await attestationAndTargets(db, attestationId);
  const rows: CanaryCleanupPlanRow[] = [];
  for (const target of targets) {
    const [ownership, existing] = await Promise.all([
      ownershipFor(db, target),
      existingReservation(db, target),
    ]);
    rows.push({
      target,
      ownership,
      status: existing
        ? existing.receiptId
          ? "complete"
          : "reserved"
        : hasOwnership(ownership)
          ? "owned"
          : "eligible",
      reservationId: existing?.reservation.id ?? null,
      receiptId: existing?.receiptId ?? null,
    });
  }
  return rows;
}

function assertExactReservation(
  reservation: typeof solverCanaryObjectCleanupReservations.$inferSelect,
  attestationId: string,
  target: CanaryCleanupTarget,
): void {
  if (
    reservation.canaryAttestationId !== attestationId ||
    reservation.bucket !== target.bucket ||
    reservation.objectKey !== target.objectKey ||
    reservation.generation !== target.generation ||
    reservation.sha256 !== target.sha256 ||
    reservation.byteSize !== target.byteSize ||
    reservation.crc32c !== target.crc32c
  ) {
    throw new Error("existing canary cleanup reservation has a conflicting identity");
  }
}

function reservationDocument(
  reservation: typeof solverCanaryObjectCleanupReservations.$inferSelect,
  attestation: { id: string; receiptSha256: string },
  canonicalReceipt: string,
  target: CanaryCleanupTarget,
): CanaryCleanupReservationDocument {
  return {
    schemaVersion: 1,
    kind: "opencfd2606-canary-gcs-cleanup-reservation",
    reservationId: reservation.id,
    reservedAt: reservation.createdAt.toISOString(),
    reservedBy: reservation.reservedBy,
    attestation: {
      id: attestation.id,
      receiptSha256: attestation.receiptSha256,
      canonicalReceipt,
    },
    target,
    ownershipAtReservation: {
      blobCount: 0,
      artifactCount: 0,
      archiveCount: 0,
      orphanQuarantineCount: 0,
      incompleteQuarantineCount: 0,
    },
  };
}

/** Reserve all objects atomically. Any owned object aborts the whole set. */
export async function reserveCanaryEvidenceCleanup(
  db: DB,
  attestationId: string,
  actor: string,
): Promise<CanaryCleanupReservationDocument[]> {
  const reservedBy = exactString(actor.trim(), "cleanup reservation actor");
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const { attestation, canonicalReceipt, targets } =
      await attestationAndTargets(tx, attestationId);
    const ownership = await Promise.all(
      targets.map((target) => ownershipFor(tx, target)),
    );
    const ownedIndex = ownership.findIndex(hasOwnership);
    if (ownedIndex >= 0) {
      throw new Error(
        `refusing canary cleanup because ${targets[ownedIndex]!.objectKey} has database ownership`,
      );
    }
    const documents: CanaryCleanupReservationDocument[] = [];
    for (const target of targets) {
      const [inserted] = await tx
        .insert(solverCanaryObjectCleanupReservations)
        .values({
          canaryAttestationId: attestationId,
          ...target,
          reservedBy,
        })
        .onConflictDoNothing()
        .returning();
      const reservation =
        inserted ?? (await existingReservation(tx, target))?.reservation;
      if (!reservation) throw new Error("canary cleanup reservation disappeared");
      assertExactReservation(reservation, attestationId, target);
      documents.push(
        reservationDocument(
          reservation,
          attestation,
          canonicalReceipt,
          target,
        ),
      );
    }
    return documents;
  });
}

function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function parseTarget(value: unknown, label: string): CanaryCleanupTarget {
  const target = object(value, label);
  assertExactKeys(
    target,
    ["bucket", "objectKey", "generation", "sha256", "byteSize", "crc32c"],
    label,
  );
  const generation = pattern(target.generation, `${label}.generation`, GENERATION);
  if (BigInt(generation) > MAX_GCS_GENERATION) {
    throw new Error(`${label}.generation exceeds GCS uint64`);
  }
  return {
    bucket: exactString(target.bucket, `${label}.bucket`),
    objectKey: exactString(target.objectKey, `${label}.objectKey`),
    generation,
    sha256: pattern(target.sha256, `${label}.sha256`, SHA256),
    byteSize: positiveSafeInteger(target.byteSize, `${label}.byteSize`),
    crc32c: pattern(target.crc32c, `${label}.crc32c`, CRC32C),
  };
}

export function parseCanaryCleanupReceipt(value: unknown): CanaryCleanupReceipt {
  const receipt = object(value, "canary cleanup receipt");
  assertExactKeys(
    receipt,
    [
      "schemaVersion",
      "kind",
      "reservationId",
      "attestationId",
      "target",
      "preDeleteObservation",
      "postDeleteObservation",
      "outcome",
      "deletedAt",
      "operator",
    ],
    "canary cleanup receipt",
  );
  if (receipt.schemaVersion !== 1 || receipt.kind !== RECEIPT_KIND) {
    throw new Error("unsupported canary cleanup receipt");
  }
  const target = parseTarget(receipt.target, "canary cleanup target");
  const observation = object(
    receipt.preDeleteObservation,
    "canary cleanup pre-delete observation",
  );
  let preDeleteObservation: CanaryCleanupReceipt["preDeleteObservation"];
  if (observation.status === "absent") {
    assertExactKeys(observation, ["status"], "absent pre-delete observation");
    preDeleteObservation = { status: "absent" };
  } else if (observation.status === "present") {
    assertExactKeys(
      observation,
      ["status", "bucket", "objectKey", "generation", "sha256", "byteSize", "crc32c"],
      "present pre-delete observation",
    );
    const observed = parseTarget(
      Object.fromEntries(
        Object.entries(observation).filter(([key]) => key !== "status"),
      ),
      "present pre-delete target",
    );
    if (canonicalJson(observed) !== canonicalJson(target)) {
      throw new Error("pre-delete observation differs from cleanup target");
    }
    preDeleteObservation = { status: "present", ...observed };
  } else {
    throw new Error("pre-delete observation status is invalid");
  }
  const postDeleteObservation = object(
    receipt.postDeleteObservation,
    "canary cleanup post-delete observation",
  );
  assertExactKeys(
    postDeleteObservation,
    ["status"],
    "canary cleanup post-delete observation",
  );
  if (postDeleteObservation.status !== "absent") {
    throw new Error("canary cleanup generation is not proven absent after deletion");
  }
  const outcome = receipt.outcome;
  if (outcome !== "deleted" && outcome !== "already_absent_after_reservation") {
    throw new Error("canary cleanup outcome is invalid");
  }
  if (
    (outcome === "deleted" && preDeleteObservation.status !== "present") ||
    (outcome === "already_absent_after_reservation" &&
      preDeleteObservation.status !== "absent")
  ) {
    throw new Error("canary cleanup outcome contradicts its observation");
  }
  const deletedAt = exactString(receipt.deletedAt, "cleanup deletedAt");
  if (!Number.isFinite(new Date(deletedAt).getTime())) {
    throw new Error("cleanup deletedAt is not an ISO timestamp");
  }
  return {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    reservationId: exactString(receipt.reservationId, "cleanup reservationId"),
    attestationId: exactString(receipt.attestationId, "cleanup attestationId"),
    target,
    preDeleteObservation,
    postDeleteObservation: { status: "absent" },
    outcome,
    deletedAt,
    operator: exactString(receipt.operator, "cleanup operator"),
  };
}

export async function acknowledgeCanaryEvidenceCleanup(
  db: DB,
  receiptValue: unknown,
): Promise<{ id: string; receiptSha256: string; replayed: boolean }> {
  const receipt = parseCanaryCleanupReceipt(receiptValue);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [reservation] = await tx
      .select()
      .from(solverCanaryObjectCleanupReservations)
      .where(eq(solverCanaryObjectCleanupReservations.id, receipt.reservationId))
      .for("update")
      .limit(1);
    if (!reservation) throw new Error("canary cleanup reservation does not exist");
    assertExactReservation(reservation, receipt.attestationId, receipt.target);
    const canonicalReceipt = canonicalJson(receipt);
    const receiptSha256 = sha256Text(canonicalReceipt);
    const [inserted] = await tx
      .insert(solverCanaryObjectCleanupReceipts)
      .values({
        cleanupReservationId: reservation.id,
        outcome: receipt.outcome,
        receiptSha256,
        receipt: receipt as unknown as JsonObject,
        executedBy: receipt.operator,
        deletedAt: new Date(receipt.deletedAt),
      })
      .onConflictDoNothing({
        target: solverCanaryObjectCleanupReceipts.cleanupReservationId,
      })
      .returning({ id: solverCanaryObjectCleanupReceipts.id });
    if (inserted) return { id: inserted.id, receiptSha256, replayed: false };
    const [existing] = await tx
      .select()
      .from(solverCanaryObjectCleanupReceipts)
      .where(
        eq(
          solverCanaryObjectCleanupReceipts.cleanupReservationId,
          reservation.id,
        ),
      )
      .limit(1);
    if (
      !existing ||
      existing.receiptSha256 !== receiptSha256 ||
      canonicalJson(existing.receipt) !== canonicalReceipt
    ) {
      throw new Error("canary cleanup reservation already has a different receipt");
    }
    return { id: existing.id, receiptSha256, replayed: true };
  });
}
