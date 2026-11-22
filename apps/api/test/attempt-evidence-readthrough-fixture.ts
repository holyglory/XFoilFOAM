import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import {
  prepareAttemptEvidenceCopy,
  type AttemptEvidenceCopySource,
} from "@aerodb/db/attempt-evidence-storage";
import {
  registerAttemptEvidenceArchive,
  type AttemptEvidenceArchiveRecord,
  type AttemptEvidenceArchiveIdentity,
} from "@aerodb/db/attempt-evidence-catalog";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { expect, vi } from "vitest";
import type { MockInstance } from "vitest";
import {
  writeAttemptEvidenceCopy,
  readAttemptEvidenceCopy,
} from "../../sweeper/src/attempt-evidence-archive";
import { AttemptEvidenceStore } from "../../sweeper/src/attempt-evidence-store";
import {
  apiAttemptEvidenceReader,
  readApiAttemptEvidenceForApp,
} from "../src/attempt-evidence-reader";
import { env } from "../src/env";

interface SnapshotInput {
  db: DB;
  setConnection(db: DB | null): void;
  resultId: string;
  attemptIds: string[];
  patch?(attemptId: string): Record<string, unknown>;
}
interface Snapshot {
  tx: DB;
  reader: MockInstance<AttemptEvidenceStore["read"]>;
  archives: Map<string, AttemptEvidenceArchiveRecord>;
  objects: Map<string, string>;
  compact(): Promise<void>;
  resetInline(): Promise<void>;
}

/** Rollback-only READ-side snapshots exercise consumers the initial writer
 * intentionally keeps inline. Never disable canonical protections, enable
 * shortening policy or present this fixture as writer eligibility proof. */
