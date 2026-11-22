import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import { expect, vi } from "vitest";
import type { ResultHistoryArchiveStore } from "@aerodb/core/result-history-storage";
import {
  readPublicAttemptFields,
  inlinePublicAttemptFieldsSql,
  type PublicAttemptFieldOwner,
} from "@aerodb/db/public-attempt-fields";
import { enableVerifiedAttemptPolicy } from "@aerodb/db/attempt-evidence-verified-policy";
import { restoreAttemptEvidence } from "@aerodb/db/attempt-evidence-projection";
import { env } from "../../api/src/env";
import { periodicPoint } from "../../../packages/db/test-support/periodic-urans-point";
import { archiveResultHistory } from "../src/result-history-archive";
import { archiveAttemptEvidence } from "../src/attempt-evidence-service";
import { settleAttemptEvidenceHistory } from "../src/attempt-evidence-settlement";
import {
  createVerifiedPolicyFixture,
  bindScientificReceipt,
  verifiedAttemptTestDependencies,
} from "./verified-attempt-policy";
import {
  seedInlineSettledHistory,
  SettlementGcs,
} from "./attempt-settlement-fixture";
import { AttemptEvidenceStore } from "../src/attempt-evidence-store";

export async function verifyPublicAttemptFieldSources(
  historyStore: ResultHistoryArchiveStore,
) {
  const fixture = await createVerifiedPolicyFixture();
  const { db } = fixture;
  const priorBucket = env.evidenceBucket;
  try {
    env.evidenceBucket = "fixture";
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
    vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "fixture");
    // Install the actual history guards in the same isolated storage schema.
    await db.execute(
      sql`ALTER TABLE results DROP COLUMN steady_history_archive_id, DROP COLUMN frame_track_archive_id`,
    );
    const ddl = await readFile(
      new URL(
        "../../../packages/db/migrations/0206_result_history_storage.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of ddl
      .split("--> statement-breakpoint")
      .filter((s) => s.trim()))
      await db.execute(sql.raw(statement));
    await db.execute(
      sql`INSERT INTO sync_api_settings(id,remote_solver_enabled) VALUES(1,false)`,
    );
    const memory = new SettlementGcs();
    const store = new AttemptEvidenceStore(
      memory as unknown as ConstructorParameters<
        typeof AttemptEvidenceStore
      >[0],
    );
    const periodic = periodicPoint(0, 5, true);
    const point = {
      ...periodic,
      frame_track: null,
      frameTrack: periodic.frame_track,
      fidelity: "urans_full" as const,
    };
    const source = await seedInlineSettledHistory(db, { uransPoint: point });
    const { attemptId, resultId, jobId } = source;
    // Both spellings and a real JSON null must survive independently, including PG decimal scale.
    await db.execute(sql`UPDATE result_attempts SET evidence_payload=jsonb_set(evidence_payload,'{frameTrack,frames,0,cl}','0.810000'::jsonb)
      WHERE id=${attemptId}::uuid`);
    const [before] = await db.execute(
      sql`SELECT evidence_payload::text AS text FROM result_attempts WHERE id=${attemptId}::uuid`,
    );
    const full = JSON.parse(String(before.text));
    const projectedInline = (id: string) =>
      db.execute(sql`SELECT
      ${inlinePublicAttemptFieldsSql(sql`a.evidence_payload`, sql`a.evidence_archive_id`)} AS fields
      FROM result_attempts a WHERE a.id=${id}::uuid`);
    expect((await projectedInline(attemptId))[0].fields).toEqual({
      frame_track: null,
      frameTrack: full.frameTrack,
      fidelity: full.fidelity,
    });
    const { archive } = await archiveAttemptEvidence(db, store, {
      attemptId,
      bucket: "fixture",
      sourceInstance: "hub",
    });
    await bindScientificReceipt(db, source);
    await db.execute(
      sql`UPDATE results SET frame_track=(${before.text}::jsonb)->'frameTrack' WHERE id=${resultId}::uuid`,
    );
    await enableVerifiedAttemptPolicy(db);
    await settleAttemptEvidenceHistory(
      db,
      verifiedAttemptTestDependencies(db, {
        ...source,
        archive,
        store,
        memory,
      }),
      { attemptId, archiveId: archive.id },
    );
    const [event] = await db.execute(
      sql`SELECT evidence_storage_event_id AS id FROM result_attempts WHERE id=${attemptId}::uuid`,
    );
    const owner: PublicAttemptFieldOwner = {
      id: attemptId,
      resultId,
      simJobId: jobId,
      evidenceArchiveId: archive.id,
      evidenceStorageEventId: String(event.id),
    };
    const read = vi.fn(historyStore.read.bind(historyStore));
    const lookup = (owners = [owner]) =>
      readPublicAttemptFields(db, owners, { read });
    expect((await projectedInline(attemptId))[0].fields).toBeNull();
    const expected = {
      frame_track: null,
      frameTrack: full.frameTrack,
      fidelity: full.fidelity,
    };
    expect(
      (
        await readPublicAttemptFields(db, [owner], { read }, [
          "fidelity",
          "steady_history",
          "frame_track",
        ])
      ).get(attemptId),
    ).toEqual({ fidelity: full.fidelity, frame_track: null });
    expect((await lookup()).get(attemptId)).toEqual(expected);
    expect(read).not.toHaveBeenCalled();
    // Equal parsed numbers are insufficient for the inline substitute.
    await db.execute(
      sql`UPDATE results SET frame_track=jsonb_set(frame_track,'{frames,0,cl}','0.81'::jsonb) WHERE id=${resultId}::uuid`,
    );
    expect((await lookup()).has(attemptId)).toBe(false);
    await db.execute(
      sql`UPDATE results SET frame_track=(${before.text}::jsonb)->'frameTrack' WHERE id=${resultId}::uuid`,
    );
    const saved = await archiveResultHistory(db, historyStore, {
      resultId,
      sourceKind: "frame_track",
      bucket: "fixture",
      sourceInstance: "hub",
    });
    expect(saved.offloaded).toBe(true);
    expect((await lookup([owner, owner])).get(attemptId)).toEqual(expected);
    expect(read).toHaveBeenCalledTimes(1);
    // The repeat owns the same result. Its inline field and its catalog row must never supply the earlier attempt.
    const newer = randomUUID();
    await db.execute(sql`INSERT INTO result_attempts(id,result_id,sim_job_id,evidence_payload)
      VALUES(${newer}::uuid,${resultId}::uuid,${jobId}::uuid,${before.text}::jsonb)`);
    await db.execute(sql`UPDATE results SET current_result_attempt_id=${newer}::uuid,frame_track=(${before.text}::jsonb)->'frameTrack'
      WHERE id=${resultId}::uuid`);
    const repeat = await archiveResultHistory(db, historyStore, {
      resultId,
      sourceKind: "frame_track",
      bucket: "fixture",
      sourceInstance: "hub",
    });
    expect(repeat.archive!.id).not.toBe(saved.archive!.id);
    expect((await lookup()).get(attemptId)).toEqual(expected);
    expect(read.mock.lastCall![0].resultAttemptId).toBe(attemptId);
    read.mockImplementationOnce(async (identity) => ({
      ...(await historyStore.read(identity)),
      resultAttemptId: newer,
    }));
    expect((await lookup()).has(attemptId)).toBe(false);
    read.mockImplementationOnce(async (identity) => {
      const original = await historyStore.read(identity);
      return {
        ...original,
        payloadText: original.payloadText.replace("0.810000", "0.81"),
      };
    });
    expect((await lookup()).has(attemptId)).toBe(false);
    expect((await lookup([{ ...owner, resultId: randomUUID() }])).size).toBe(0);
    expect(
      (await lookup([{ ...owner, evidenceStorageEventId: randomUUID() }])).size,
    ).toBe(0);
    const steady = await seedInlineSettledHistory(db);
    const [originalSteady] = await projectedInline(steady.attemptId);
    expect(Object.keys(originalSteady.fields as object).sort()).toEqual([
      "fidelity",
      "steady_history",
    ]);
    await bindScientificReceipt(db, steady);
    await db.execute(sql`UPDATE results r SET steady_history=a.evidence_payload->'steady_history' FROM result_attempts a
      WHERE a.id=${steady.attemptId}::uuid AND r.id=a.result_id`);
    const steadyCopy = (
      await archiveAttemptEvidence(db, store, {
        attemptId: steady.attemptId,
        bucket: "fixture",
        sourceInstance: "hub",
      })
    ).archive;
    await settleAttemptEvidenceHistory(
      db,
      verifiedAttemptTestDependencies(db, {
        ...steady,
        archive: steadyCopy,
        store,
        memory,
      }),
      { attemptId: steady.attemptId, archiveId: steadyCopy.id },
    );
    const [steadyEvent] = await db.execute(
      sql`SELECT evidence_storage_event_id AS id FROM result_attempts WHERE id=${steady.attemptId}::uuid`,
    );
    const steadyOwner = {
      id: steady.attemptId,
      resultId: steady.resultId,
      simJobId: steady.jobId,
      evidenceArchiveId: steadyCopy.id,
      evidenceStorageEventId: String(steadyEvent.id),
    };
    // Even identical inline bytes at a different selected generation have no authority for this attempt.
    await db.execute(
      sql`UPDATE results SET current_result_attempt_id=NULL WHERE id=${steady.resultId}::uuid`,
    );
    const mixed = await readPublicAttemptFields(db, [owner, steadyOwner], {
      read,
    });
    expect(mixed.get(attemptId)).toEqual(expected);
    expect(mixed.has(steady.attemptId)).toBe(false);
    await db.execute(
      sql`UPDATE results SET current_result_attempt_id=${steady.attemptId}::uuid WHERE id=${steady.resultId}::uuid`,
    );
    expect(
      (
        await archiveResultHistory(db, historyStore, {
          resultId: steady.resultId,
          sourceKind: "steady_history",
          bucket: "fixture",
          sourceInstance: "hub",
        })
      ).offloaded,
    ).toBe(true);
    expect(
      (await readPublicAttemptFields(db, [steadyOwner], { read })).get(
        steady.attemptId,
      ),
    ).toEqual(originalSteady.fields);
    expect(read.mock.lastCall![0].sourceKind).toBe("steady_history");

    const rollback = new Error("rollback field proof control");
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`DELETE FROM progressive_cfd_evidence WHERE result_attempt_id=${attemptId}::uuid`,
        );
        expect(
          (
            await readPublicAttemptFields(
              tx as unknown as DB,
              [owner],
              { read },
              ["fidelity"],
            )
          ).size,
        ).toBe(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS SELECT * FROM ${sql.identifier(fixture.namespace)}.result_attempts WHERE id=${attemptId}::uuid`,
      );
      await tx.execute(
        sql`SET LOCAL search_path=pg_temp,${sql.identifier(fixture.namespace)},public`,
      );
      await tx.execute(
        sql`UPDATE pg_temp.result_attempts SET evidence_payload=evidence_payload||'{"fidelity":"stale"}'::jsonb`,
      );
      expect(
        (
          await readPublicAttemptFields(
            tx as unknown as DB,
            [owner],
            { read },
            ["fidelity"],
          )
        ).size,
      ).toBe(0);
    });
    let restoredDuringRead = false;
    read.mockImplementationOnce(async (identity) => {
      const envelope = await historyStore.read(identity);
      await restoreAttemptEvidence(
        db,
        attemptId,
        archive.id,
        String(before.text),
        "public field regression restore",
      );
      restoredDuringRead = true;
      return envelope;
    });
    expect((await lookup()).has(attemptId)).toBe(false);
    expect(restoredDuringRead).toBe(true);
    expect((await lookup()).has(attemptId)).toBe(false);
  } finally {
    env.evidenceBucket = priorBucket;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture.close();
  }
}
