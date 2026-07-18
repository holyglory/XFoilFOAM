import {
  registeredRemoteSolvers,
  syncBrokeredEvidenceUploads,
  syncSweepPromisePoints,
  syncSweepPromises,
  type DB,
} from "@aerodb/db";
import { isGcsResumableUploadUrl } from "@aerodb/core";
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { env } from "./env";

const ENGINE_TIMEOUT_MS = 30 * 60_000;
const ENGINE_CANCEL_TIMEOUT_MS = 20_000;
const MAX_SESSION_LIFETIME_MS = 8 * 60 * 60_000;
const SESSION_EXPIRY_CLOCK_SKEW_MS = 60_000;
// Generation-pinned verification can stream and authenticate a large archive
// plus every manifest member. Its DB claim must outlive the bounded engine
// request, otherwise the periodic reconciler can falsely fail healthy work.
const CLAIM_MS = ENGINE_TIMEOUT_MS + 5 * 60_000;
const MAX_ACTIVE_UPLOADS_PER_SOLVER = Number(
  process.env.REMOTE_EVIDENCE_MAX_ACTIVE_UPLOADS_PER_SOLVER ?? 8,
);
const MAX_ACTIVE_BYTES_PER_SOLVER = Number(
  process.env.REMOTE_EVIDENCE_MAX_ACTIVE_BYTES_PER_SOLVER ?? 64 * 1024 ** 3,
);

export interface BrokeredEvidenceRequest {
  idempotencyKey: string;
  promiseId: string;
  remoteResultId: string;
  remoteResultAttemptId: string;
  aoaDeg: number;
  engineJobId: string;
  engineCaseSlug: string | null;
  storedSha256: string;
  storedByteSize: number;
  tarSha256: string;
  tarByteSize: number;
  manifestSha256: string;
  manifestByteSize: number;
  zstdLevel: number;
  bundledFileCount: number;
}

export interface BrokeredEvidencePointer {
  schemaVersion: number;
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
}

type UploadRow = typeof syncBrokeredEvidenceUploads.$inferSelect;
type SolverRow = typeof registeredRemoteSolvers.$inferSelect;

function contentKey(sha256: string): string {
  return `solver-evidence/v1/sha256/${sha256.slice(0, 2)}/${sha256}.tar.zst`;
}

function identityPayload(row: UploadRow) {
  return {
    brokeredUploadId: row.id,
    promiseId: row.promiseId,
    promisePointId: row.promisePointId,
    solverId: row.solverId,
    sourceInstanceId: row.sourceInstanceId,
    remoteResultId: row.remoteResultId,
    remoteResultAttemptId: row.remoteResultAttemptId,
    aoaDeg: row.aoaDeg,
    engineJobId: row.engineJobId,
    engineCaseSlug: row.engineCaseSlug,
    bucket: row.bucket,
    objectKey: row.objectKey,
    storedSha256: row.storedSha256,
    storedSize: row.storedByteSize,
    tarSha256: row.tarSha256,
    tarSize: row.tarByteSize,
    manifestSha256: row.manifestSha256,
    manifestSize: row.manifestByteSize,
    zstdLevel: row.zstdLevel,
    bundledFileCount: row.bundledFileCount,
  };
}

function pointerFromRow(row: UploadRow): BrokeredEvidencePointer | null {
  if (!row.generation || !row.crc32c || !row.verifiedAt) return null;
  return {
    schemaVersion: 1,
    format: "tar+zstd",
    bucket: row.bucket,
    objectKey: row.objectKey,
    generation: row.generation,
    storedSha256: row.storedSha256,
    storedSize: row.storedByteSize,
    tarSha256: row.tarSha256,
    tarSize: row.tarByteSize,
    crc32c: row.crc32c,
    zstdLevel: row.zstdLevel,
    createdAt: row.verifiedAt.toISOString(),
  };
}

function verifiedPointerFromResponse(
  value: unknown,
  row: UploadRow,
): BrokeredEvidencePointer | null {
  if (!value || typeof value !== "object") return null;
  const remote = value as Record<string, unknown>;
  if (
    remote.schemaVersion !== 1 ||
    remote.format !== "tar+zstd" ||
    remote.bucket !== row.bucket ||
    remote.objectKey !== row.objectKey ||
    remote.storedSha256 !== row.storedSha256 ||
    remote.storedSize !== row.storedByteSize ||
    remote.tarSha256 !== row.tarSha256 ||
    remote.tarSize !== row.tarByteSize ||
    remote.zstdLevel !== row.zstdLevel ||
    typeof remote.generation !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(remote.generation) ||
    BigInt(remote.generation) > 18_446_744_073_709_551_615n ||
    typeof remote.crc32c !== "string" ||
    !/^[A-Za-z0-9+/]{6}==$/.test(remote.crc32c) ||
    typeof remote.createdAt !== "string" ||
    !Number.isFinite(Date.parse(remote.createdAt))
  )
    return null;
  return remote as unknown as BrokeredEvidencePointer;
}

