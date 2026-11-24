import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "@aerodb/db/client";
import { getAttemptEvidenceArchive } from "@aerodb/db/attempt-evidence-catalog";
import {
  prepareAttemptEvidenceProjection,
  type AttemptEvidenceFreshVerification,
} from "@aerodb/db/attempt-evidence-projection";
import type { AttemptEvidenceSettlementDependencies } from "../src/attempt-evidence-settlement";

export async function verifiedHubFixtureProof(
  db: DB,
  deps: AttemptEvidenceSettlementDependencies,
  attemptId: string,
  archiveId: string,
): Promise<AttemptEvidenceFreshVerification> {
  const archive = await getAttemptEvidenceArchive(db, archiveId);
  const original = await deps.store.read(archive);
  const directAt = new Date().toISOString();
  const owner = {
    attemptId,
    archiveId,
    sourceSha256: archive.sourceSha256,
    sourceByteSize: archive.sourceByteSize,
  };
  const { payloadText, ...app } = await deps.readApp({
    ...owner,
    forceArchive: true,
  });
  expect(payloadText).toBe(original.payloadText);
  const dependencies = await deps.verifyDependencies({
    attemptId,
    archive,
    originalPayloadText: original.payloadText,
    preview: await prepareAttemptEvidenceProjection(db, attemptId, archiveId),
  });
  return {
    direct: {
      ...owner,
      bucket: archive.bucket,
      objectKey: archive.objectKey,
      generation: archive.generation,
      crc32c: archive.crc32c,
      storedSha256: archive.storedSha256,
      storedByteSize: archive.storedByteSize,
      verifiedAt: directAt,
    },
    app: { ...app, forceArchive: true, verifiedAt: new Date().toISOString() },
    dependencies,
  };
}

/** Exercise the actual native transition in a rolled-back SQL transaction.
 * The production readbacks were taken before this measurement. A higher test
 * floor can separate two real representations without weakening any guard. */
export async function measuredFixtureFloor(
  db: DB,
  attemptId: string,
  archiveId: string,
  proof: AttemptEvidenceFreshVerification,
) {
  const rolledBack = new Error("discard measured fixture transition");
  let nativeNet: number | undefined;
  try {
    await db.transaction(async (tx) => {
      if (proof.direct.sourceByteSize >= 4 * 1024 * 1024)
        await tx.execute(
          sql`SELECT attempt_evidence_seal_projection(${attemptId}::uuid,${archiveId}::uuid)`,
        );
      const [row] = await tx.execute(
        sql`SELECT attempt_evidence_shorten(${attemptId}::uuid,${archiveId}::uuid,${JSON.stringify(proof)}::jsonb) value`,
      );
      nativeNet = Number(
        (row!.value as { netValueBytesReclaimed: number })
          .netValueBytesReclaimed,
      );
      throw rolledBack;
    });
  } catch (error) {
    if (error !== rolledBack) {
      const pg =
        (error as { cause?: { code?: string } }).cause ??
        (error as { code?: string });
      if (pg.code !== "P0002") throw error;
    }
  }
  const [unchanged] = await db.execute(
    sql`SELECT evidence_archive_id AS archive FROM result_attempts WHERE id=${attemptId}::uuid`,
  );
  expect(unchanged.archive).toBeNull();
  return Math.max(1024, (nativeNet ?? 0) + 32);
}

export async function assertShortProof(
  db: DB,
  attemptId: string,
  archiveId: string,
  expected?: AttemptEvidenceFreshVerification,
) {
  const [proof] =
    await db.execute(sql`SELECT e.verification?'shortReceipt' AS packed_event,p.projection?'shortFacts' AS packed_projection,
    e.net_value_bytes_saved AS saved,e.app_readback_at,e.source_stored_bytes AS original_value,
    pg_column_size(a.evidence_payload) compact_value,pg_column_size(p.projection) projection_bytes,pg_column_size(e.verification) event_bytes,
    e.projection_value_bytes AS recorded_projection,e.verification_value_bytes AS recorded_event,
    v.verification,fullp.projection,ar.generation,
    ${expected ? sql`v.verification::text=(${JSON.stringify(expected)}::jsonb)::text` : sql`true`} AS exact_submitted_receipt
    FROM result_attempts a JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id AND e.result_attempt_id=a.id
    JOIN attempt_evidence_history_projections p ON p.archive_id=e.archive_id AND p.result_attempt_id=a.id
    JOIN attempt_evidence_read_projections fullp ON fullp.result_attempt_id=a.id AND fullp.archive_id=e.archive_id
    JOIN attempt_evidence_read_events v ON v.id=e.id JOIN attempt_evidence_archives ar ON ar.id=e.archive_id
    WHERE a.id=${attemptId}::uuid AND a.evidence_archive_id=${archiveId}::uuid`);
  expect(proof).toMatchObject({ packed_event: true, packed_projection: true });
  expect(proof.app_readback_at).toBeTruthy();
  expect(Number(proof.saved)).toBe(
    Number(proof.original_value) -
      Number(proof.compact_value) -
      Number(proof.projection_bytes) -
      Number(proof.event_bytes),
  );
  expect(Number(proof.saved)).toBeGreaterThanOrEqual(1024);
  expect(Number(proof.recorded_projection)).toBe(
    Number(proof.projection_bytes),
  );
  expect(Number(proof.recorded_event)).toBe(Number(proof.event_bytes));
  expect(proof.exact_submitted_receipt).toBe(true);
  return proof;
}
