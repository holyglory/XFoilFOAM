import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { createClient } from "../src/client";
import {
  analysisContentHash,
  type AnalysisPhysical,
} from "../src/analysis-target";
import { createAttemptServerDependencyVerifier } from "../src/attempt-evidence-dependency-verifier";
import { type AttemptEvidenceArchiveReader } from "../src/attempt-evidence-reader";
import {
  restoreAttemptEvidence,
  setAttemptEvidenceStoragePolicy,
} from "../src/attempt-evidence-projection";
import {
  claimProgressivePolarFit,
  invalidateProgressiveFitPolicy,
  readHistoricalProgressiveFit,
  readProgressiveFitSource,
  storeProgressivePolarFit,
} from "../src/progressive-polar-cache";
import { progressivePredictionFixture } from "../test-support/progressive-prediction";
import { AttemptEvidenceStore } from "../../../apps/sweeper/src/attempt-evidence-store";
import {
  buildProgressiveFitRequest,
  runProgressiveFitBatch,
} from "../../../apps/sweeper/src/progressive-fitting";
import {
  createSettlementFixture,
  seedSettledHistory,
} from "../../../apps/sweeper/test-support/attempt-settlement-fixture";
import { settleAttemptEvidenceHistory } from "../../../apps/sweeper/src/attempt-evidence-settlement";
import {
  apiAttemptEvidenceReader,
  readApiAttemptEvidenceForApp,
} from "../../../apps/api/src/attempt-evidence-reader";
import { env } from "../../../apps/api/src/env";
import type {
  ProgressivePolarFitRequest,
  ProgressivePolarFitResponse,
} from "../../engine-client/src/progressive-polar";

const root = new URL("../../../", import.meta.url);
function fit(request: ProgressivePolarFitRequest): ProgressivePolarFitResponse {
  return JSON.parse(
    execFileSync(
      process.env.XFOILFOAM_PYTHON ?? process.env.PYTHON ?? "python3",
      [
        fileURLToPath(
          new URL("tests/progressive_fit_gateway_fixture.py", root),
        ),
      ],
      {
        cwd: fileURLToPath(root),
        encoding: "utf8",
        input: JSON.stringify(request),
        timeout: 30_000,
        env: {
          ...process.env,
          PYTHONPATH: [
            fileURLToPath(new URL("src", root)),
            process.env.PYTHONPATH,
          ]
            .filter(Boolean)
            .join(delimiter),
        },
      },
    ),
  );
}

