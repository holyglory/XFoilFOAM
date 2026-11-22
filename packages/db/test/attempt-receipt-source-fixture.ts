import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import { analysisContentHash } from "../src/analysis-target";
import { recordProgressiveCfdEvidence } from "../src/progressive-cfd-evidence";
import type { ProgressiveCfdLease } from "../src/progressive-cfd";
import {
  claimProgressivePolarFit,
  storeProgressivePolarFit,
} from "../src/progressive-polar-cache";
import { buildProgressiveFitRequest } from "../../../apps/sweeper/src/progressive-fitting";
import type { ProgressivePolarFitResponse } from "../../engine-client/src/progressive-polar";
import {
  attemptEvidenceShorteningCandidates,
  getAttemptEvidenceStoragePolicy,
  restoreAttemptEvidence,
  setAttemptEvidenceStoragePolicy,
} from "../src/attempt-evidence-projection";
import {
  assertAttemptSourcePins,
  attemptSourceApplicationSha256,
  loadAttemptSourcePins,
  prepareAttemptSources,
} from "../src/attempt-receipt-source";
import { archiveAttemptEvidence } from "../../../apps/sweeper/src/attempt-evidence-service";
import {
  configuredAttemptEvidenceSettlementDependencies,
  settleAttemptEvidenceHistory,
  runAttemptEvidenceSettlementPass,
} from "../../../apps/sweeper/src/attempt-evidence-settlement";
import { SettlementGcs } from "../../../apps/sweeper/test-support/attempt-settlement-fixture";
import { AttemptEvidenceStore } from "../../../apps/sweeper/src/attempt-evidence-store";
import { env } from "../../../apps/api/src/env";
import { reportTextIdentity } from "../src/progressive-report-archive";
import { resultAttempts } from "../src/schema";
import { stoppedHistoryFixture } from "./progressive-stopped-history-fixture";

type Fit = (
  request: ReturnType<typeof buildProgressiveFitRequest>,
) => Promise<ProgressivePolarFitResponse>;

export async function verifyRemoteReceiptOnlyHistory(
  db: DB,
  attemptId: string,
  archiveId: string,
  originalText: string,
  store: AttemptEvidenceStore,
) {
  await setAttemptEvidenceStoragePolicy(db, {
    enabled: true,
    consumerContractVersion: 1,
    receiptBearing: true,
    canaryAttemptId: attemptId,
  });
  const deps = {
    ...(await configuredAttemptEvidenceSettlementDependencies(db)),
    store,
  };
  const measurement = await settleAttemptEvidenceHistory(db, deps, {
    attemptId,
    archiveId,
  });
  expect(measurement.netValueBytesReclaimed).toBeGreaterThan(0);
  const pin = (await loadAttemptSourcePins(db, [attemptId])).get(attemptId)!;
  expect(pin.cfdAttemptToken).toBeNull();
  const prepared = (await prepareAttemptSources(db, store, [pin])).get(
    attemptId,
  )!;
  expect(prepared.payloadText).toBe(originalText);
  expect(attemptSourceApplicationSha256(pin)).toBe(
    analysisContentHash(prepared.payload),
  );
  const [sealed] =
    await db.execute(sql`SELECT verification->'dependencies' AS proof FROM attempt_evidence_storage_events
    WHERE id=${pin.storageEventId}::uuid`);
  expect(sealed.proof).toMatchObject({
    progressiveScope: { scientific: null, remote: { storageOnly: true } },
    reportedApplicationSha256: pin.applicationSha256,
    applicationSha256: pin.applicationSha256,
  });
  await restoreAttemptEvidence(
    db,
    attemptId,
    archiveId,
    originalText,
    "fixture restore after signed receipt read",
  );
}

/** Called with a submitted progressive RANS job in the enrollment suite's
 * disposable DB. The real scientific recorder, fit gateway and storage writer
 * issue every receipt. One selected and one historical attempt share a model. */