function issuedSessionFromResponse(
  value: Record<string, unknown>,
  row: UploadRow,
): {
  uploadUrl: string;
  expiresAt: Date;
} | null {
  if (
    value.state !== "issued" ||
    typeof value.uploadUrl !== "string" ||
    value.uploadUrl.length > 8192 ||
    typeof value.expiresAt !== "string"
  )
    return null;
  const expiresAt = new Date(value.expiresAt);
  if (
    !isGcsResumableUploadUrl(value.uploadUrl, {
      bucket: row.bucket,
      objectKey: row.objectKey,
    }) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= new Date() ||
    expiresAt.getTime() >
      Date.now() + MAX_SESSION_LIFETIME_MS + SESSION_EXPIRY_CLOCK_SKEW_MS
  )
    return null;
  return { uploadUrl: value.uploadUrl, expiresAt };
}

function sameRequest(row: UploadRow, input: BrokeredEvidenceRequest): boolean {
  return (
    row.promiseId === input.promiseId &&
    row.remoteResultId === input.remoteResultId &&
    row.remoteResultAttemptId === input.remoteResultAttemptId &&
    row.aoaDeg === input.aoaDeg &&
    row.engineJobId === input.engineJobId &&
    row.engineCaseSlug === input.engineCaseSlug &&
    row.storedSha256 === input.storedSha256 &&
    row.storedByteSize === input.storedByteSize &&
    row.tarSha256 === input.tarSha256 &&
    row.tarByteSize === input.tarByteSize &&
    row.manifestSha256 === input.manifestSha256 &&
    row.manifestByteSize === input.manifestByteSize &&
    row.zstdLevel === input.zstdLevel &&
    row.bundledFileCount === input.bundledFileCount
  );
}

async function engineRequest(
  path: string,
  body: unknown,
  timeoutMs = ENGINE_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  if (!env.engineControlPlaneToken)
    throw new Error("engine control-plane token is not configured");
  const response = await fetch(`${env.engineUrl}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      authorization: `Bearer ${env.engineControlPlaneToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok)
    throw new Error(
      `engine evidence broker ${path} failed (${response.status}): ${
        typeof payload?.detail === "string"
          ? payload.detail.slice(0, 500)
          : "unknown error"
      }`,
    );
  if (!payload) throw new Error("engine evidence broker returned no payload");
  return payload;
}

type SessionCancellation =
  | { cancelled: true; statusCode: number }
  | { cancelled: false; error: string };

async function cancelBrokeredEvidenceSessionUrl(
  row: UploadRow,
): Promise<SessionCancellation> {
  try {
    const response = await engineRequest(
      "/internal/evidence-uploads/cancel-identity",
      {
        ...identityPayload(row),
        uploadUrl: row.uploadUrl,
      },
      ENGINE_CANCEL_TIMEOUT_MS,
    );
    if (
      response.state !== "cancelled" ||
      typeof response.statusCode !== "number" ||
      ![200, 204, 404, 410, 499].includes(response.statusCode)
    ) {
      return {
        cancelled: false,
        error:
          "engine returned an invalid session cancellation acknowledgement",
      };
    }
    return { cancelled: true, statusCode: response.statusCode };
  } catch (error) {
    return {
      cancelled: false,
      error:
        error instanceof Error
          ? error.message.slice(0, 700)
          : "bounded cancellation failed",
    };
  }
}

async function acknowledgeEngineSessionSettlement(
  row: UploadRow,
  final: boolean,
): Promise<void> {
  try {
    await engineRequest(
      "/internal/evidence-uploads/session-settled",
      {
        ...identityPayload(row),
        final,
        generation: final ? row.generation : null,
      },
      ENGINE_CANCEL_TIMEOUT_MS,
    );
  } catch {
    // The hub DB is authoritative once its exact row settles. A missed
    // acknowledgement deliberately leaves the engine-side durable intent in
    // place for reconciliation; it never exposes or invalidates the bearer.
  }
}

async function cancelBrokeredEvidenceSessions(database: DB): Promise<void> {
  const rows = await database
    .select()
    .from(syncBrokeredEvidenceUploads)
    .where(
      and(
        inArray(syncBrokeredEvidenceUploads.state, [
          "failed",
          "revoked",
          "expired",
        ]),
        sql`${syncBrokeredEvidenceUploads.sessionCancellationAcknowledgedAt} IS NULL`,
      ),
    )
    .limit(100);
  for (const row of rows) {
    const cancellation = await cancelBrokeredEvidenceSessionUrl(row);
    if (cancellation.cancelled) {
      await database
        .update(syncBrokeredEvidenceUploads)
        .set({
          uploadUrl: null,
          uploadExpiresAt: null,
          sessionCancellationAcknowledgedAt: new Date(),
          lastError: `resumable upload session cancellation acknowledged (${cancellation.statusCode})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncBrokeredEvidenceUploads.id, row.id),
            sql`${syncBrokeredEvidenceUploads.uploadUrl} IS NOT DISTINCT FROM ${row.uploadUrl}`,
            inArray(syncBrokeredEvidenceUploads.state, [
              "failed",
              "revoked",
              "expired",
            ]),
          ),
        );
    } else {
      await database
        .update(syncBrokeredEvidenceUploads)
        .set({
          lastError: `resumable upload session cancellation pending: ${cancellation.error}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncBrokeredEvidenceUploads.id, row.id),
            sql`${syncBrokeredEvidenceUploads.uploadUrl} IS NOT DISTINCT FROM ${row.uploadUrl}`,
          ),
        );
    }
  }
}