it("rebuilds and historically replays a receipt-bearing fitted history across shorten and restore", async () => {
  const fixture = await createSettlementFixture();
  const observer = createClient({ max: 1 });
  const { db } = fixture;
  const oldBucket = env.evidenceBucket;
  try {
    // Use the existing isolated storage schema and its real archive/settlement fixture.
    // These additional read-model tables and keys stay inside that namespace.
    for (const name of [
      "calculation_epochs",
      "neuralfoil_predictions",
      "progressive_generation_targets",
      "result_review_verdicts",
      "progressive_polar_models",
      "progressive_polar_geometry_verifications",
      "progressive_polar_fit_work",
    ]) {
      await db.execute(
        sql`CREATE TABLE ${sql.identifier(name)} AS TABLE public.${sql.identifier(name)} WITH NO DATA`,
      );
    }
    await db.execute(
      sql`ALTER TABLE progressive_polar_models ADD PRIMARY KEY(id)`,
    );
    await db.execute(
      sql`ALTER TABLE progressive_polar_model_evidence ADD PRIMARY KEY(model_id,result_attempt_id)`,
    );
    await db.execute(
      sql`ALTER TABLE progressive_polar_geometry_verifications ADD PRIMARY KEY(model_id,policy_version)`,
    );
    for (const name of [
      "0210_stopped_progressive_attempt_history.sql",
      "0211_progressive_attempt_receipt_sources.sql",
    ]) {
      const body = await readFile(
        new URL(`../migrations/${name}`, import.meta.url),
        "utf8",
      );
      for (const statement of body
        .split("--> statement-breakpoint")
        .filter((part) => part.trim()))
        await db.execute(sql.raw(statement));
    }
    const seeded = await seedSettledHistory(db);
    const { attemptId, resultId, jobId, archive, store } = seeded;
    const target = analysisContentHash("scientific fit fixture");
    const epoch = randomUUID(),
      generation = randomUUID(),
      work = randomUUID(),
      unit = randomUUID(),
      token = randomUUID();
    const physical = {
      branch: "increasing",
      geometry: [
        [1, 0],
        [0, 0],
        [1, 0],
      ],
      derived: { reynolds: 100000, mach: 0.03 },
      transition: { nCrit: 9, upper: 1, lower: 1 },
      boundary: { sandGrainHeight: 0 },
    } as AnalysisPhysical;
    const prediction = progressivePredictionFixture({
      targetId: target,
      angles: [-2, 0, 2],
      physical,
      recipes: { neuralfoil: {} } as Parameters<
        typeof progressivePredictionFixture
      >[0]["recipes"],
    });
    const predictionId = analysisContentHash(prediction);
    const [attempt] = await db.execute(
      sql`SELECT evidence_payload FROM result_attempts WHERE id=${attemptId}`,
    );
    const signature = analysisContentHash(attempt.evidence_payload);
    await db.execute(
      sql`UPDATE sim_jobs SET engine_job_id=${`local:${jobId}`} WHERE id=${jobId}`,
    );
    await db.execute(
      sql`UPDATE results SET aoa_deg=0,current_result_attempt_id=${attemptId} WHERE id=${resultId}`,
    );
    await db.execute(
      sql`INSERT INTO calculation_epochs(id,current) VALUES (${epoch},true)`,
    );
    await db.execute(
      sql`INSERT INTO polar_analysis_targets(id,physical) VALUES(${target},${JSON.stringify(physical)}::jsonb)`,
    );
    await db.execute(
      sql`INSERT INTO neuralfoil_predictions(id,epoch_id,target_id,payload) VALUES(${predictionId},${epoch},${target},${JSON.stringify(prediction)}::jsonb)`,
    );
    await db.execute(
      sql`INSERT INTO progressive_generations(id,epoch_id,benchmark_only) VALUES (${generation},${epoch},false)`,
    );
    await db.execute(
      sql`INSERT INTO progressive_generation_targets(generation_id,target_id,recipes) VALUES (${generation},${target},'{}')`,
    );
    await db.execute(
      sql`INSERT INTO progressive_work(id,generation_id,target_id,stage) VALUES(${work},${generation},${target},2)`,
    );
    await db.execute(
      sql`INSERT INTO progressive_cfd_units(id,work_id,aoa_deg) VALUES(${unit},${work},0)`,
    );
    await db.execute(
      sql`INSERT INTO progressive_cfd_attempts(token,unit_id,sim_job_id,outcome) VALUES(${token},${unit},${jobId},'complete')`,
    );
    await db.execute(
      sql`INSERT INTO progressive_cfd_evidence(attempt_token,result_attempt_id,evidence_signature) VALUES(${token},${attemptId},${signature})`,
    );
    await db.execute(
      sql`INSERT INTO result_classifications(id,result_attempt_id,state,reasons,classifier_version) VALUES(${randomUUID()},${attemptId},'accepted','{}','fixture')`,
    );
    await db.execute(
      sql`INSERT INTO progressive_polar_fit_work(prediction_id,source_version,state,attempts) VALUES(${predictionId},1,'pending',0)`,
    );

    const readObject = store.read.bind(store);
    const [session] = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
    const read = vi.fn<AttemptEvidenceArchiveReader["read"]>(
      async (identity, signal) => {
        // An observer sees the real one-connection fit pool between statements.
        const [activity] = await observer.db.execute(
          sql`SELECT state,xact_start FROM pg_stat_activity WHERE pid=${session.pid}`,
        );
        expect(activity).toMatchObject({ state: "idle", xact_start: null });
        expect(identity).toMatchObject({
          attemptId,
          resultId,
          simJobId: jobId,
          generation: archive.generation,
        });
        return readObject(identity, signal);
      },
    );
    const reader = { read };
    const acquire = async () => {
      const lease = await claimProgressivePolarFit(db, {
        owner: "archive-fit",
        leaseSeconds: 120,
        predictionId,
        archiveReader: reader,
      });
      if (!lease) throw new Error("Expected the isolated scientific fit lease");
      return lease;
    };
    const hot = await acquire();
    const original = buildProgressiveFitRequest(hot);
    expect(original.histories.map((h) => h.observation.attempt_id)).toEqual([
      attemptId,
    ]);
    expect(original.histories[0].coordinate.length).toBe(1600);
    const expected = fit(original);
    const modelId = await storeProgressivePolarFit(db, hot, original, expected);
    expect(read).not.toHaveBeenCalled();

    const rollbackScope = new Error("Restore verified fit after scope admission checks");
    await expect(db.transaction(async tx => {
      const scoped = tx as unknown as typeof db;
      const acquireScoped = () => claimProgressivePolarFit(scoped, {
        owner: "scoped-fit", leaseSeconds: 120, predictionId, requireCfdEvidence: true, archiveReader: reader,
      });
      const evidenceScans = () => tx.execute(sql`SELECT seq_scan,idx_scan FROM pg_stat_xact_user_tables
        WHERE relid='progressive_cfd_evidence'::regclass`);
      const before = await evidenceScans();
      expect(await acquireScoped()).toBeNull();
      expect(await evidenceScans()).toEqual(before);
      await tx.execute(sql`UPDATE progressive_polar_fit_work SET model_id=NULL WHERE prediction_id=${predictionId}`);
      const missingModel = await acquireScoped();
      expect(missingModel?.source.signature).toBe(hot.source.signature);
      expect(await acquireScoped()).toBeNull();
      await tx.execute(sql`UPDATE progressive_polar_fit_work SET lease_until=clock_timestamp()-interval '1 second'
        WHERE prediction_id=${predictionId}`);
      expect((await acquireScoped())?.source.signature).toBe(hot.source.signature);
      throw rollbackScope;
    })).rejects.toBe(rollbackScope);

    vi.spyOn(apiAttemptEvidenceReader, "read").mockImplementation(
      store.read.bind(store),
    );
    env.evidenceBucket = "fixture";
    await setAttemptEvidenceStoragePolicy(db, {
      enabled: true,
      consumerContractVersion: 1,
      receiptBearing: true,
    });
    await settleAttemptEvidenceHistory(
      db,
      {
        store,
        readApp: (request) => readApiAttemptEvidenceForApp(db, request),
        verifyDependencies: createAttemptServerDependencyVerifier(db, store),
      },
      { attemptId, archiveId: archive.id },
    );
    const [compacted] =
      await db.execute(sql`SELECT evidence_archive_id, evidence_payload#>'{steady_history,cl}' AS samples
      FROM result_attempts WHERE id=${attemptId}`);
    expect(compacted).toMatchObject({
      evidence_archive_id: archive.id,
      samples: null,
    });
    await invalidateProgressiveFitPolicy(db, "rebuild-scientific-fixture", {
      preserveCurrent: false,
    });
    const cold = await acquire();
    expect(read).toHaveBeenCalledTimes(1);
    const rebuilt = buildProgressiveFitRequest(cold);
    expect(cold.source.signature).toBe(hot.source.signature);
    expect(analysisContentHash({ ...rebuilt, lease_token: hot.token })).toBe(
      analysisContentHash(original),
    );
    const output = fit(rebuilt);
    expect({ ...output, lease_token: hot.token }).toEqual(expected);
    const tampered = structuredClone(rebuilt);
    tampered.histories[0].coefficients[0][0] += 0.001;
    await expect(
      storeProgressivePolarFit(db, cold, tampered, output),
    ).rejects.toThrow("immutable source");
    const rebuiltModel = await storeProgressivePolarFit(
      db,
      cold,
      rebuilt,
      output,
    );
    expect(await storeProgressivePolarFit(db, cold, rebuilt, output)).toBe(
      rebuiltModel,
    );
    expect(read).toHaveBeenCalledTimes(1);

    await invalidateProgressiveFitPolicy(db, "normal-sweeper-refresh", {
      preserveCurrent: false,
    });
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
    vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "fixture");
    const workerRead = vi
      .spyOn(AttemptEvidenceStore.prototype, "read")
      .mockImplementation(read);
    const delivery = await runProgressiveFitBatch(
      db,
      {
        fitProgressivePolar: async (request) => {
          const response = fit(request);
          expect({ ...response, lease_token: hot.token }).toEqual(expected);
          return response;
        },
      },
      "archive-fit-worker",
      { requireSweeperEnabled: false },
    );
    expect(delivery).toEqual({ claimed: 1, stored: 1, errors: [] });
    expect(workerRead).toHaveBeenCalledTimes(1);
    workerRead.mockRestore();

    // A damaged original cannot silently fall back to scalar coefficients or a prior curve.
    const corrupt: AttemptEvidenceArchiveReader = {
      read: async (identity, signal) => {
        const source = await readObject(identity, signal);
        return { ...source, payloadText: source.payloadText + " " };
      },
    };
    await expect(
      readProgressiveFitSource(db, predictionId, corrupt),
    ).rejects.toThrow();
    await invalidateProgressiveFitPolicy(db, "recheck-scientific-fixture", {
      preserveCurrent: false,
    });
    const racing = await acquire();
    const racingRequest = buildProgressiveFitRequest(racing);
    const racingOutput = { ...expected, lease_token: racing.token };
    const reviewId = randomUUID();
    await db.execute(
      sql`INSERT INTO result_review_verdicts(id,result_id,verdict) VALUES(${reviewId},${resultId},'exclude')`,
    );
    await expect(
      storeProgressivePolarFit(db, racing, racingRequest, racingOutput),
    ).rejects.toThrow("evidence changed");
    const reviewed = await readProgressiveFitSource(db, predictionId, reader);
    expect(
      buildProgressiveFitRequest({ ...cold, source: reviewed }).observations[0]
        .exclusion_reason,
    ).toBe("review_exclude");
    const replay = await readHistoricalProgressiveFit(db, modelId, reader);
    expect(analysisContentHash(replay.request)).toBe(
      analysisContentHash(original),
    );
    expect(fit(replay.request)).toEqual(expected);

    await db.execute(
      sql`DELETE FROM result_review_verdicts WHERE id=${reviewId}`,
    );
    const { payloadText } = await store.read(archive);
    const calls = read.mock.calls.length;
    await restoreAttemptEvidence(
      db,
      attemptId,
      archive.id,
      payloadText,
      "scientific fixture restore",
    );
    await expect(
      storeProgressivePolarFit(db, racing, racingRequest, racingOutput),
    ).rejects.toThrow(/storage changed|binding changed/);
    expect(read).toHaveBeenCalledTimes(calls);
    const restored = await readProgressiveFitSource(db, predictionId, reader);
    expect(
      analysisContentHash(
        buildProgressiveFitRequest({ ...hot, source: restored }),
      ),
    ).toBe(analysisContentHash(original));
    expect(read).toHaveBeenCalledTimes(calls);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    env.evidenceBucket = oldBucket;
    try {
      await fixture.close();
    } finally {
      await observer.sql.end();
    }
  }
}, 120_000);
