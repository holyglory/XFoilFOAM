import { runAttemptEvidenceArchivePass } from "../src/attempt-evidence-service";
import { periodicPoint } from "../../../packages/db/test-support/periodic-urans-point";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import { analysisContentHash } from "@aerodb/db/analysis-target";
import type { DB } from "@aerodb/db/client";
import { databaseUrl } from "@aerodb/db/env";
import { createAttemptServerDependencyVerifier } from "@aerodb/db/attempt-evidence-dependency-verifier";
import {
  getAttemptEvidenceStoragePolicy,
  setAttemptEvidenceStoragePolicy,
  restoreAttemptEvidence,
} from "@aerodb/db/attempt-evidence-projection";
import { enableVerifiedAttemptPolicy } from "@aerodb/db/attempt-evidence-verified-policy";
import {
  apiAttemptEvidenceReader,
  readApiAttemptEvidenceForApp,
} from "../../api/src/attempt-evidence-reader";
import { env } from "../../api/src/env";
import {
  runAttemptEvidenceSettlementPass,
  settleAttemptEvidenceHistory,
} from "../src/attempt-evidence-settlement";
import { attemptEvidenceStorageMain } from "../src/attempt-evidence-storage-cli";
import {
  createSettlementFixture,
  interruptBeforeReadback,
  seedSettledHistory,
  seedInlineSettledHistory,
  SettlementGcs,
} from "./attempt-settlement-fixture";