/** Terminalize invalid capabilities first, then actively cancel their GCS
 * bearer sessions. A failed cancellation retains the protected hub-only URL
 * for bounded retry while every verify/bind path remains fail closed. */
export async function expireBrokeredEvidenceUploads(
  database: DB,
): Promise<void> {
  const now = new Date();
  await database
    .update(syncBrokeredEvidenceUploads)
    .set({
      state: "expired",
      claimToken: null,
      claimExpiresAt: null,
      lastError: "resumable upload capability expired; cancellation pending",
      updatedAt: now,
    })
    .where(
      and(
        eq(syncBrokeredEvidenceUploads.state, "issued"),
        sql`${syncBrokeredEvidenceUploads.uploadExpiresAt} <= now()`,
      ),
    );
  await database.execute(sql`
    UPDATE sync_brokered_evidence_uploads
    SET state = 'failed', claim_token = NULL, claim_expires_at = NULL,
        last_error = 'broker claim expired; session cancellation pending', "updatedAt" = now()
    WHERE state IN ('issuing', 'verifying') AND claim_expires_at <= now()
  `);
  await database.execute(sql`
    UPDATE sync_brokered_evidence_uploads upload
    SET state = 'revoked', claim_token = NULL, claim_expires_at = NULL,
        revoked_at = COALESCE(upload.revoked_at, now()),
        last_error = 'owning promise or solver credential was revoked; session cancellation pending', "updatedAt" = now()
    FROM sync_sweep_promises promise, registered_remote_solvers solver
    WHERE upload.promise_id = promise.id AND upload.solver_id = solver.id
      AND upload.state IN ('requested', 'issuing', 'issued', 'verifying', 'failed', 'verified')
      AND (promise.status IN ('cancelled', 'expired') OR promise."expiresAt" <= now() OR solver.revoked_at IS NOT NULL)
  `);
  await cancelBrokeredEvidenceSessions(database);
}

export async function requestBrokeredEvidenceUpload(
  database: DB,
  solver: SolverRow,
  input: BrokeredEvidenceRequest,
): Promise<
  | {
      state: "issued";
      id: string;
      uploadUrl: string;
      expiresAt: string;
      bucket: string;
      objectKey: string;
    }
  | { state: "verified" | "bound"; id: string; remote: BrokeredEvidencePointer }
