import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { PostgresJsPreparedQuery } from "drizzle-orm/postgres-js/session";
import { expect, vi } from "vitest";
import type { DB } from "@aerodb/db/client";
import {
  crc32c,
  encodeResultHistory,
  ResultHistoryGcsStore,
  type ResultHistoryGcsClient,
  type ResultHistoryKind,
} from "@aerodb/core/result-history-storage";
import {
  loadResultHistorySource,
  offloadResultHistory,
  registerResultHistoryArchive,
} from "@aerodb/db/result-history-storage";
import { SettlementGcs } from "../../sweeper/test-support/attempt-settlement-fixture";
import {
  apiAttemptEvidenceReader,
  readStoredAttemptEvidenceText,
} from "../src/attempt-evidence-reader";
import { registerRoutes } from "../src/routes";
import { withProgressiveSyncApi } from "./progressive-polar-import-fixture";

export async function selectedDetailBaseline(db: DB, attemptId: string) {
  const [row] =
    await db.execute(sql`SELECT f.slug,a.result_id FROM result_attempts a
    JOIN airfoils f ON f.id=a.airfoil_id WHERE a.id=${attemptId}::uuid`);
  const url = `/api/airfoils/${row.slug}/sim?resultId=${row.result_id}&resultAttemptId=${attemptId}`;
  const body = await withProgressiveSyncApi(db, async (app) => {
    await registerRoutes(app);
    const execute = PostgresJsPreparedQuery.prototype.execute;
    let selected = 0;
    const observed = vi
      .spyOn(PostgresJsPreparedQuery.prototype, "execute")
      .mockImplementation(async function (...args) {
        const rows = await execute.apply(this, args);
        if (
          Array.isArray(rows) &&
          rows[0]?.result?.id === row.result_id &&
          rows[0]?.attempt?.id === attemptId
        ) {
          selected++;
          const attempt = rows[0].attempt;
          expect(attempt).not.toHaveProperty("evidencePayload");
          if (attempt.evidenceArchiveId)
            expect(attempt.detailPayload).toBeNull();
          else
            expect(Object.keys(attempt.detailPayload).sort()).toEqual(
              [
                "frame_track",
                "frameTrack",
                "steady_history",
                "steadyHistory",
                "fidelity",
              ].sort(),
            );
        }
        return rows;
      });
    try {
      const reply = await app.inject({ url });
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.json()).toMatchObject({
        resultId: row.result_id,
        resultAttemptId: attemptId,
      });
      expect(selected).toBe(1);
      return reply.json();
    } finally {
      observed.mockRestore();
    }
  });
  return { url, body, attemptId, resultId: String(row.result_id) };
}

/** Uses the real settled CFD receipt in a disposable campaign database.
 * The source must be the selected result's published PostgreSQL field. */
