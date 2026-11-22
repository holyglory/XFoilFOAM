import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import { buildPolarFit, classifyPolarEvidence } from "@aerodb/core";
import type { DB } from "../src/client";
import type { ProgressiveCfdLease } from "../src/progressive-cfd";
import {
  assertProgressiveRemoteEvidenceAttempt,
  readProgressiveRemoteEvidenceReceipt,
  recordProgressiveRemoteEvidenceReceipt,
  type ProgressiveRemoteEvidenceDelivery,
} from "../src/progressive-remote-evidence-receipts";
import { claimProgressivePolarFit } from "../src/progressive-polar-cache";
import { readPolarAttemptEvidenceForConsumerProof } from "../src/polar-cache";
import { readAttemptEvidenceText } from "../src/attempt-evidence-reader";
import {
  attemptEvidenceShorteningCandidates,
  setAttemptEvidenceStoragePolicy,
} from "../src/attempt-evidence-projection";
import { analysisContentHash } from "../src/analysis-target";
import { buildProgressiveFitRequest } from "../../../apps/sweeper/src/progressive-fitting";
import type { ProgressivePolarFitResponse } from "../../engine-client/src/progressive-polar";
import { AttemptEvidenceStore } from "../../../apps/sweeper/src/attempt-evidence-store";
import { SettlementGcs } from "../../../apps/sweeper/test-support/attempt-settlement-fixture";
import { archiveAttemptEvidence } from "../../../apps/sweeper/src/attempt-evidence-service";
import { prepareAttemptPublicationEvidence } from "../../../apps/sweeper/src/attempt-evidence-consumer-reader";
import {
  configuredAttemptEvidenceSettlementDependencies,
  settleAttemptEvidenceHistory,
} from "../../../apps/sweeper/src/attempt-evidence-settlement";
import { apiAttemptEvidenceReader } from "../../../apps/api/src/attempt-evidence-reader";
import { env } from "../../../apps/api/src/env";
import { reportTextIdentity } from "../src/progressive-report-archive";
import { assertAttemptSourcePins, attemptSourceApplicationSha256, loadAttemptSourcePins, prepareAttemptSources } from "../src/attempt-receipt-source";

export function stoppedHistoryFixture() {
  const iterations = Array.from({ length: 1500 }, (_, index) => index + 1);
  const values = (base: number, seed: number) =>
    iterations.map((i) =>
      Number((base + Math.sin(i * seed) / 2000).toFixed(10)),
    );
  return {
    iterations,
    cl: values(0.4, 13),
    cd: values(0.03, 19),
    cm: values(-0.02, 23),
    window: { start_iter: 1000, end_iter: 1500 },
    mean_stable: false,
    note: "settled CFD fixture",
  };
}