async function withAttemptReadSnapshot(
  input: SnapshotInput,
  verify: (snapshot: Snapshot) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "attempt-api-read-"));
  const priorBucket = env.evidenceBucket,
    priorRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
  env.evidenceBucket = "attempt-api-fixture";
  process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
  const objects = new Map<string, string>();
  const reader = vi
    .spyOn(AttemptEvidenceStore.prototype, "read")
    .mockImplementation((identity, signal) => {
      const path = objects.get(identity.attemptId);
      if (!path) throw new Error("Fixture GCS object missing");
      return readAttemptEvidenceCopy(createReadStream(path), identity, {
        signal,
      });
    });
  const rollback = new Error("Rollback isolated attempt read-through fixture");
  try {
    try {
      await input.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB;
        input.setConnection(tx);
        // Keep every attempt for this isolated fixture airfoil visible to
        // real selectors, while canonical rows and guards stay in public.
        await tx.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS SELECT * FROM public.result_attempts
          WHERE airfoil_id=(SELECT airfoil_id FROM public.results WHERE id=${input.resultId}::uuid)`);
        await tx.execute(
          sql`CREATE TEMP TABLE attempt_evidence_archives (LIKE public.attempt_evidence_archives INCLUDING ALL) ON COMMIT DROP`,
        );
        await tx.execute(
          sql`CREATE TEMP TABLE attempt_evidence_history_projections (LIKE public.attempt_evidence_history_projections INCLUDING ALL) ON COMMIT DROP`,
        );
        await tx.execute(sql`SET LOCAL search_path=pg_temp,public`);
        const archives = new Map<string, AttemptEvidenceArchiveRecord>(),
          full = new Map<string, string>();
        for (const attemptId of input.attemptIds) {
          if (input.patch)
            await tx.execute(sql`UPDATE result_attempts SET evidence_payload=evidence_payload || ${JSON.stringify(input.patch(attemptId))}::jsonb
            WHERE id=${attemptId}::uuid`);
          // This rollback-only fixture deliberately changes temporary read
          // models. The production settled-source loader sets TRANSACTION READ
          // ONLY, which applies to the outer transaction even from a savepoint.
          const [source] =
            (await tx.execute(sql`SELECT id AS "attemptId",result_id AS "resultId",sim_job_id AS "simJobId",
            evidence_payload::text AS "payloadText" FROM result_attempts WHERE id=${attemptId}::uuid`)) as unknown as AttemptEvidenceCopySource[];
          if (!source)
            throw new Error("Exact attempt fixture source is missing");
          full.set(attemptId, source.payloadText);
          const path = join(directory, `${attemptId}.json.gz`);
          const proof = await writeAttemptEvidenceCopy(path, source);
          objects.set(attemptId, path);
          const identity = {
            ...proof,
            sourceInstance: "attempt-api-fixture",
            bucket: env.evidenceBucket!,
            objectKey: `attempt-evidence/v1/attempt-api-fixture/${attemptId}/${proof.sourceSha256}/${proof.storedSha256}.json.gz`,
            generation: "18446744073709551615",
            verifiedAt: new Date(),
          };
          const registered = await registerAttemptEvidenceArchive(
            tx,
            identity,
            prepareAttemptEvidenceCopy(source),
          );
          archives.set(attemptId, registered.archive);
          expect(
            await readApiAttemptEvidenceForApp(tx, {
              attemptId,
              archiveId: registered.archive.id,
              sourceSha256: identity.sourceSha256,
              sourceByteSize: identity.sourceByteSize,
              forceArchive: true,
            }),
          ).toMatchObject({ source: "gcs", payloadText: source.payloadText });
          await tx.execute(sql`INSERT INTO attempt_evidence_history_projections(result_attempt_id,archive_id,projection)
            SELECT id,${registered.archive.id}::uuid,attempt_evidence_make_projection(evidence_payload,id,${registered.archive.id}::uuid)
            FROM result_attempts WHERE id=${attemptId}::uuid`);
        }
        const compact = async () => {
          for (const [attemptId, archive] of archives)
            await tx.execute(sql`UPDATE result_attempts
            SET evidence_payload=attempt_evidence_compact(evidence_payload),evidence_archive_id=${archive.id}::uuid,
              evidence_storage_event_id=${randomUUID()}::uuid WHERE id=${attemptId}::uuid`);
        };
        const resetInline = async () => {
          for (const [attemptId, text] of full)
            await tx.execute(sql`UPDATE result_attempts SET evidence_payload=${text}::jsonb,
            evidence_archive_id=NULL,evidence_storage_event_id=NULL WHERE id=${attemptId}::uuid`);
        };
        await verify({ tx, reader, archives, objects, compact, resetInline });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  } finally {
    input.setConnection(null);
    reader.mockRestore();
    env.evidenceBucket = priorBucket;
    if (priorRole === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = priorRole;
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyAttemptEvidenceApiReadthrough(input: {
  db: DB;
  app: FastifyInstance;
  setConnection(db: DB | null): void;
  resultId: string;
  selectedAttemptId: string;
  originalAttemptId: string;
  slug: string;
  revisionId: string;
}) {
  await withAttemptReadSnapshot(
    {
      ...input,
      attemptIds: [input.selectedAttemptId, input.originalAttemptId],
      patch: (id) => ({
        steady_history: {
          iterations: [10, 20, 30],
          cl:
            id === input.originalAttemptId
              ? [0.4, 0.41, 0.41]
              : [0.62, 0.63, 0.63],
          cd:
            id === input.originalAttemptId
              ? [0.02, 0.021, 0.021]
              : [0.013, 0.014, 0.014],
          cm: [-0.02, -0.02, -0.02],
          window: { start_iter: 10, end_iter: 30 },
          mean_stable: true,
          note: "fixture immutable history",
        },
      }),
    },
    async ({ tx, reader, objects, compact, resetInline }) => {
      const simUrl = `/api/airfoils/${input.slug}/sim?resultId=${input.resultId}`;
      const originalUrl = `/api/admin/point-history/${input.resultId}/sim?resultAttemptId=${input.originalAttemptId}`;
      const detailUrl = `/api/airfoils/${input.slug}?revisionId=${input.revisionId}&view=full`;
      for (const state of ["accepted", "needs_urans"] as const) {
        await resetInline();
        await tx.execute(
          sql`UPDATE result_classifications SET state=${state} WHERE result_attempt_id=${input.selectedAttemptId}::uuid`,
        );
        const before = await input.app.inject({ url: simUrl }),
          originalBefore = await input.app.inject({ url: originalUrl });
        const detailBefore = await input.app.inject({ url: detailUrl });
        expect(before.statusCode, before.body).toBe(200);
        expect(originalBefore.statusCode, originalBefore.body).toBe(200);
        expect(detailBefore.statusCode, detailBefore.body).toBe(200);
        expect(before.json()).toMatchObject({ cl: 0.63, cd: 0.014 });
        expect(originalBefore.json()).toMatchObject({ cl: 0.41, cd: 0.021 });
        expect(
          detailBefore
            .json()
            .polars.some((polar: { points: Array<{ resultId: string }> }) =>
              polar.points.some((p) => p.resultId === input.resultId),
            ),
        ).toBe(true);
        await compact();
        const after = await input.app.inject({ url: simUrl }),
          originalAfter = await input.app.inject({ url: originalUrl });
        const detailAfter = await input.app.inject({ url: detailUrl });
        expect(after.statusCode, after.body).toBe(200);
        expect(originalAfter.statusCode, originalAfter.body).toBe(200);
        expect(detailAfter.statusCode, detailAfter.body).toBe(200);
        for (const key of [
          "cl",
          "cd",
          "cm",
          "ld",
          "history",
          "steadyHistory",
          "frameTrack",
          "fidelity",
        ])
          expect(after.json()[key]).toEqual(before.json()[key]);
        for (const key of ["cl", "cd", "cm", "history", "steadyHistory"])
          expect(originalAfter.json()[key]).toEqual(originalBefore.json()[key]);
        expect(detailAfter.json().polars).toEqual(detailBefore.json().polars);
        expect(
          (
            await input.app.inject({
              url: `${simUrl}&resultAttemptId=${input.originalAttemptId}`,
            })
          ).statusCode,
        ).toBe(404);
        const [point] = await tx.execute(
          sql`SELECT cl,current_result_attempt_id FROM results WHERE id=${input.resultId}::uuid`,
        );
        expect(point.cl).toBe(0.41);
        expect(point.current_result_attempt_id).toBe(input.selectedAttemptId);
      }
      reader.mockRejectedValueOnce(new Error("Fixture stale GCS generation"));
      expect(
        (await input.app.inject({ url: simUrl })).statusCode,
      ).toBeGreaterThanOrEqual(500);
      const storedPath = objects.get(input.selectedAttemptId)!;
      objects.delete(input.selectedAttemptId);
      expect(
        (await input.app.inject({ url: simUrl })).statusCode,
      ).toBeGreaterThanOrEqual(500);
      expect((await input.app.inject({ url: originalUrl })).statusCode).toBe(
        200,
      );
      objects.set(input.selectedAttemptId, storedPath);
      reader.mockImplementationOnce((identity, signal) =>
        readAttemptEvidenceCopy(
          Readable.from([Buffer.from("corrupt gzip")]),
          identity,
          { signal },
        ),
      );
      expect(
        (await input.app.inject({ url: simUrl })).statusCode,
      ).toBeGreaterThanOrEqual(500);
      const [payload] = await tx.execute(
        sql`SELECT evidence_payload::text AS text FROM result_attempts WHERE id=${input.selectedAttemptId}::uuid`,
      );
      await tx.execute(
        sql`UPDATE result_attempts SET evidence_payload=evidence_payload || '{"fixtureCorrupt":true}'::jsonb WHERE id=${input.selectedAttemptId}::uuid`,
      );
      expect(
        (await input.app.inject({ url: simUrl })).statusCode,
      ).toBeGreaterThanOrEqual(500);
      await tx.execute(
        sql`UPDATE result_attempts SET evidence_payload=${String(payload.text)}::jsonb WHERE id=${input.selectedAttemptId}::uuid`,
      );
      expect((await input.app.inject({ url: simUrl })).statusCode).toBe(200);
      expect(reader).toHaveBeenCalled();
    },
  );
}

export async function verifyAttemptEvidenceSyncReplay(input: {
  db: DB;
  setConnection(db: DB | null): void;
  resultId: string;
  attemptId: string;
  replay(): Promise<{ statusCode: number; body: string; json(): unknown }>;
}) {
  await withAttemptReadSnapshot(
    { ...input, attemptIds: [input.attemptId] },
    async ({ tx, reader, compact }) => {
      await compact();
      reader.mockClear();
      const [before] = await tx.execute(
        sql`SELECT to_jsonb(a) AS row FROM result_attempts a WHERE id=${input.attemptId}::uuid`,
      );
      const [resultBefore] =
        await tx.execute(sql`SELECT id,current_result_attempt_id,cl,cd,cm,cl_cd,regime,source,status
        FROM results WHERE id=${input.resultId}::uuid`);
      const replay = await input.replay();
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({
        imported: 0,
        attempts: 0,
        conflictIds: [],
      });
      expect(reader).toHaveBeenCalled();
      const [after] = await tx.execute(
        sql`SELECT to_jsonb(a) AS row FROM result_attempts a WHERE id=${input.attemptId}::uuid`,
      );
      expect(after).toEqual(before);
      const [count] = await tx.execute(
        sql`SELECT count(*)::int AS n FROM result_attempts WHERE result_id=${input.resultId}::uuid`,
      );
      expect(count.n).toBe(1);
      reader.mockRejectedValueOnce(
        new Error("Fixture replay archive unavailable"),
      );
      const unavailable = await input.replay();
      expect(unavailable.statusCode, unavailable.body).toBeGreaterThanOrEqual(
        500,
      );
      const [unchanged] = await tx.execute(
        sql`SELECT to_jsonb(a) AS row FROM result_attempts a WHERE id=${input.attemptId}::uuid`,
      );
      expect(unchanged).toEqual(before);
      expect((await input.replay()).statusCode).toBe(200);
      const [compactBeforeRace] = await tx.execute(
        sql`SELECT evidence_payload::text AS text FROM result_attempts WHERE id=${input.attemptId}::uuid`,
      );
      const restore = reader.getMockImplementation()!;
      reader.mockImplementationOnce(async (identity, signal) => {
        const source = await restore(identity, signal);
        // Simulate a changed source between preparation and the locked reread
        // without weakening the real attempt-immutability triggers.
        await tx.execute(
          sql`UPDATE result_attempts SET evidence_payload=evidence_payload || '{"fixtureRace":true}'::jsonb WHERE id=${input.attemptId}::uuid`,
        );
        return source;
      });
      const raced = await input.replay();
      expect(raced.statusCode, raced.body).toBe(409);
      expect(raced.json()).toMatchObject({
        error: expect.stringContaining("changed during archive preparation"),
      });
      const [newer] = await tx.execute(
        sql`SELECT evidence_payload->'fixtureRace' AS retained FROM result_attempts WHERE id=${input.attemptId}::uuid`,
      );
      expect(newer.retained).toBe(true);
      await tx.execute(
        sql`UPDATE result_attempts SET evidence_payload=${String(compactBeforeRace.text)}::jsonb WHERE id=${input.attemptId}::uuid`,
      );
      expect((await input.replay()).statusCode).toBe(200);
      const [resultAfter] =
        await tx.execute(sql`SELECT id,current_result_attempt_id,cl,cd,cm,cl_cd,regime,source,status
        FROM results WHERE id=${input.resultId}::uuid`);
      expect(resultAfter).toEqual(resultBefore);
    },
  );
}

export async function verifyAttemptEvidenceApiAccess(): Promise<void> {
  const priorBucket = env.evidenceBucket,
    priorRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
  const id = randomUUID();
  const identity: AttemptEvidenceArchiveIdentity = {
    sourceInstance: "api-fixture",
    attemptId: id,
    resultId: randomUUID(),
    simJobId: null,
    sourceSha256: "a".repeat(64),
    sourceByteSize: 100,
    envelopeSha256: "b".repeat(64),
    envelopeByteSize: 200,
    storedSha256: "c".repeat(64),
    storedByteSize: 150,
    crc32c: "AAAAAA==",
    bucket: "canonical-evidence",
    objectKey: `attempt-evidence/v1/api-fixture/${id}/${"a".repeat(64)}/${"c".repeat(64)}.json.gz`,
    generation: "18446744073709551615",
    verifiedAt: new Date(),
  };
  const read = vi
    .spyOn(AttemptEvidenceStore.prototype, "read")
    .mockResolvedValue({
      attemptId: id,
      resultId: identity.resultId,
      simJobId: null,
      payloadText: "{}",
    });
  try {
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
    env.evidenceBucket = null;
    await expect(apiAttemptEvidenceReader.read(identity)).rejects.toThrow(
      /not configured/,
    );
    env.evidenceBucket = "different-bucket";
    await expect(apiAttemptEvidenceReader.read(identity)).rejects.toThrow(
      /not configured/,
    );
    env.evidenceBucket = identity.bucket;
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
    await expect(apiAttemptEvidenceReader.read(identity)).rejects.toThrow(
      /not configured/,
    );
    expect(read).not.toHaveBeenCalled();
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
    const signal = new AbortController().signal;
    expect(
      (await apiAttemptEvidenceReader.read(identity, signal)).attemptId,
    ).toBe(id);
    expect(read).toHaveBeenCalledWith(identity, signal);
  } finally {
    read.mockRestore();
    env.evidenceBucket = priorBucket;
    if (priorRole === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = priorRole;
  }
}