export async function createVerifiedPolicyFixture() {
  const fixture = await createSettlementFixture();
  try {
    // The migrations create an index on worker acknowledgements. Keep that table
    // and the singleton deployment identity in this test's isolated namespace.
    for (const table of [
      "progressive_worker_hub_receipts",
      "sync_api_settings",
    ])
      await fixture.db.execute(
        sql`CREATE TABLE ${sql.identifier(table)} AS TABLE public.${sql.identifier(table)} WITH NO DATA`,
      );
    for (const file of [
      "0210_stopped_progressive_attempt_history.sql",
      "0211_progressive_attempt_receipt_sources.sql",
      "0212_hz_attempt_history_custody.sql",
      "0213_urans_attempt_history.sql",
      "0214_verified_attempt_history_policy.sql",
      "0215_verified_attempt_active_role.sql",
    ]) {
      const body = await readFile(
        new URL(`../../../packages/db/migrations/${file}`, import.meta.url),
        "utf8",
      );
      for (const statement of body
        .split("--> statement-breakpoint")
        .filter((part) => part.trim()))
        await fixture.db.execute(sql.raw(statement));
    }
    return fixture;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

async function bindScientificReceipt(
  db: DB,
  source: Awaited<ReturnType<typeof seedInlineSettledHistory>>,
) {
  const { attemptId, resultId, jobId } = source;
  const token = randomUUID(),
    unitId = randomUUID();
  const [attempt] = await db.execute(
    sql`SELECT evidence_payload,engine_job_id FROM result_attempts WHERE id=${attemptId}`,
  );
  await db.execute(
    sql`UPDATE sim_jobs SET engine_job_id=${attempt.engine_job_id} WHERE id=${jobId}`,
  );
  await db.execute(
    sql`UPDATE results SET aoa_deg=0,current_result_attempt_id=${attemptId} WHERE id=${resultId}`,
  );
  await db.execute(
    sql`INSERT INTO progressive_cfd_units(id,aoa_deg) VALUES(${unitId},0)`,
  );
  await db.execute(
    sql`INSERT INTO progressive_cfd_attempts(token,sim_job_id,unit_id,outcome) VALUES(${token},${jobId},${unitId},'complete')`,
  );
  await db.execute(sql`INSERT INTO progressive_cfd_evidence(attempt_token,result_attempt_id,evidence_signature)
    VALUES (${token},${attemptId},${analysisContentHash(attempt.evidence_payload)})`);
}

function dependencies(
  db: DB,
  source: Awaited<ReturnType<typeof seedSettledHistory>>,
) {
  vi.spyOn(apiAttemptEvidenceReader, "read").mockImplementation(
    source.store.read.bind(source.store),
  );
  return {
    store: source.store,
    readApp: (request: Parameters<typeof readApiAttemptEvidenceForApp>[1]) =>
      readApiAttemptEvidenceForApp(db, request),
    verifyDependencies: createAttemptServerDependencyVerifier(db, source.store),
  };
}

function stored(db: DB) {
  return db.execute(sql`SELECT a.id,e.id AS event_id,e.archive_id,e.verification#>>'{dependencies,verifier}' AS verifier,
    e.app_readback_at IS NOT NULL AS acknowledged FROM result_attempts a JOIN attempt_evidence_storage_events e
    ON e.id=a.evidence_storage_event_id AND e.archive_id=a.evidence_archive_id AND e.result_attempt_id=a.id
    WHERE e.completed AND e.action='shorten' ORDER BY a.id`);
}

export async function verifyMixedAttemptPolicy(db: DB, namespace: string) {
  const memory = new SettlementGcs();
  const local = await seedSettledHistory(db, { memory });
  const scientific = await seedSettledHistory(db, { memory });
  await bindScientificReceipt(db, scientific);
  const transient = await seedSettledHistory(db, {
    memory,
    uransPoint: { ...periodicPoint(0, 5, true), fidelity: "urans_full" },
  });
  await bindScientificReceipt(db, transient);
  const noReceipt = await seedSettledHistory(db, {
    memory,
    uransPoint: { ...periodicPoint(0, 3, false), fidelity: "urans_precalc" },
  });
  const deps = dependencies(db, local);
  const originalBucket = env.evidenceBucket;
  try {
    env.evidenceBucket = "fixture";
    expect((await getAttemptEvidenceStoragePolicy(db))?.shorteningEnabled).toBe(
      false,
    );
    const url = new URL(databaseUrl());
    url.searchParams.set("options", `-c search_path=${namespace},public`);
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
    vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "fixture");
    const invoke = async (...args: string[]) => {
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      try {
        await attemptEvidenceStorageMain(args);
        return JSON.parse(String(stdout.mock.lastCall?.[0]));
      } finally {
        stdout.mockRestore();
      }
    };
    const preview = await invoke("preview-verified");
    expect(preview.eligible).toHaveLength(3);
    expect(preview.limited).toMatchObject({
      "missing-exact-settled-progressive-receipt": 1,
    });
    expect(
      (await invoke("shortening-candidates", "--receipt-urans", "true"))
        .eligible,
    ).toEqual([
      { attemptId: transient.attemptId, archiveId: transient.archive.id },
    ]);
    expect(preview.eligible).toEqual(
      expect.arrayContaining([
        {
          attemptId: local.attemptId,
          archiveId: local.archive.id,
          cohort: "legacy",
        },
        {
          attemptId: scientific.attemptId,
          archiveId: scientific.archive.id,
          cohort: "receipt-bearing",
        },
        {
          attemptId: transient.attemptId,
          archiveId: transient.archive.id,
          cohort: "receipt-urans",
        },
      ]),
    );
    await expect(
      invoke(
        "enable-verified",
        "--consumer-contract",
        "1",
        "--id",
        scientific.attemptId,
      ),
    ).rejects.toThrow("canary");
    expect((await getAttemptEvidenceStoragePolicy(db))?.shorteningEnabled).toBe(
      false,
    );
    // A scoped canary keeps its old selection and processing behavior.
    await setAttemptEvidenceStoragePolicy(db, {
      enabled: true,
      consumerContractVersion: 1,
      canaryAttemptId: scientific.attemptId,
      receiptBearing: true,
    });
    expect((await runAttemptEvidenceSettlementPass(db, deps)).processed).toBe(
      0,
    );
    await invoke(
      "enable-shortening",
      "--consumer-contract",
      "1",
      "--receipt-urans",
      "true",
      "--id",
      transient.attemptId,
      "--urans-max-source-bytes",
      "4096",
    );
    expect(
      (await invoke("preview-verified")).eligible.map(
        (entry: { attemptId: string }) => entry.attemptId,
      ),
    ).not.toContain(transient.attemptId);
    await invoke(
      "enable-shortening",
      "--consumer-contract",
      "1",
      "--receipt-urans",
      "true",
      "--id",
      transient.attemptId,
      "--urans-max-source-bytes",
      "524288",
    );
    expect(
      (await invoke("enable-verified", "--consumer-contract", "1"))
        .progressiveSourceScope,
    ).toBe("verified");
    expect(await invoke("shortening-status")).toMatchObject({
      role: "hub",
      automaticWorker: "report-storage-worker",
      cohorts: ["legacy", "stopped-only", "receipt-bearing", "receipt-urans"],
      policy: {
        canaryAttemptId: null,
        maxSourceBytes: 262144,
        uransMaxSourceBytes: 524288,
      },
    });
    expect((await invoke("shortening-candidates")).eligible).toEqual(
      preview.eligible,
    );
    const run = await runAttemptEvidenceSettlementPass(db, deps);
    expect(run).toMatchObject({ processed: 3, shortened: 3, failures: [] });
    const events = await stored(db);
    expect(events).toHaveLength(3);
    expect(events.find((e) => e.id === noReceipt.attemptId)).toBeUndefined();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: local.attemptId,
          archive_id: local.archive.id,
          verifier: "server-consumers/local-steady-rans-v1",
          acknowledged: true,
        }),
        expect.objectContaining({
          id: scientific.attemptId,
          archive_id: scientific.archive.id,
          verifier: "server-consumers/receipt-bearing-rans-v1",
          acknowledged: true,
        }),
        expect.objectContaining({
          id: transient.attemptId,
          archive_id: transient.archive.id,
          verifier: "server-consumers/receipt-bearing-urans-v1",
          acknowledged: true,
        }),
      ]),
    );
    const oldEvent = events.find((e) => e.id === scientific.attemptId)!;
    const original = await scientific.store.read(scientific.archive);
    await restoreAttemptEvidence(
      db,
      scientific.attemptId,
      scientific.archive.id,
      original.payloadText,
      "verified-policy-fixture",
    );
    const [guard] =
      await db.execute(sql`SELECT attempt_evidence_verification_valid(e.result_attempt_id,e.archive_id,e.verification) AS correct,
      attempt_evidence_verification_valid(e.result_attempt_id,e.archive_id,jsonb_set(e.verification,'{dependencies,verifier}',
        to_jsonb('server-consumers/local-steady-rans-v1'::text))) AS wrong_verifier,
      e.completed AND e.app_readback_at IS NOT NULL AS old_receipt,
      a.evidence_payload::text AS restored, e.id <> a.evidence_storage_event_id AS distinct_restore
      FROM attempt_evidence_storage_events e JOIN result_attempts a ON a.id=e.result_attempt_id WHERE e.id=${oldEvent.event_id}::uuid`);
    expect(guard).toMatchObject({
      correct: true,
      wrong_verifier: false,
      old_receipt: true,
      distinct_restore: true,
    });
    expect(guard.restored === original.payloadText).toBe(true);
    await setAttemptEvidenceStoragePolicy(db, {
      enabled: true,
      consumerContractVersion: 1,
    });
    expect(
      (await getAttemptEvidenceStoragePolicy(db))?.progressiveSourceScope,
    ).toBe("legacy");
    expect(await stored(db)).toEqual(
      events.filter((e) => e.id !== scientific.attemptId),
    );
  } finally {
    env.evidenceBucket = originalBucket;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
}