export async function verifyStoppedAttemptHistory(
  db: DB,
  delivery: ProgressiveRemoteEvidenceDelivery & { resultAttemptId: string },
  lease: ProgressiveCfdLease,
  calculateFit: (
    request: ReturnType<typeof buildProgressiveFitRequest>,
  ) => Promise<ProgressivePolarFitResponse>,
) {
  const attemptId = delivery.resultAttemptId,
    executionId = delivery.engineJobId;
  const inputs =
    await db.execute(sql`SELECT a.airfoil_id,a.simulation_preset_revision_id,a.evidence_payload::text AS original,p.id AS prediction
    FROM result_attempts a JOIN neuralfoil_predictions p ON p.target_id=${lease.targetId} AND p.epoch_id=${lease.epochId}
    WHERE a.id=${attemptId}::uuid`);
  const original = String(inputs[0].original);
  const memory = new SettlementGcs();
  const store = new AttemptEvidenceStore(
    memory as unknown as ConstructorParameters<typeof AttemptEvidenceStore>[0],
  );
  const { archive } = await archiveAttemptEvidence(db, store, {
    attemptId,
    bucket: "fixture",
    sourceInstance: "hub",
  });
  const limit = async () =>
    (
      await db.execute(
        sql`SELECT attempt_evidence_shortening_limiter(${attemptId}::uuid,${archive.id}::uuid) AS why`,
      )
    )[0].why;
  await setAttemptEvidenceStoragePolicy(db, {
    enabled: true,
    consumerContractVersion: 1,
    stoppedProgressive: true,
  });
  expect(await limit()).toBe("outside-stopped-progressive-cohort");
  await db.execute(sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,started_at,lease_until,outcome,finished_at)
    VALUES (${randomUUID()}::uuid,${lease.id}::uuid,'later-unit-attempt',clock_timestamp(),clock_timestamp(),'failed',clock_timestamp())`);
  expect(await limit()).toBeNull();
  expect(await attemptEvidenceShorteningCandidates(db)).toContainEqual({
    id: attemptId,
    archive_id: archive.id,
    limiter: null,
  });
  await setAttemptEvidenceStoragePolicy(db, {
    enabled: true,
    consumerContractVersion: 1,
  });
  expect(await limit()).not.toBeNull();
  expect(
    await attemptEvidenceShorteningCandidates(db, null, true),
  ).toContainEqual({ id: attemptId, archive_id: archive.id, limiter: null });
  await setAttemptEvidenceStoragePolicy(db, {
    enabled: true,
    consumerContractVersion: 1,
    stoppedProgressive: true,
    canaryAttemptId: attemptId,
  });
  async function scientificSnapshot() {
    const points = await readPolarAttemptEvidenceForConsumerProof(
      db,
      String(inputs[0].airfoil_id),
      String(inputs[0].simulation_preset_revision_id),
      executionId,
    );
    const job = classifyPolarEvidence(points);
    const cell =
      await db.execute(sql`SELECT r.id,r.current_result_attempt_id,r.cl,r.cd,r.cm,a.valid_for_polar,c.state
      FROM result_attempts a JOIN results r ON r.id=a.result_id LEFT JOIN result_classifications c ON c.result_attempt_id=a.id
      WHERE a.id=${attemptId}::uuid`);
    const rollback = new Error("release read-only fit observation");
    let fitRequest!: ReturnType<typeof buildProgressiveFitRequest>;
    let sourceSignature!: string;
    await expect(
      db.transaction(async (tx) => {
        const claimed = await claimProgressivePolarFit(tx as unknown as DB, {
          owner: "stopped-custody-fit",
          leaseSeconds: 60,
          predictionId: String(inputs[0].prediction),
        });
        expect(claimed).not.toBeNull();
        expect(
          claimed!.source.evidence.map((e) => e.resultAttemptId),
        ).not.toContain(attemptId);
        fitRequest = buildProgressiveFitRequest(claimed!);
        expect(fitRequest.lease_token).toBe(claimed!.token);
        sourceSignature = claimed!.source.signature;
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const { lease_token, ...request } = fitRequest;
    const { lease_token: echoed, ...response } = await calculateFit(fitRequest);
    expect(echoed).toBe(lease_token);
    return {
      cell: [...cell],
      fit: { sourceSignature, request, response },
      ordinary: buildPolarFit(job.classifications),
      classes: job.classifications.map((c) => [
        c.state,
        c.reasons,
        c.confidence,
      ]),
      receipt: await readProgressiveRemoteEvidenceReceipt(db, delivery),
    };
  }
  const before = await scientificSnapshot();
  const bucket = env.evidenceBucket;
  const realRead = store.read.bind(store);
  const read = vi
    .spyOn(AttemptEvidenceStore.prototype, "read")
    .mockImplementation(realRead);
  env.evidenceBucket = "fixture";
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "fixture");
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
  try {
    const verified = await assertProgressiveRemoteEvidenceAttempt(db, delivery);
    expect(analysisContentHash(verified.payload)).toBe(
      analysisContentHash(JSON.parse(original)),
    );
    const deps = {
      ...(await configuredAttemptEvidenceSettlementDependencies(db)),
      store,
    };
    const wrongScope = {
      ...deps,
      verifyDependencies: async (
        input: Parameters<typeof deps.verifyDependencies>[0],
      ) => {
        const proof = await deps.verifyDependencies(input);
        return {
          ...proof,
          progressiveScope: {
            ...proof.progressiveScope,
            pointContentSignature: "0".repeat(64),
          },
        };
      },
    };
    await expect(
      settleAttemptEvidenceHistory(db, wrongScope, {
        attemptId,
        archiveId: archive.id,
      }),
    ).rejects.toThrow(/fresh pinned GCS and usable app proofs/);
    expect(
      await readAttemptEvidenceText(db, apiAttemptEvidenceReader, attemptId),
    ).toBe(original);
    const result = await settleAttemptEvidenceHistory(db, deps, {
      attemptId,
      archiveId: archive.id,
    });
    expect(result.netValueBytesReclaimed).toBeGreaterThan(1024);
    const [row] =
      await db.execute(sql`SELECT a.evidence_payload,a.evidence_archive_id,e.verification,e.app_readback_at
      FROM result_attempts a JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id WHERE a.id=${attemptId}::uuid`);
    expect(row.evidence_archive_id).toBe(archive.id);
    const stoppedPin = (await loadAttemptSourcePins(db, [attemptId])).get(attemptId)!;
    expect(attemptSourceApplicationSha256(stoppedPin)).toBe(analysisContentHash(JSON.parse(original)));
    await db.transaction(tx => assertAttemptSourcePins(tx as unknown as DB, [stoppedPin]));
    expect(row.evidence_payload).not.toHaveProperty("steady_history.cl");
    expect(row.evidence_payload).toHaveProperty("mesh_recovery_version", 3);
    expect(row.app_readback_at).not.toBeNull();
    expect(row.verification).toMatchObject({
      dependencies: {
        applicationSha256: analysisContentHash(verified.payload),
        sourceSha256: reportTextIdentity(original).sha256,
        progressiveScope: {
          pointContentSignature:
            delivery.progressiveEvidence.pointContentSignature,
        },
      },
    });
    expect(
      await readAttemptEvidenceText(db, apiAttemptEvidenceReader, attemptId),
    ).toBe(original);
    expect(await scientificSnapshot()).toEqual(before);
    expect(await assertProgressiveRemoteEvidenceAttempt(db, delivery)).toEqual({
      ...verified,
      archiveId: archive.id,
    });
    expect(
      await recordProgressiveRemoteEvidenceReceipt(db, {
        ...delivery,
        storageOnly: true,
      }),
    ).toEqual(before.receipt);
    await expect(
      recordProgressiveRemoteEvidenceReceipt(db, {
        ...delivery,
        remoteResultAttemptId: randomUUID(),
        storageOnly: true,
      }),
    ).rejects.toThrow(/immutable remote evidence identity/);
    await expect(
      assertProgressiveRemoteEvidenceAttempt(db, {
        ...delivery,
        progressiveEvidence: {
          ...delivery.progressiveEvidence,
          pointContentSignature: "0".repeat(64),
        },
      }),
    ).rejects.toThrow(/reported point/);
    await expect(
      db.execute(sql`INSERT INTO progressive_cfd_evidence(attempt_token,result_attempt_id,evidence_signature,solver_active_seconds)
      VALUES (${lease.token}::uuid,${attemptId}::uuid,${analysisContentHash(row.evidence_payload)},1)`),
    ).rejects.toThrow(/Restore the exact archived attempt/);
    memory.lateError = true;
    await expect(
      readAttemptEvidenceText(db, apiAttemptEvidenceReader, attemptId),
    ).rejects.toThrow(/unavailable|verification/);
    memory.lateError = false;
    // Exercise the same transaction-bound reconstruction used before a future
    // numerical registration. PostgreSQL authenticates the whole original.
    const changed = JSON.parse(original);
    changed.steady_history.cl[17] += 0.001;
    await expect(
      db.execute(sql`SELECT attempt_evidence_restore(${attemptId}::uuid,${archive.id}::uuid,
      (${JSON.stringify(changed)}::jsonb)::text,'invalid replay')`),
    ).rejects.toThrow(/exact retained PostgreSQL original/);
    const publication = await prepareAttemptPublicationEvidence(db, [
      attemptId,
    ]);
    expect(publication.get(attemptId)?.evidencePayload).toEqual(
      verified.payload,
    );
    expect(await limit()).toBe("returned-to-publication");
    await expect(db.transaction(tx => assertAttemptSourcePins(tx as unknown as DB, [stoppedPin]))).rejects.toThrow(/binding changed/);
    const restoredPin = (await loadAttemptSourcePins(db, [attemptId])).get(attemptId)!;
    expect(restoredPin.archiveId).toBeNull();
    expect(restoredPin.storageEventId).not.toBe(stoppedPin.storageEventId);
    const rebound = (await prepareAttemptSources(db, store, [restoredPin])).get(attemptId)!;
    expect(rebound.payloadText).toBe(original);
    await db.transaction(tx => assertAttemptSourcePins(tx as unknown as DB, [rebound.pin]));
    expect(
      await readAttemptEvidenceText(db, apiAttemptEvidenceReader, attemptId),
    ).toBe(original);
    expect(await scientificSnapshot()).toEqual(before);
    console.info(
      JSON.stringify({
        stoppedAttemptHistory: {
          sourceBytes: archive.sourceByteSize,
          ...result,
        },
      }),
    );
    const { verifyRemoteReceiptOnlyHistory } = await import("./attempt-receipt-source-fixture");
    await verifyRemoteReceiptOnlyHistory(db, attemptId, archive.id, original, store);
  } finally {
    read.mockRestore();
    env.evidenceBucket = bucket;
    vi.unstubAllEnvs();
  }
}