export async function verifyReceiptBearingHistory(
  db: DB,
  fixture: { composed: { jobId: string }; leases: ProgressiveCfdLease[] },
  calculateFit: Fit,
) {
  const job = fixture.composed.jobId;
  const [owner] = await db.execute(
    sql`SELECT id,airfoil_id,simulation_preset_revision_id,engine_job_id FROM sim_jobs WHERE id=${job}::uuid`,
  );
  const ids: string[] = [];
  for (const unit of fixture.leases.slice(0, 2)) {
    const [cell] = await db.execute(
      sql`SELECT id,bc_id FROM results WHERE sim_job_id=${job}::uuid AND aoa_deg=${unit.alpha}`,
    );
    const payload = {
      aoa_deg: unit.alpha,
      mesh_recovery_version: 3,
      solver_active_seconds: 12,
      cl: 0.4,
      cd: 0.03,
      cm: -0.02,
      fidelity: "rans",
      converged: true,
      unsteady: false,
      first_order_fallback: false,
      steady_history: stoppedHistoryFixture(),
    };
    const [a] = await db
      .insert(resultAttempts)
      .values({
        resultId: String(cell.id),
        bcId: String(cell.bc_id),
        airfoilId: String(owner.airfoil_id),
        simulationPresetRevisionId: String(owner.simulation_preset_revision_id),
        simJobId: job,
        engineJobId: String(owner.engine_job_id),
        engineCaseSlug: `fixture-${unit.alpha}`,
        aoaDeg: unit.alpha,
        status: "done",
        source: "solved",
        regime: "rans",
        unsteady: false,
        converged: true,
        validForPolar: false,
        cl: payload.cl,
        cd: payload.cd,
        cm: payload.cm,
        evidencePayload: payload,
      })
      .returning({ id: resultAttempts.id });
    ids.push(a.id);
    // PG preserves the additional decimal scale. Re-serializing a JS object
    // cannot restore this byte spelling.
    await db.execute(
      sql`UPDATE result_attempts SET evidence_payload=jsonb_set(evidence_payload,'{scale_fixture}','1.00'::jsonb) WHERE id=${a.id}::uuid`,
    );
  }
  expect(ids).toHaveLength(2);
  expect(
    await recordProgressiveCfdEvidence(db, {
      simJobId: job,
      engineJobId: String(owner.engine_job_id),
      resultAttemptIds: ids,
    }),
  ).toMatchObject({ linked: 2 });
  await db.execute(sql`UPDATE results r SET current_result_attempt_id=a.id,status=a.status,source=a.source,regime=a.regime,cl=a.cl,cd=a.cd,cm=a.cm
    FROM result_attempts a WHERE r.id=a.result_id AND a.id=${ids[0]}::uuid`);
  const [prediction] =
    await db.execute(sql`SELECT id FROM neuralfoil_predictions WHERE target_id=${fixture.leases[0]!.targetId}
    AND epoch_id=${fixture.leases[0]!.epochId}::uuid`);
  const lease = await claimProgressivePolarFit(db, {
    owner: "receipt-writer-test",
    leaseSeconds: 120,
    predictionId: String(prediction.id),
  });
  expect(lease).not.toBeNull();
  const request = buildProgressiveFitRequest(lease!);
  const model = await storeProgressivePolarFit(
    db,
    lease!,
    request,
    await calculateFit(request),
  );
  const modelSnapshot = async () => [
    ...(await db.execute(sql`SELECT m.id,m.source_signature,m.request,m.response,
    me.result_attempt_id,e.evidence_signature,r.current_result_attempt_id,raw.valid_for_polar,raw.cl,raw.cd,raw.cm
    FROM progressive_polar_models m JOIN progressive_polar_model_evidence me ON me.model_id=m.id
    JOIN progressive_cfd_evidence e ON e.result_attempt_id=me.result_attempt_id JOIN result_attempts raw ON raw.id=e.result_attempt_id
    JOIN results r ON r.id=raw.result_id WHERE m.id=${model} ORDER BY raw.id`)),
  ];
  const before = await modelSnapshot();
  expect(before).toHaveLength(2);
  const memory = new SettlementGcs(),
    store = new AttemptEvidenceStore(
      memory as unknown as ConstructorParameters<
        typeof AttemptEvidenceStore
      >[0],
    );
  const realRead = store.read.bind(store),
    spy = vi
      .spyOn(AttemptEvidenceStore.prototype, "read")
      .mockImplementation(realRead);
  const savedBucket = env.evidenceBucket;
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "fixture");
  env.evidenceBucket = "fixture";
  try {
    const policy = await getAttemptEvidenceStoragePolicy(db);
    expect(policy?.progressiveSourceScope).toBe("legacy");
    await setAttemptEvidenceStoragePolicy(db, {
      enabled: true,
      consumerContractVersion: 1,
      receiptBearing: true,
    });
    await db.execute(sql`UPDATE sim_jobs SET status='done',engine_state='completed',"ingestedAt"=clock_timestamp(),"finishedAt"=clock_timestamp(),
      ingest_lease_token=NULL,ingest_lease_expires_at=NULL WHERE id=${job}::uuid`);
    const ar = [];
    for (const id of ids)
      ar.push(
        (
          await archiveAttemptEvidence(db, store, {
            attemptId: id,
            bucket: "fixture",
            sourceInstance: "fixture",
          })
        ).archive,
      );
    const limiter = async () =>
      (
        await db.execute(
          sql`SELECT attempt_evidence_shortening_limiter(${ids[0]}::uuid,${ar[0]!.id}::uuid) AS why`,
        )
      )[0].why;
    expect(await limiter()).toBe("missing-exact-settled-progressive-receipt");
    await db.execute(
      sql`UPDATE progressive_cfd_attempts SET outcome='complete',finished_at=clock_timestamp() WHERE sim_job_id=${job}::uuid`,
    );
    await db.execute(sql`UPDATE progressive_cfd_units SET state='complete',lease_token=NULL,lease_owner=NULL,lease_until=NULL
      WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${job}::uuid)`);
    expect(await limiter()).toBeNull();
    const deps = {
      ...(await configuredAttemptEvidenceSettlementDependencies(db)),
      store,
    };
    const pins = await loadAttemptSourcePins(db, ids);
    const prepared = await prepareAttemptSources(db, store, [...pins.values()]);
    const [id] = ids;
    const origin = prepared.get(id!)!;
    expect(origin.payloadText).toMatch(/"scale_fixture": 1\.00/);
    expect(attemptSourceApplicationSha256(pins.get(id!)!, origin.payload)).toBe(
      origin.pin.cfdEvidenceSignature,
    );
    await db.transaction((tx) =>
      assertAttemptSourcePins(tx as unknown as DB, [origin.pin]),
    );
    const bad = {
      ...deps,
      verifyDependencies: async (
        input: Parameters<typeof deps.verifyDependencies>[0],
      ) => ({
        ...(await deps.verifyDependencies(input)),
        applicationSha256: "0".repeat(64),
      }),
    };
    await expect(
      settleAttemptEvidenceHistory(db, bad, {
        attemptId: id!,
        archiveId: ar[0]!.id,
      }),
    ).rejects.toThrow(/proof/i);
    const pass = await runAttemptEvidenceSettlementPass(db, deps, {
      maxRows: 2,
    });
    expect(pass).toMatchObject({ shortened: 2, failures: [] });
    expect(
      await attemptEvidenceShorteningCandidates(db, null, "receipt-bearing"),
    ).toHaveLength(2);
    expect(await modelSnapshot()).toEqual(before);
    const cold = await loadAttemptSourcePins(db, ids);
    const fetched = await prepareAttemptSources(db, store, [...cold.values()]);
    await db.transaction((tx) =>
      assertAttemptSourcePins(
        tx as unknown as DB,
        [...fetched.values()].map((s) => s.pin),
      ),
    );
    await expect(
      db.transaction((tx) =>
        assertAttemptSourcePins(tx as unknown as DB, [origin.pin]),
      ),
    ).rejects.toThrow(/changed/);
    for (const attemptId of ids) {
      const p = cold.get(attemptId)!,
        s = fetched.get(attemptId)!;
      await expect(
        prepareAttemptSources(db, store, [{ ...p, resultId: randomUUID() }]),
      ).rejects.toThrow(/binding changed/);
      expect(s.payloadText).toBe(prepared.get(attemptId)!.payloadText);
      expect(attemptSourceApplicationSha256(p)).toBe(
        analysisContentHash(s.payload),
      );
      expect(reportTextIdentity(s.payloadText).sha256).toBe(p.sourceSha256);
      const projection = async (
        archiveId: string | null,
        text: string | null,
      ) =>
        (
          await db.execute(sql`SELECT
        attempt_evidence_payload_for_publication(${attemptId}::uuid,${archiveId}::uuid,${text})::text AS full`)
        )[0].full;
      expect(await projection(p.archiveId, s.payloadText)).toBe(s.payloadText);
      await expect(projection(randomUUID(), s.payloadText)).rejects.toThrow(
        /current archive/,
      );
      await expect(projection(null, s.payloadText)).rejects.toThrow(
        /current archive/,
      );
      await expect(
        projection(p.archiveId, s.payloadText.replace("1.00", "2.00")),
      ).rejects.toThrow(/exact original/);
      await expect(
        projection(p.archiveId, s.payloadText + " "),
      ).rejects.toThrow(/exact original/);
      const copy = sql`SELECT attempt_token,result_attempt_id,evidence_signature,solver_active_seconds,budget_guard_exhausted
        FROM progressive_cfd_evidence WHERE result_attempt_id=${attemptId}::uuid`;
      await db.execute(
        sql`INSERT INTO progressive_cfd_evidence(attempt_token,result_attempt_id,evidence_signature,solver_active_seconds,budget_guard_exhausted) ${copy} ON CONFLICT DO NOTHING`,
      );
      await expect(
        db.execute(sql`INSERT INTO progressive_cfd_evidence(attempt_token,result_attempt_id,evidence_signature,solver_active_seconds)
        VALUES (${p.cfdAttemptToken}::uuid,${attemptId}::uuid,${"0".repeat(64)},12) ON CONFLICT DO NOTHING`),
      ).rejects.toThrow(/exact archived attempt/);
      await expect(
        db.execute(sql`INSERT INTO progressive_cfd_evidence(attempt_token,result_attempt_id,evidence_signature,solver_active_seconds)
        VALUES (${p.cfdAttemptToken}::uuid,${attemptId}::uuid,${p.applicationSha256},9999) ON CONFLICT DO NOTHING`),
      ).rejects.toThrow(/exact archived attempt/);
      await restoreAttemptEvidence(
        db,
        attemptId,
        p.archiveId!,
        s.payloadText,
        "fixture restore",
      );
      await expect(projection(p.archiveId, s.payloadText)).rejects.toThrow(
        /current archive/,
      );
    }
    expect(await modelSnapshot()).toEqual(before);
  } finally {
    spy.mockRestore();
    env.evidenceBucket = savedBucket;
    vi.unstubAllEnvs();
    await setAttemptEvidenceStoragePolicy(db, { enabled: false });
  }
}