export async function verifyLateAttemptPolicy(db: DB) {
  const memory = new SettlementGcs();
  const missed = await seedSettledHistory(db, {
    id: "90000000-0000-4000-8000-000000000001",
    memory,
  });
  const deps = dependencies(db, missed);
  const originalBucket = env.evidenceBucket;
  try {
    env.evidenceBucket = "fixture";
    await enableVerifiedAttemptPolicy(db);
    memory.lateError = true;
    const failed = await runAttemptEvidenceSettlementPass(db, deps);
    expect(failed.failures.map((f) => f.attemptId)).toEqual([missed.attemptId]);
    expect(await stored(db)).toEqual([]);
    memory.lateError = false;
    const newcomer = await seedInlineSettledHistory(db, {
      id: "10000000-0000-4000-8000-000000000002",
    });
    await bindScientificReceipt(db, newcomer);
    const copy = (after: string | null) =>
      runAttemptEvidenceArchivePass(db, missed.store, {
        after,
        bucket: "fixture",
        sourceInstance: "hub",
      });
    const copyTail = await copy(missed.attemptId);
    expect(copyTail.next).toBeNull();
    expect(await copy(copyTail.next)).toMatchObject({
      copied: 1,
      failures: [],
    });
    const end = await runAttemptEvidenceSettlementPass(db, deps, {
      after: failed.next,
    });
    expect(end.next).toBeNull();
    const retry = await runAttemptEvidenceSettlementPass(db, deps, {
      after: end.next,
    });
    expect(retry).toMatchObject({ shortened: 2, failures: [] });
    const events = await stored(db);
    expect(events.map((e) => e.id)).toEqual([
      newcomer.attemptId,
      missed.attemptId,
    ]);
    expect(events.every((e) => e.acknowledged === true)).toBe(true);
    expect((await runAttemptEvidenceSettlementPass(db, deps)).shortened).toBe(
      0,
    );
    expect(await stored(db)).toEqual(events);
  } finally {
    env.evidenceBucket = originalBucket;
    vi.restoreAllMocks();
  }
}

