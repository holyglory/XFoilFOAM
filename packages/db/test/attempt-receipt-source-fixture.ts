import { measuredFixtureFloor, verifiedHubFixtureProof, assertShortProof } from "../../../apps/sweeper/test-support/short-attempt-proof";
import { setShortAttemptProofPolicy } from "../src/attempt-evidence-projection";
import { selectedDetailBaseline, verifySelectedDetailField } from "../../../apps/api/test/selected-attempt-detail-fixture";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import { analysisContentHash } from "../src/analysis-target";
import { recordProgressiveCfdEvidence } from "../src/progressive-cfd-evidence";
import { acknowledgeProgressiveCfdExecutionStop, settleProgressiveCfdExecution } from "../src/progressive-cfd-settlement";
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
  tiny = false,
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
      steady_history: stoppedHistoryFixture(tiny ? 14 : 1500),
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
  await db.execute(sql`UPDATE results r SET current_result_attempt_id=a.id,status=a.status,source=a.source,regime=a.regime,cl=a.cl,cd=a.cd,cm=a.cm,
    steady_history=a.evidence_payload->'steady_history'
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
    await acknowledgeProgressiveCfdExecutionStop(db, {
      simJobId: job, proof: {version:1,job_id:String(owner.engine_job_id),execution_stopped:true,
        producer_stopped:true,namespace_verified:true,remaining:[],observed_at:new Date().toISOString(),error:null,
        fence:"terminal_result",ownership_basis:"recorded_execution_namespace"},
    });
    const inlineSettlement = await settleProgressiveCfdExecution(db, job);
    if (tiny) {
      expect(await limiter()).toBe("missing-bounded-source-archive");
      await setShortAttemptProofPolicy(db, true, ids[1]!, "tiny-history");
      expect(await limiter()).toBe("missing-bounded-source-archive");
      await setShortAttemptProofPolicy(db, true, undefined, "tiny-history");
    }
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
    const publicInline = await selectedDetailBaseline(db, id!);
    let floor = 1024;
    if (!tiny) {
      // Enabling small originals must never waive this larger owner's fee.
      await setShortAttemptProofPolicy(db,true,undefined,"tiny-history");
      const floors = [];
      for (const [i, pointId] of ids.entries()) {
        const verified = await verifiedHubFixtureProof(db,deps,pointId,ar[i]!.id);
        floors.push(await measuredFixtureFloor(db,pointId,ar[i]!.id,verified));
      }
      floor = Math.max(...floors);
      await db.execute(sql`UPDATE attempt_evidence_storage_policy SET min_net_value_bytes=${floor} WHERE id=1`);
      await expect(settleAttemptEvidenceHistory(db,deps,{attemptId:id!,archiveId:ar[0]!.id})).rejects.toThrow(/insufficient net/);
      await setShortAttemptProofPolicy(db,false,undefined,"tiny-history");
      await setShortAttemptProofPolicy(db,true,ids[1]!);
      await expect(settleAttemptEvidenceHistory(db,deps,{attemptId:id!,archiveId:ar[0]!.id})).rejects.toThrow(/insufficient net/);
      await setShortAttemptProofPolicy(db,true);
    }
    const pass = await runAttemptEvidenceSettlementPass(db, deps, {
      maxRows: 2,
    });
    expect(pass).toMatchObject({ shortened: 2, failures: [] });
    for (const [i, pointId] of ids.entries()) {
      const stored = await assertShortProof(db,pointId,ar[i]!.id,undefined,tiny);
      if (!tiny) expect(Number(stored.saved)).toBeGreaterThanOrEqual(floor);
      expect(stored.generation).toBe(ar[i]!.generation);
    }
    await setShortAttemptProofPolicy(db,false,undefined,tiny ? "tiny-history" : "measured-floor");
    await db.execute(sql`UPDATE attempt_evidence_storage_policy SET min_net_value_bytes=1024 WHERE id=1`);

    if (!tiny) await verifySelectedDetailField(db, publicInline, "steady_history");
    expect(await settleProgressiveCfdExecution(db, job)).toEqual(inlineSettlement);
    expect(
      await attemptEvidenceShorteningCandidates(db, null, "receipt-bearing"),
    ).toHaveLength(2);
    expect(await modelSnapshot()).toEqual(before);
    const cold = await loadAttemptSourcePins(db, ids);
    const fetched = await prepareAttemptSources(db, store, [...cold.values()]);
    if (tiny) {
      const selected=ar[0]!;
      const {enableVerifiedAttemptPolicy}=await import("../src/attempt-evidence-verified-policy");
      const {readStoredResultHistories}=await import("../../../apps/api/src/result-history-reader");
      const {resultHistoriesMatch}=await import("../src/result-history-storage");
      const {withProgressiveSyncApi}=await import("../../../apps/api/test/progressive-polar-import-fixture");
      const secret=randomUUID();
      await db.execute(sql`UPDATE sync_api_settings SET enabled=true,secret=${secret} WHERE id=1`);
      await db.execute(sql`INSERT INTO sync_api_permissions(data_type,can_fetch,can_push) VALUES('polars',true,false)
        ON CONFLICT(data_type) DO UPDATE SET can_fetch=true`);
      const exported=()=>withProgressiveSyncApi(db,async app=>{
        const response=await app.inject({method:"GET",url:"/api/sync/v1/export?types=polars&limit=500",headers:{"x-xfoilfoam-sync-secret":secret}});
        expect(response.statusCode).toBe(200);
        const item=response.json().items.find((i:{data:{remoteResultId:string}})=>i.data.remoteResultId===selected.resultId);
        expect(item).toBeDefined();
        return item;
      });
      const beforeExport=await exported();
      await enableVerifiedAttemptPolicy(db);
      await setShortAttemptProofPolicy(db,true,selected.resultId!,"canonical-subtree");
      const {canonicalSubtreeCandidates}=await import("../src/result-history-subtrees");
      expect(await canonicalSubtreeCandidates(db,selected.attemptId)).toEqual([
        expect.objectContaining({result_id:selected.resultId,kind:"steady_history",archive:selected.id})
      ]);
      const offered=await attemptEvidenceShorteningCandidates(db,null,"verified",true);
      expect(offered.find(row=>row.id===selected.attemptId)).toMatchObject({canonical_fields:true});
      const oldUploads=memory.uploads;
      const [previous]=await db.execute(sql`SELECT steady_history::text field,current_result_attempt_id FROM results WHERE id=${selected.resultId}::uuid`);
      const ownerCount=await modelSnapshot();
      const normalPass=await runAttemptEvidenceSettlementPass(db,deps,{maxRows:2});
      expect(normalPass).toMatchObject({canonicalFieldsVerified:1,shortened:0,failures:[]});
      expect(memory.uploads).toBe(oldUploads);
      const [field]=await db.execute(sql`SELECT id, steady_history AS "steadyHistory",current_result_attempt_id,
        steady_history_subtree_id AS "steadyHistorySubtreeId",steady_history_archive_id AS "steadyHistoryArchiveId" FROM results WHERE id=${selected.resultId}::uuid`);
      expect(field.current_result_attempt_id).toBe(previous.current_result_attempt_id);
      expect(field.steadyHistorySubtreeId).toBeTruthy();
      expect(field.steadyHistoryArchiveId).toBeNull();
      const restored=await readStoredResultHistories(db,{id:String(field.id),steadyHistory:field.steadyHistory,steadyHistorySubtreeId:String(field.steadyHistorySubtreeId)});
      expect(restored.steadyHistory).toEqual(JSON.parse(String(previous.field)));
      expect(await resultHistoriesMatch(db,String(field.id),{steadyHistory:restored.steadyHistory,frameTrack:null})).toBe(true);
      expect(await exported()).toEqual(beforeExport);
      expect(beforeExport.data).not.toHaveProperty("steadyHistorySubtreeId");
      expect(await modelSnapshot()).toEqual(ownerCount);
      const currentPublic=await selectedDetailBaseline(db,selected.attemptId);
      expect(currentPublic.body.steadyHistory).toEqual(publicInline.body.steadyHistory);
      expect(currentPublic.body.cl).toBe(publicInline.body.cl);
      const {restoreCanonicalSubtree}=await import("../src/result-history-subtrees");
      expect(await restoreCanonicalSubtree(db,{resultId:String(field.id),kind:"steady_history",
        reference:String(field.steadyHistorySubtreeId),archiveId:selected.id,generation:selected.generation,fieldText:String(previous.field)})).toBe(true);
      await setShortAttemptProofPolicy(db,false,undefined,"canonical-subtree");
      // Independently exercise the existing 0206 standalone archive contract
      // against the restored canonical field.
      await verifySelectedDetailField(db,publicInline,"steady_history");
    }
    memory.failReads = true;
    try {
      await expect(prepareAttemptSources(db,store,[...cold.values()])).rejects.toThrow();
    } finally {
      memory.failReads = false;
    }
    await expect(db.execute(sql`SELECT attempt_evidence_expand_projection(p.projection,foreign_source)
      FROM attempt_evidence_history_projections p JOIN attempt_evidence_archives foreign_source ON foreign_source.id=${ar[1]!.id}::uuid
      WHERE p.result_attempt_id=${ids[0]}::uuid AND p.archive_id=${ar[0]!.id}::uuid`)).rejects.toThrow(/another original/);
    await expect(db.execute(sql`SELECT attempt_evidence_expand_receipt(e.verification,foreign_source)
      FROM attempt_evidence_storage_events e JOIN attempt_evidence_archives foreign_source ON foreign_source.id=${ar[1]!.id}::uuid
      WHERE e.result_attempt_id=${ids[0]}::uuid AND e.archive_id=${ar[0]!.id}::uuid AND e.action='shorten'`)).rejects.toThrow(/another original/);

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