export async function verifySelectedDetailField(
  db: DB,
  baseline: Awaited<ReturnType<typeof selectedDetailBaseline>>,
  sourceKind: ResultHistoryKind,
) {
  const { attemptId, resultId, url, body } = baseline;
  const displayField =
    sourceKind === "frame_track" ? "frameTrack" : "steadyHistory";
  expect(body[displayField]).toBeTruthy();
  const [cold] =
    await db.execute(sql`SELECT evidence_archive_id,evidence_storage_event_id FROM result_attempts
    WHERE id=${attemptId}::uuid AND result_id=${resultId}::uuid`);
  expect(cold.evidence_archive_id).toBeTruthy();
  expect(cold.evidence_storage_event_id).toBeTruthy();

  const original = await readStoredAttemptEvidenceText(db, attemptId);
  const source = await loadResultHistorySource(db, resultId, sourceKind);
  expect(source.resultAttemptId).toBe(attemptId);
  expect(JSON.parse(source.payloadText)).toEqual(
    JSON.parse(original)[sourceKind],
  );

  const memory = new SettlementGcs();
  const store = new ResultHistoryGcsStore(
    memory as unknown as ResultHistoryGcsClient,
  );
  const encoded = encodeResultHistory("fixture", source);
  const { stored, ...hashes } = encoded;
  const identity = {
    ...hashes,
    sourceInstance: "fixture",
    sourceKind,
    resultId,
    resultAttemptId: attemptId,
    bucket: "fixture",
    objectKey: `result-histories/v1/fixture/${sourceKind}/${resultId}/${hashes.storedSha256}.json.gz`,
    generation: "18446744073709551615",
    crc32c: crc32c(stored),
    verifiedAt: new Date(),
  };
  memory.objects.set(`fixture/${identity.objectKey}`, {
    bytes: stored,
    metadata: {
      contentType: "application/gzip",
      size: String(stored.length),
      generation: identity.generation,
      crc32c: identity.crc32c,
      metadata: { format: "result-history-v1", sha256: hashes.storedSha256 },
    },
  });
  const restore = store.read.bind(store);
  expect((await restore(identity)).payloadText).toBe(source.payloadText);

  const full = vi.spyOn(apiAttemptEvidenceReader, "read");
  const field = vi
    .spyOn(ResultHistoryGcsStore.prototype, "read")
    .mockImplementation(restore);
  try {
    await withProgressiveSyncApi(db, async (app) => {
      await registerRoutes(app);
      const get = () => app.inject({ url });
      const exact = async () => {
        const reply = await get();
        expect(reply.statusCode, reply.body).toBe(200);
        expect(reply.json()).toEqual(body);
      };
      await exact();
      expect(full).not.toHaveBeenCalled();
      expect(field).not.toHaveBeenCalled();

      const archive = await registerResultHistoryArchive(db, identity);
      expect(await offloadResultHistory(db, archive)).toBe(true);
      await Promise.all([exact(), exact()]);
      expect(field).toHaveBeenCalledTimes(2);
      expect(full).not.toHaveBeenCalled();

      const denied = await app.inject({
        url: url.replace(resultId, randomUUID()),
      });
      expect(denied.statusCode).toBe(404);
      expect(field).toHaveBeenCalledTimes(2);
      expect(full).not.toHaveBeenCalled();

      field.mockImplementationOnce(async (id) => ({
        ...(await restore(id)),
        resultAttemptId: randomUUID(),
      }));
      await exact(); // Only the independent, complete original may satisfy this read.
      expect(full).toHaveBeenCalledTimes(1);
      field.mockImplementationOnce(async (id) => ({
        ...(await restore(id)),
        payloadText: "null",
      }));
      full.mockRejectedValueOnce(
        new Error("Exact attempt original unavailable"),
      );
      expect((await get()).statusCode).toBeGreaterThanOrEqual(500);
      expect(await readStoredAttemptEvidenceText(db, attemptId)).toBe(original);
      expect(full).toHaveBeenCalledTimes(3);
    });
  } finally {
    field.mockRestore();
    full.mockRestore();
  }
}

/** The independent force table supplies the displayed samples when no
 * displayed attempt subtree was removed. Neither archive should open. */
export async function verifyCompactDetail(
  db: DB,
  baseline: Awaited<ReturnType<typeof selectedDetailBaseline>>,
) {
  const [row] =
    await db.execute(sql`SELECT projection->'removedPaths' AS paths FROM attempt_evidence_history_projections p
    JOIN result_attempts a ON a.id=p.result_attempt_id AND a.evidence_archive_id=p.archive_id WHERE a.id=${baseline.attemptId}::uuid`);
  const paths = row?.paths as string[][];
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((p) => p[0] === "force_history")).toBe(true);
  const full = vi.spyOn(apiAttemptEvidenceReader, "read");
  const history = vi.spyOn(ResultHistoryGcsStore.prototype, "read");
  try {
    const after = await selectedDetailBaseline(db, baseline.attemptId);
    expect(after.body).toEqual(baseline.body);
    expect(full).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  } finally {
    history.mockRestore();
    full.mockRestore();
  }
}