> {
  await expireBrokeredEvidenceUploads(database);
  const bucket = env.evidenceBucket;
  if (!bucket)
    throw new Error("GCS evidence bucket is not configured on the hub");
  const claimedOrExisting = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // Serialize the per-solver quota and idempotency decision across every API
    // process. The engine call happens only after this transaction commits.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`remote-evidence-broker:${solver.id}`}, 0))`,
    );
    const objectKey = contentKey(input.storedSha256);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`remote-evidence-object:${bucket}:${objectKey}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(syncBrokeredEvidenceUploads)
      .where(
        and(
          eq(syncBrokeredEvidenceUploads.solverId, solver.id),
          eq(syncBrokeredEvidenceUploads.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      if (!sameRequest(existing, input))
        throw new Error("idempotency key already names different evidence");
      const pointer = pointerFromRow(existing);
      if (
        (existing.state === "verified" || existing.state === "bound") &&
        pointer
      )
        return {
          kind: "existing" as const,
          response: {
            state: existing.state as "verified" | "bound",
            id: existing.id,
            remote: pointer,
          },
        };
      if (
        existing.state === "issued" &&
        existing.uploadUrl &&
        existing.uploadExpiresAt &&
        existing.uploadExpiresAt > new Date() &&
        isGcsResumableUploadUrl(existing.uploadUrl, {
          bucket: existing.bucket,
          objectKey: existing.objectKey,
        })
      ) {
        const recoveryClaimToken = randomUUID();
        const [recovering] = await tx
          .update(syncBrokeredEvidenceUploads)
          .set({
            state: "issuing",
            claimToken: recoveryClaimToken,
            claimExpiresAt: new Date(Date.now() + CLAIM_MS),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(syncBrokeredEvidenceUploads.id, existing.id),
              eq(syncBrokeredEvidenceUploads.state, "issued"),
              eq(syncBrokeredEvidenceUploads.uploadUrl, existing.uploadUrl),
            ),
          )
          .returning();
        if (!recovering)
          throw new Error("brokered evidence recovery is already in progress");
        return {
          // Re-enter the engine's exact durable session ledger before
          // replaying an issued URL.  GCS may have committed the final PUT
          // even though the remote solver lost its completion response; the
          // engine can discover and fully verify that one exact generation.
          kind: "recover" as const,
          row: recovering,
          claimToken: recoveryClaimToken,
        };
      }
      if (["issuing", "verifying"].includes(existing.state))
        throw new Error("brokered evidence upload is already being processed");
      if (existing.state === "revoked")
        throw new Error("brokered evidence upload is revoked");
      if (
        existing.state === "expired" &&
        existing.sessionCancellationAcknowledgedAt === null
      )
        throw new Error(
          "expired resumable upload session cancellation is pending",
        );
      if (
        existing.state === "failed" &&
        existing.sessionCancellationAcknowledgedAt === null
      )
        throw new Error(
          "previous resumable upload session cancellation is pending",
        );
    }

    const [uncancelledSession] = await tx
      .select({ id: syncBrokeredEvidenceUploads.id })
      .from(syncBrokeredEvidenceUploads)
      .where(
        and(
          eq(syncBrokeredEvidenceUploads.bucket, bucket),
          eq(syncBrokeredEvidenceUploads.objectKey, objectKey),
          inArray(syncBrokeredEvidenceUploads.state, [
            "failed",
            "revoked",
            "expired",
          ]),
          sql`${syncBrokeredEvidenceUploads.sessionCancellationAcknowledgedAt} IS NULL`,
        ),
      )
      .limit(1);
    if (uncancelledSession)
      throw new Error(
        "content-addressed key has a resumable session cancellation pending",
      );

    const [promise] = await tx
      .select()
      .from(syncSweepPromises)
      .where(eq(syncSweepPromises.id, input.promiseId))
      .for("update")
      .limit(1);
    if (
      !promise ||
      promise.status !== "active" ||
      promise.expiresAt <= new Date() ||
      promise.sourceInstanceId !== solver.instanceId ||
      String(
        (promise.requestPayload as Record<string, unknown> | null)?.solverId ??
          "",
      ) !== solver.id
    )
      throw new Error("exact active promise is not owned by this solver");
    const [point] = await tx
      .select()
      .from(syncSweepPromisePoints)
      .where(
        and(
          eq(syncSweepPromisePoints.promiseId, promise.id),
          eq(syncSweepPromisePoints.aoaDeg, input.aoaDeg),
        ),
      )
      .for("update")
      .limit(1);
    if (!point || point.status !== "active")
      throw new Error("exact active promise point is unavailable");

    const [quota] = await tx
      .select({
        n: count(),
        bytes: sql<number>`COALESCE(SUM(${syncBrokeredEvidenceUploads.storedByteSize}), 0)::float8`,
      })
      .from(syncBrokeredEvidenceUploads)
      .where(
        and(
          eq(syncBrokeredEvidenceUploads.solverId, solver.id),
          or(
            inArray(syncBrokeredEvidenceUploads.state, [
              "issuing",
              "verifying",
            ]),
            sql`${syncBrokeredEvidenceUploads.uploadUrl} IS NOT NULL`,
            and(
              inArray(syncBrokeredEvidenceUploads.state, [
                "failed",
                "revoked",
                "expired",
              ]),
              sql`${syncBrokeredEvidenceUploads.sessionCancellationAcknowledgedAt} IS NULL`,
            ),
          ),
        ),
      );
    if (Number(quota?.n ?? 0) >= MAX_ACTIVE_UPLOADS_PER_SOLVER)
      throw new Error(
        "remote solver has reached its active evidence-upload quota",
      );
    if (
      Number(quota?.bytes ?? 0) + input.storedByteSize >
      MAX_ACTIVE_BYTES_PER_SOLVER
    )
      throw new Error(
        "remote solver has reached its active evidence-byte quota",
      );

    const row =
      existing ??
      (
        await tx
          .insert(syncBrokeredEvidenceUploads)
          .values({
            idempotencyKey: input.idempotencyKey,
            promiseId: promise.id,
            promisePointId: point.id,
            solverId: solver.id,
            sourceInstanceId: solver.instanceId,
            remoteResultId: input.remoteResultId,
            remoteResultAttemptId: input.remoteResultAttemptId,
            aoaDeg: input.aoaDeg,
            engineJobId: input.engineJobId,
            engineCaseSlug: input.engineCaseSlug,
            bucket,
            objectKey,
            storedSha256: input.storedSha256,
            storedByteSize: input.storedByteSize,
            tarSha256: input.tarSha256,
            tarByteSize: input.tarByteSize,
            manifestSha256: input.manifestSha256,
            manifestByteSize: input.manifestByteSize,
            zstdLevel: input.zstdLevel,
            bundledFileCount: input.bundledFileCount,
            state: "requested",
            updatedAt: new Date(),
          })
          .returning()
      )[0];
    if (!row) throw new Error("could not create brokered evidence request");
    const claimToken = randomUUID();
    const [claimed] = await tx
      .update(syncBrokeredEvidenceUploads)
      .set({
        state: "issuing",
        attemptCount: row.attemptCount + 1,
        claimToken,
        claimExpiresAt: new Date(Date.now() + CLAIM_MS),
        lastError: null,
        sessionCancellationAcknowledgedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncBrokeredEvidenceUploads.id, row.id),
          or(
            inArray(syncBrokeredEvidenceUploads.state, ["requested", "failed"]),
            and(
              eq(syncBrokeredEvidenceUploads.state, "expired"),
              isNotNull(
                syncBrokeredEvidenceUploads.sessionCancellationAcknowledgedAt,
              ),
              isNull(syncBrokeredEvidenceUploads.uploadUrl),
              isNull(syncBrokeredEvidenceUploads.uploadExpiresAt),
            ),
          ),
        ),
      )
      .returning();
    if (!claimed)
      throw new Error("concurrent broker request is already in progress");
    return { kind: "claimed" as const, claimed, claimToken };
  });
  if (claimedOrExisting.kind === "existing") return claimedOrExisting.response;
  if (claimedOrExisting.kind === "recover") {
    const existing = claimedOrExisting.row;
    const recoveryClaimToken = claimedOrExisting.claimToken;
    try {
      const response = await engineRequest(
        "/internal/evidence-uploads/session",
        identityPayload(existing),
      );
      if (response.state === "verified") {
        const remote = verifiedPointerFromResponse(response.remote, existing);
        if (!remote)
          throw new Error(
            "engine returned a mismatched recovered evidence pointer",
          );
        const [settled] = await database
          .update(syncBrokeredEvidenceUploads)
          .set({
            state: "verified",
            claimToken: null,
            claimExpiresAt: null,
            uploadUrl: null,
            uploadExpiresAt: null,
            generation: remote.generation,
            crc32c: remote.crc32c,
            verifiedAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(syncBrokeredEvidenceUploads.id, existing.id),
              eq(syncBrokeredEvidenceUploads.state, "issuing"),
              eq(syncBrokeredEvidenceUploads.claimToken, recoveryClaimToken),
            ),
          )
          .returning();
        if (settled) {
          await acknowledgeEngineSessionSettlement(settled, true);
          return {
            state: "verified",
            id: settled.id,
            remote: pointerFromRow(settled)!,
          };
        }
        const [raced] = await database
          .select()
          .from(syncBrokeredEvidenceUploads)
          .where(eq(syncBrokeredEvidenceUploads.id, existing.id))
          .limit(1);
        const racedPointer = raced ? pointerFromRow(raced) : null;
        if (
          raced &&
          racedPointer &&
          (raced.state === "verified" || raced.state === "bound")
        )
          return { state: raced.state, id: raced.id, remote: racedPointer };
        throw new Error(
          "recovered evidence generation lost its settlement race",
        );
      }
      const replayed = issuedSessionFromResponse(response, existing);
      if (
        !replayed ||
        replayed.uploadUrl !== existing.uploadUrl ||
        replayed.expiresAt.getTime() !== existing.uploadExpiresAt!.getTime()
      )
        throw new Error(
          "engine durable session replay changed capability identity",
        );
      const [released] = await database
        .update(syncBrokeredEvidenceUploads)
        .set({
          state: "issued",
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncBrokeredEvidenceUploads.id, existing.id),
            eq(syncBrokeredEvidenceUploads.state, "issuing"),
            eq(syncBrokeredEvidenceUploads.claimToken, recoveryClaimToken),
          ),
        )
        .returning();
      if (!released)
        throw new Error("brokered evidence replay lost its recovery claim");
      return {
        state: "issued",
        id: released.id,
        uploadUrl: released.uploadUrl!,
        expiresAt: released.uploadExpiresAt!.toISOString(),
        bucket: released.bucket,
        objectKey: released.objectKey,
      };
    } catch (error) {
      await database
        .update(syncBrokeredEvidenceUploads)
        .set({
          state: "issued",
          claimToken: null,
          claimExpiresAt: null,
          lastError:
            error instanceof Error
              ? `exact object recovery probe failed: ${error.message}`.slice(
                  0,
                  1000,
                )
              : "exact object recovery probe failed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncBrokeredEvidenceUploads.id, existing.id),
            eq(syncBrokeredEvidenceUploads.state, "issuing"),
            eq(syncBrokeredEvidenceUploads.claimToken, recoveryClaimToken),
          ),
        );
      throw error;
    }
  }
  const { claimed, claimToken } = claimedOrExisting;
  let issuedSession: { uploadUrl: string; expiresAt: Date } | null = null;

  try {
    const response = await engineRequest(
      "/internal/evidence-uploads/session",
      identityPayload(claimed),
    );
    if (response.state === "verified") {
      const remote = verifiedPointerFromResponse(response.remote, claimed);
      if (!remote)
        throw new Error(
          "engine returned a mismatched verified evidence pointer",
        );
      const [settled] = await database
        .update(syncBrokeredEvidenceUploads)
        .set({
          state: "verified",
          claimToken: null,
          claimExpiresAt: null,
          uploadUrl: null,
          uploadExpiresAt: null,
          generation: remote.generation,
          crc32c: remote.crc32c,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncBrokeredEvidenceUploads.id, claimed.id),
            eq(syncBrokeredEvidenceUploads.state, "issuing"),
            eq(syncBrokeredEvidenceUploads.claimToken, claimToken),
          ),
        )
        .returning();
      if (!settled)
        throw new Error("broker issue claim was lost before settlement");
      await acknowledgeEngineSessionSettlement(settled, true);
      return {
        state: "verified",
        id: settled.id,
        remote: pointerFromRow(settled)!,
      };
    }
    issuedSession = issuedSessionFromResponse(response, claimed);
    if (!issuedSession)
      throw new Error("engine returned an invalid upload session response");
    const { uploadUrl, expiresAt } = issuedSession;
    const [settled] = await database
      .update(syncBrokeredEvidenceUploads)
      .set({
        state: "issued",
        claimToken: null,
        claimExpiresAt: null,
        uploadUrl,
        uploadExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncBrokeredEvidenceUploads.id, claimed.id),
          eq(syncBrokeredEvidenceUploads.state, "issuing"),
          eq(syncBrokeredEvidenceUploads.claimToken, claimToken),
        ),
      )
      .returning();
    if (!settled) {
      throw new Error("broker issue claim was lost before settlement");
    }
    await acknowledgeEngineSessionSettlement(settled, false);
    return {
      state: "issued",
      id: settled.id,
      uploadUrl,
      expiresAt: expiresAt.toISOString(),
      bucket: settled.bucket,
      objectKey: settled.objectKey,
    };
  } catch (error) {
    const errorText =
      error instanceof Error
        ? error.message.slice(0, 1000)
        : "upload session failed";
    const cancellation = await cancelBrokeredEvidenceSessionUrl({
      ...claimed,
      uploadUrl: issuedSession?.uploadUrl ?? null,
      uploadExpiresAt: issuedSession?.expiresAt ?? null,
    });
    const retainedUrl =
      !cancellation.cancelled && issuedSession ? issuedSession.uploadUrl : null;
    const retainedExpiry =
      retainedUrl && issuedSession ? issuedSession.expiresAt : null;
    const cancellationText = cancellation.cancelled
      ? `; resumable upload session cancellation acknowledged (${cancellation.statusCode})`
      : `; resumable upload session cancellation pending: ${cancellation.error}`;
    // The first update owns the normal issuing state. The second covers a
    // concurrent promise/credential revocation that won the state race after
    // GCS issued the capability. Either way a failed cancellation leaves the
    // protected hub-only bearer durable for the periodic reconciler.
    await database
      .update(syncBrokeredEvidenceUploads)
      .set({
        state: "failed",
        claimToken: null,
        claimExpiresAt: null,
        uploadUrl: retainedUrl,
        uploadExpiresAt: retainedExpiry,
        sessionCancellationAcknowledgedAt: cancellation.cancelled
          ? new Date()
          : null,
        lastError: `${errorText}${cancellationText}`.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncBrokeredEvidenceUploads.id, claimed.id),
          eq(syncBrokeredEvidenceUploads.state, "issuing"),
          eq(syncBrokeredEvidenceUploads.claimToken, claimToken),
        ),
      );
    await database
      .update(syncBrokeredEvidenceUploads)
      .set({
        uploadUrl: retainedUrl,
        uploadExpiresAt: retainedExpiry,
        sessionCancellationAcknowledgedAt: cancellation.cancelled
          ? new Date()
          : null,
        lastError: `${errorText}${cancellationText}`.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncBrokeredEvidenceUploads.id, claimed.id),
          inArray(syncBrokeredEvidenceUploads.state, [
            "failed",
            "revoked",
            "expired",
          ]),
        ),
      );
    throw error;
  }
}

export interface BrokeredEvidenceUploadReconciler {
  runOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

/** Periodically expires and cancels idle resumable capabilities. Runs never
 * overlap, and stop waits for the active bounded pass before DB shutdown. */
export function createBrokeredEvidenceUploadReconciler(
  database: DB,
  options: {
    intervalMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): BrokeredEvidenceUploadReconciler {
  const intervalMs = Math.max(5_000, options.intervalMs ?? 60_000);
  let timer: ReturnType<typeof setInterval> | null = null;
  let active: Promise<void> | null = null;
  let stopping = false;
  const runOnce = async () => {
    if (stopping) return;
    if (active) return active;
    active = expireBrokeredEvidenceUploads(database)
      .catch((error) => options.onError?.(error))
      .finally(() => {
        active = null;
      });
    return active;
  };
  return {
    runOnce,
    start() {
      if (timer || stopping) return;
      void runOnce();
      timer = setInterval(() => void runOnce(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    },
  };
}

export async function verifyBrokeredEvidenceUpload(
  database: DB,
  solver: SolverRow,
  uploadId: string,
  generation: string,
): Promise<{
  state: "verified" | "bound";
  id: string;
  remote: BrokeredEvidencePointer;
}> {
  await expireBrokeredEvidenceUploads(database);
  const [row] = await database
    .select()
    .from(syncBrokeredEvidenceUploads)
    .where(
      and(
        eq(syncBrokeredEvidenceUploads.id, uploadId),
        eq(syncBrokeredEvidenceUploads.solverId, solver.id),
      ),
    )
    .limit(1);
  if (!row) throw new Error("brokered evidence upload was not found");
  const existing = pointerFromRow(row);
  if ((row.state === "verified" || row.state === "bound") && existing)
    return { state: row.state, id: row.id, remote: existing };
  if (
    row.state !== "issued" ||
    !row.uploadExpiresAt ||
    row.uploadExpiresAt <= new Date()
  )
    throw new Error(
      `brokered evidence upload cannot be verified from state ${row.state}`,
    );

  const claimToken = randomUUID();
  const [claimed] = await database
    .update(syncBrokeredEvidenceUploads)
    .set({
      state: "verifying",
      claimToken,
      claimExpiresAt: new Date(Date.now() + CLAIM_MS),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(syncBrokeredEvidenceUploads.id, row.id),
        eq(syncBrokeredEvidenceUploads.state, "issued"),
      ),
    )
    .returning();
  if (!claimed)
    throw new Error(
      "brokered evidence upload verification is already in progress",
    );
  try {
    const response = await engineRequest("/internal/evidence-uploads/verify", {
      ...identityPayload(claimed),
      generation,
    });
    const remote = verifiedPointerFromResponse(response.remote, claimed);
    if (
      response.state !== "verified" ||
      !remote ||
      remote.generation !== generation ||
      response.manifestSha256 !== claimed.manifestSha256 ||
      response.manifestSize !== claimed.manifestByteSize ||
      response.bundledFileCount !== claimed.bundledFileCount
    )
      throw new Error("engine returned an invalid verification response");
    const [settled] = await database
      .update(syncBrokeredEvidenceUploads)
      .set({
        state: "verified",
        claimToken: null,
        claimExpiresAt: null,
        uploadUrl: null,
        uploadExpiresAt: null,
        generation: remote.generation,
        crc32c: remote.crc32c,
        verifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncBrokeredEvidenceUploads.id, claimed.id),
          eq(syncBrokeredEvidenceUploads.state, "verifying"),
          eq(syncBrokeredEvidenceUploads.claimToken, claimToken),
        ),
      )
      .returning();
    if (!settled)
      throw new Error("broker verification claim was lost before settlement");
    await acknowledgeEngineSessionSettlement(settled, true);
    return {
      state: "verified",
      id: settled.id,
      remote: pointerFromRow(settled)!,
    };
  } catch (error) {
    await database
      .update(syncBrokeredEvidenceUploads)
      .set({
        state: "failed",
        claimToken: null,
        claimExpiresAt: null,
        lastError:
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "verification failed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncBrokeredEvidenceUploads.id, claimed.id),
          eq(syncBrokeredEvidenceUploads.state, "verifying"),
          eq(syncBrokeredEvidenceUploads.claimToken, claimToken),
        ),
      );
    await cancelBrokeredEvidenceSessions(database);
    throw error;
  }
}

export async function fetchBoundBrokeredEvidenceArchive(
  database: DB,
  solver: SolverRow,
  uploadId: string,
): Promise<{
  body: ReadableStream<Uint8Array>;
  size: number;
  mimeType: "application/zstd";
  storedSha256: string;
  generation: string;
}> {
  const [row] = await database
    .select()
    .from(syncBrokeredEvidenceUploads)
    .where(
      and(
        eq(syncBrokeredEvidenceUploads.id, uploadId),
        eq(syncBrokeredEvidenceUploads.solverId, solver.id),
        eq(syncBrokeredEvidenceUploads.state, "bound"),
      ),
    )
    .limit(1);
  if (
    !row ||
    !row.generation ||
    !row.crc32c ||
    !row.verifiedAt ||
    !row.canonicalArtifactId
  )
    throw new Error("bound brokered evidence generation was not found");
  if (!env.engineControlPlaneToken)
    throw new Error("engine control-plane token is not configured");
  const response = await fetch(
    `${env.engineUrl}/internal/evidence-uploads/download`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${env.engineControlPlaneToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...identityPayload(row),
        generation: row.generation,
        crc32c: row.crc32c,
        createdAt: row.verifiedAt.toISOString(),
      }),
    },
  );
  if (!response.ok || !response.body)
    throw new Error(
      `engine evidence archive fetch failed (${response.status})`,
    );
  const contentLength = Number(response.headers.get("content-length"));
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength !== row.storedByteSize ||
    response.headers.get("content-type")?.split(";", 1)[0] !==
      "application/zstd" ||
    response.headers.get("x-content-sha256") !== row.storedSha256 ||
    response.headers.get("x-gcs-generation") !== row.generation
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(
      "engine evidence archive response changed immutable identity",
    );
  }
  return {
    body: response.body,
    size: contentLength,
    mimeType: "application/zstd",
    storedSha256: row.storedSha256,
    generation: row.generation,
  };
}

export async function revokeSolverEvidenceUploads(
  database: DB,
  solverId: string,
): Promise<{ pendingSessionCount: number }> {
  const now = new Date();
  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`remote-evidence-broker:${solverId}`}, 0))`,
    );
    await tx
      .update(registeredRemoteSolvers)
      .set({
        revokedAt: now,
        authTokenHash: null,
        status: "disabled",
        updatedAt: now,
      })
      .where(eq(registeredRemoteSolvers.id, solverId));
    await tx.execute(sql`
      UPDATE sync_brokered_evidence_uploads
      SET state = 'revoked', revoked_at = now(), claim_token = NULL,
          claim_expires_at = NULL,
          last_error = 'remote solver credential revoked; session cancellation pending', "updatedAt" = now()
      WHERE solver_id = ${solverId}::uuid
        AND state IN ('requested', 'issuing', 'issued', 'verifying', 'failed', 'verified')
    `);
  });
  await cancelBrokeredEvidenceSessions(database);
  const [pending] = await database
    .select({ n: count() })
    .from(syncBrokeredEvidenceUploads)
    .where(
      and(
        eq(syncBrokeredEvidenceUploads.solverId, solverId),
        inArray(syncBrokeredEvidenceUploads.state, [
          "failed",
          "revoked",
          "expired",
        ]),
        sql`${syncBrokeredEvidenceUploads.sessionCancellationAcknowledgedAt} IS NULL`,
      ),
    );
  return { pendingSessionCount: Number(pending?.n ?? 0) };
}