export async function verifyPendingAttemptPolicy(db: DB) {
  const memory = new SettlementGcs();
  const pending = await seedSettledHistory(db, { memory });
  const deps = dependencies(db, pending);
  const originalBucket = env.evidenceBucket;
  try {
    env.evidenceBucket = "fixture";
    await enableVerifiedAttemptPolicy(db);
    await expect(
      settleAttemptEvidenceHistory(interruptBeforeReadback(db), deps, {
        attemptId: pending.attemptId,
        archiveId: pending.archive.id,
      }),
    ).rejects.toThrow("before confirming");
    const [event] = await stored(db);
    expect(event.acknowledged).toBe(false);
    const newcomer = await seedSettledHistory(db, { memory });
    await bindScientificReceipt(db, newcomer);
    const onDisk = deps.store.read.bind(deps.store);
    const fault = vi
      .spyOn(deps.store, "read")
      .mockImplementation((identity, signal) => {
        if (identity.attemptId === pending.attemptId)
          throw new Error("fixture generation temporarily unavailable");
        return onDisk(identity, signal);
      });
    const busy = await runAttemptEvidenceSettlementPass(db, deps, {
      maxRows: 1,
    });
    expect(busy.failures.map((f) => f.attemptId)).toEqual([pending.attemptId]);
    expect(busy.nextReadback).toBe(event.event_id);
    const other = await runAttemptEvidenceSettlementPass(db, deps, {
      after: busy.next,
      afterReadback: busy.nextReadback,
      maxRows: 1,
    });
    expect(other).toMatchObject({ shortened: 1, failures: [] });
    expect(await stored(db)).toContainEqual(
      expect.objectContaining({ id: newcomer.attemptId, acknowledged: true }),
    );
    fault.mockRestore();
    const recovered = await runAttemptEvidenceSettlementPass(db, deps, {
      after: other.next,
      afterReadback: other.nextReadback,
      maxRows: 1,
    });
    expect(recovered).toMatchObject({ recovered: 1, shortened: 0 });
    expect(await stored(db)).toContainEqual({ ...event, acknowledged: true });
  } finally {
    env.evidenceBucket = originalBucket;
    vi.restoreAllMocks();
  }
}

export async function verifyAttemptPolicyRole(db: DB) {
  // Ordinary hub preview, enable and settlement in this suite use the same retained registration.
  await db.execute(sql`UPDATE sync_api_settings SET remote_solver_enabled=true WHERE id=1`);
  await expect(enableVerifiedAttemptPolicy(db)).rejects.toThrow("HZ custody");
  await db.execute(sql`UPDATE sync_api_settings SET remote_solver_enabled=false WHERE id=1`);
  await db.execute(sql`UPDATE attempt_evidence_storage_policy SET hz_worker_only=true WHERE id=1`);
  await expect(enableVerifiedAttemptPolicy(db)).rejects.toThrow("HZ custody");
  await db.execute(sql`UPDATE attempt_evidence_storage_policy SET hz_worker_only=false WHERE id=1`);
  await db.execute(sql`DELETE FROM sync_api_settings WHERE id=1`);
  await expect(enableVerifiedAttemptPolicy(db)).rejects.toThrow("HZ custody");
  expect((await getAttemptEvidenceStoragePolicy(db))?.shorteningEnabled).toBe(false);
  try {
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
    await expect(
      attemptEvidenceStorageMain([
        "enable-verified",
        "--consumer-contract",
        "1",
      ]),
    ).rejects.toThrow("HZ custody");
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "unsupported-role");
    await expect(
      attemptEvidenceStorageMain(["preview-verified"]),
    ).rejects.toThrow("must be hub or remote-solver");
  } finally {
    vi.unstubAllEnvs();
  }
}
