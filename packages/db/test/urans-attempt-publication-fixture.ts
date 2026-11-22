import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import { analysisContentHash } from "../src/analysis-target";
import {
  resultAttempts,
  solverEvidenceArtifacts,
  resultMedia,
  forceHistory,
} from "../src/schema";
import { createVerifiedRestartArchiveFixture } from "../src/test-fixtures";
import { recordProgressiveCfdEvidence } from "../src/progressive-cfd-evidence";
import {
  setAttemptEvidenceStoragePolicy,
  restoreAttemptEvidence,
} from "../src/attempt-evidence-projection";
import { buildPolarFit, classifyPolarEvidence } from "@aerodb/core";
import { readPolarAttemptEvidenceForConsumerProof } from "../src/polar-cache";
import type {
  PolarPoint,
  PointFidelity,
  FrameTrack,
} from "../../engine-client/src";
import {
  ensureResultInterpretationReducerVersion,
  selectAcceptedArchiveInterpretation,
  stageArchiveResultInterpretation,
} from "../../../apps/sweeper/src/result-interpretations";
import { archiveAttemptEvidence } from "../../../apps/sweeper/src/attempt-evidence-service";
import {
  configuredAttemptEvidenceSettlementDependencies,
  settleAttemptEvidenceHistory,
} from "../../../apps/sweeper/src/attempt-evidence-settlement";
import { AttemptEvidenceStore } from "../../../apps/sweeper/src/attempt-evidence-store";
import { SettlementGcs } from "../../../apps/sweeper/test-support/attempt-settlement-fixture";
import { env } from "../../../apps/api/src/env";
import { readStoredAttemptEvidenceText } from "../../../apps/api/src/attempt-evidence-reader";
import { stoppedHistoryFixture } from "./progressive-stopped-history-fixture";

function noSheddingPoint(alpha: number): PolarPoint {
  const times = Array.from({ length: 400 }, (_, i) => (4.2 * i) / 399);
  const channel = (base: number, amplitude: number) => {
    const values = times.map(
      (_, i) => base + amplitude * Math.sin(i * 0.754877666),
    );
    const average = (samples: number[]) =>
      samples
        .slice(1)
        .reduce(
          (sum, x, i) =>
            sum + 0.5 * (x + samples[i]!) * (times[i + 1]! - times[i]!),
          0,
        ) /
      (times.at(-1)! - times[0]!);
    const mean = average(values),
      rms = Math.sqrt(average(values.map((x) => (x - mean) ** 2)));
    return { values, mean, rms };
  };
  const cl = channel(0.81, 0.0000008),
    cd = channel(0.031, 0.00000003),
    cm = channel(-0.09, 0.00000008);
  return {
    aoa_deg: alpha,
    case_slug: `steady-equivalent-${alpha}`,
    cl: cl.mean,
    cd: cd.mean,
    cm: cm.mean,
    cl_cd: cl.mean / cd.mean,
    unsteady: false,
    converged: true,
    first_order_fallback: false,
    images: {},
    solver_active_seconds: 15,
    frame_track: null,
    urans_cycle_certificate: null,
    force_history: {
      t: times,
      cl: cl.values,
      cd: cd.values,
      cm: cm.values,
      samples: times.length,
      window_start: 0,
      window_end: 4.2,
    },
    no_shedding_certificate: {
      reducer_version: "no-shedding-v1",
      certified: true,
      required_observation_s: 4.2,
      observation_start_time: 0,
      observation_end_time: 4.2,
      observed_observation_s: 4.2,
      source_sample_count: times.length,
      transport_sample_count: times.length,
      relative_tolerance: 0.005,
      absolute_floor: 0.001,
      cl_mean: cl.mean,
      cd_mean: cd.mean,
      cm_mean: cm.mean,
      cl_rms: cl.rms,
      cd_rms: cd.rms,
      cm_rms: cm.rms,
      transport_cl_mean: cl.mean,
      transport_cd_mean: cd.mean,
      transport_cm_mean: cm.mean,
      transport_cl_rms: cl.rms,
      transport_cd_rms: cd.rms,
      transport_cm_rms: cm.rms,
    },
  };
}

function periodicPoint(
  alpha: number,
  cycles: number,
  certified: boolean,
): PolarPoint {
  const period = 0.02,
    cl = 0.81,
    cd = 0.031,
    cm = -0.09;
  const samples = (per: number) =>
    Array.from({ length: cycles * per }, (_, i) => {
      const phase = Math.sin((2 * Math.PI * (i % per)) / per);
      return {
        i,
        t: (i * period) / per,
        cl: cl + 0.014 * phase,
        cd: cd + 0.001 * phase,
        cm: cm + 0.003 * phase,
      };
    });
  const forces = samples(80),
    frames = samples(24);
  const stats = (mean: number, amplitude: number) => ({
    mean,
    std: amplitude / Math.sqrt(2),
    min: mean - amplitude,
    max: mean + amplitude,
  });
  const frameTrack: FrameTrack = {
    period_s: period,
    periods_retained: cycles,
    stationary: certified,
    drift_frac: 0,
    window: { t_start: 0, t_end: cycles * period },
    stats: { cl: stats(cl, 0.014), cd: stats(cd, 0.001), cm: stats(cm, 0.003) },
    fields: ["pressure"],
    frames,
    image_pattern: "frame-{i}.png",
  };
  return {
    aoa_deg: alpha,
    case_slug: `periodic-${alpha}`,
    cl,
    cd,
    cm,
    cl_cd: cl / cd,
    unsteady: true,
    converged: certified,
    first_order_fallback: false,
    images: {},
    solver_active_seconds: 15,
    frame_track: frameTrack,
    force_history: {
      t: forces.map((x) => x.t),
      cl: forces.map((x) => x.cl),
      cd: forces.map((x) => x.cd),
      cm: forces.map((x) => x.cm),
      window_start: 0,
      window_end: cycles * period,
      period_s: period,
      retained_cycles: cycles,
      samples: forces.length,
      source_start_time: 0,
    },
    urans_cycle_certificate: {
      reducer_version: "clean-cycle-v3",
      period_s: period,
      phase_samples: 96,
      required_clean_cycles: cycles,
      terminal_clean_cycles: certified ? cycles : 0,
      selected_cycle_start_index: certified ? 0 : null,
      certified,
      cadence_adjusted: false,
      cycles: Array.from({ length: cycles }, (_, index) => ({
        index,
        t_start: index * period,
        t_end: (index + 1) * period,
        coefficient_samples: 80,
        field_frames: 24,
        phase_max_gap: 1 / 24,
        phase_shift_bins: 0,
        cl_mean: cl,
        cd_mean: cd,
        cm_mean: cm,
        cl_shape_error: 0.01,
        cd_shape_error: 0.01,
        cm_shape_error: 0.01,
        cl_amplitude_deviation: 0.01,
        cd_amplitude_deviation: 0.01,
        cm_amplitude_deviation: 0.01,
        cl_high_frequency: 0.01,
        cd_high_frequency: 0.01,
        cm_high_frequency: 0.01,
        disposition: certified
          ? ("selected" as const)
          : ("settling_outlier" as const),
        reasons: certified ? [] : ["shape_drift"],
      })),
    },
  };
}

export async function verifyUransAttemptPublication(
  db: DB,
  jobId: string,
  angles: number[],
) {
  const [job] =
    await db.execute(sql`SELECT job.airfoil_id,job.simulation_preset_revision_id,job.engine_job_id,revision.solver_implementation_id,
    job.request_payload#>'{engineRequest,solver}' AS solver FROM sim_jobs job
    JOIN simulation_preset_revisions revision ON revision.id=job.simulation_preset_revision_id WHERE job.id=${jobId}::uuid`);
  const solver = job.solver as {
    force_transient: boolean;
    urans_fidelity: string;
  };
  expect(solver.force_transient).toBe(true);
  expect(["precalc", "full"]).toContain(solver.urans_fidelity);
  const fidelity: PointFidelity =
    solver.urans_fidelity === "full" ? "urans_full" : "urans_precalc";
  const periods = fidelity === "urans_full" ? 5 : 3;
  const dir = await mkdtemp(join(tmpdir(), "urans-history-publication-"));
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGpsAAAAASUVORK5CYII=",
    "base64",
  );
  const points = [];
  const memory = new SettlementGcs(),
    store = new AttemptEvidenceStore(
      memory as unknown as ConstructorParameters<
        typeof AttemptEvidenceStore
      >[0],
    );
  const oldBucket = env.evidenceBucket;
  env.evidenceBucket = "fixture";
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "fixture");
  let writing = false;
  const real = store.read.bind(store);
  const spy = vi
    .spyOn(AttemptEvidenceStore.prototype, "read")
    .mockImplementation(async (identity, signal) => {
      expect(writing, "archive IO inside interpretation write").toBe(false);
      return real(identity, signal);
    });
  try {
    const reducer = await ensureResultInterpretationReducerVersion(db);
    const [run] = await db.execute(
      sql`INSERT INTO result_interpretation_backfill_runs(reducer_version_id) VALUES(${reducer}::uuid) RETURNING id`,
    );
    for (const [index, alpha] of angles.entries()) {
      const point =
        index === 2
          ? noSheddingPoint(alpha)
          : periodicPoint(alpha, periods, index === 0);
      point.fidelity = fidelity;
      if (index === 0) point.steady_history = stoppedHistoryFixture();
      const [cell] = await db.execute(
        sql`SELECT id,bc_id FROM results WHERE sim_job_id=${jobId}::uuid AND aoa_deg=${alpha}`,
      );
      // Large retained metadata exercises the same PG text work as a source
      // manifest. These fixture entries have no artifact or media identity.
      const payload = {
        ...point,
        mesh_recovery_version: 3,
        ...(index === 0 && {
          fixture_metadata: Array.from({ length: 10500 }, (_, n) => ({
            ordinal: n,
            note: "sample metadata ".repeat(40),
            label: `row-${n}`,
          })),
        }),
      };
      const [a] = await db
        .insert(resultAttempts)
        .values({
          resultId: String(cell.id),
          bcId: String(cell.bc_id),
          airfoilId: String(job.airfoil_id),
          simulationPresetRevisionId: String(job.simulation_preset_revision_id),
          simJobId: jobId,
          engineJobId: String(job.engine_job_id),
          solverImplementationId: String(job.solver_implementation_id),
          engineCaseSlug: point.case_slug,
          aoaDeg: alpha,
          status: "done",
          source: "solved",
          regime: "urans",
          unsteady: point.unsteady,
          converged: point.converged,
          cl: point.cl,
          cd: point.cd,
          cm: point.cm,
          validForPolar: false,
          evidencePayload: payload,
        })
        .returning({ id: resultAttempts.id });
      if (point.frame_track)
        await db.execute(
          sql`UPDATE result_attempts SET evidence_payload=jsonb_set(evidence_payload,'{frame_track,frames,0,cl}','0.810000'::jsonb) WHERE id=${a.id}::uuid`,
        );
      await db.insert(solverEvidenceArtifacts).values({
        resultId: String(cell.id),
        resultAttemptId: a.id,
        airfoilId: String(job.airfoil_id),
        simJobId: jobId,
        engineJobId: String(job.engine_job_id),
        engineCaseSlug: point.case_slug,
        solverImplementationId: String(job.solver_implementation_id),
        kind: "manifest",
        storageKey: `test/${a.id}/evidence_manifest.json`,
        mimeType: "application/json",
        byteSize: 42,
        sha256: analysisContentHash({ id: a.id, point }),
      });
      const raw = await createVerifiedRestartArchiveFixture(db, {
        resultId: String(cell.id),
        resultAttemptId: a.id,
        backend: "gcs",
        compression: "zstd",
      });
      const mediaPath = join(dir, a.id + ".png");
      await writeFile(mediaPath, image);
      await db.insert(resultMedia).values({
        resultId: String(cell.id),
        resultAttemptId: a.id,
        role: "instantaneous",
        kind: "image",
        field: "pressure",
        storageKey: mediaPath,
        mimeType: "image/png",
        width: 1,
        height: 1,
      });
      await db.insert(forceHistory).values({
        resultId: String(cell.id),
        resultAttemptId: a.id,
        t: point.force_history!.t,
        cl: point.force_history!.cl,
        cd: point.force_history!.cd,
        cm: point.force_history!.cm,
      });
      const reduced = await stageArchiveResultInterpretation({
        db,
        resultId: String(cell.id),
        resultAttemptId: a.id,
        sourceArchiveId: raw.archiveId,
        inputEvidenceSignature: analysisContentHash({
          source: raw.archiveId,
          history: point.force_history,
          frames: point.frame_track,
          cycles: point.urans_cycle_certificate,
        }),
        point,
        fidelity,
        diagnostics: { unsteadyEvidence: true },
      });
      expect(reduced.state).toBe(
        index === 1 ? "continuation_required" : "accepted",
      );
      if (index === 2) expect(reduced.regime).toBe("steady_equivalent");
      points.push({
        id: a.id,
        cell: String(cell.id),
        raw: raw.archiveId,
        interpretation: reduced.id,
      });
    }
    expect(
      await recordProgressiveCfdEvidence(db, {
        simJobId: jobId,
        engineJobId: String(job.engine_job_id),
        resultAttemptIds: points.map((x) => x.id),
      }),
    ).toMatchObject({ linked: 3 });
    await db.execute(
      sql`UPDATE sim_jobs SET status='done',engine_state='completed',"ingestedAt"=now(),"finishedAt"=now() WHERE id=${jobId}::uuid`,
    );
    await db.execute(
      sql`UPDATE progressive_cfd_attempts SET outcome='complete',finished_at=now() WHERE sim_job_id=${jobId}::uuid`,
    );
    await db.execute(sql`UPDATE progressive_cfd_units SET state='complete', lease_token=NULL,lease_owner=NULL,lease_until=NULL
      WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${jobId}::uuid)`);
    await db.execute(
      sql`UPDATE results SET status='failed',current_result_attempt_id=NULL WHERE sim_job_id=${jobId}::uuid`,
    );
    const [chosen, refused, steadyEquivalent] = points;
    const select = (conn: DB, p: typeof chosen) =>
      selectAcceptedArchiveInterpretation({
        db: conn,
        resultId: p.cell,
        resultAttemptId: p.id,
        interpretationId: p.interpretation,
        sourceArchiveId: p.raw,
        backfillRunId: String(run.id),
      });
    const resultState = async (conn: DB) => [
      ...(await conn.execute(sql`SELECT r.id,r.current_result_attempt_id,r.current_result_interpretation_id,
      r.status,r.regime,r.cl,r.cd,r.cm,r.fidelity,r.frame_track::text AS frame,r.steady_history::text AS steady,
      s.selection_namespace FROM results r LEFT JOIN result_canonical_selections s ON s.id=r.current_canonical_selection_id
      WHERE r.sim_job_id=${jobId}::uuid ORDER BY r.id`)),
    ];
    const scientific = async () => {
      const data =
        await db.execute(sql`SELECT a.id,a.valid_for_polar,a.converged,a.stalled,cf.evidence_signature,
        i.id AS interpretation,i.state,i.regime,i.selected_window,i.statistics,i.diagnostics,
        cy.cycle_index,cy.start_time_s,cy.end_time_s,cy.disposition,cy.coefficient_sample_count,cy.field_frame_count,cy.metrics,
        m.id AS media_id,m.storage_key,h.t,h.cl,h.cd,h.cm,ar.id AS raw_archive,ar.blob_id
        FROM result_attempts a JOIN progressive_cfd_evidence cf ON cf.result_attempt_id=a.id
        JOIN result_interpretations i ON i.result_attempt_id=a.id LEFT JOIN result_interpretation_cycles cy ON cy.result_interpretation_id=i.id
        JOIN result_media m ON m.result_attempt_id=a.id JOIN force_history h ON h.result_attempt_id=a.id
        JOIN solver_evidence_archives ar ON ar.id=i.source_archive_id WHERE a.sim_job_id=${jobId}::uuid ORDER BY a.id,cy.cycle_index`);
      expect(data).toHaveLength(periods * 2 + 1);
      expect(data.filter((r) => r.id === steadyEquivalent.id)).toMatchObject([
        { state: "accepted", regime: "steady_equivalent", cycle_index: null },
      ]);
      expect(data.filter((r) => r.disposition === "selected")).toHaveLength(
        periods,
      );
      expect(
        data
          .filter((r) => r.cycle_index !== null)
          .every(
            (r) =>
              r.field_frame_count === 24 && r.coefficient_sample_count === 80,
          ),
      ).toBe(true);
      const e = await readPolarAttemptEvidenceForConsumerProof(
        db,
        String(job.airfoil_id),
        String(job.simulation_preset_revision_id),
        jobId,
      );
      const classified = classifyPolarEvidence(e);
      return {
        ledger: analysisContentHash([...data]),
        media: await Promise.all(
          points.map(async (p) =>
            createHash("sha256")
              .update(await readFile(join(dir, p.id + ".png")))
              .digest("hex"),
          ),
        ),
        classes: classified.classifications.map((c) => [
          c.state,
          c.reasons,
          c.confidence,
        ]),
        fit: buildPolarFit(classified.classifications),
      };
    };
    const before = await scientific();
    let hot: Awaited<ReturnType<typeof resultState>> | undefined;
    const rollback = new Error("restore pointerless fixture");
    await expect(
      db.transaction(async (tx) => {
        const conn = tx as unknown as DB;
        expect(await select(conn, refused)).toBe("not_eligible");
        expect(await select(conn, chosen)).toBe("selected");
        expect(await select(conn, steadyEquivalent)).toBe("selected");
        hot = await resultState(conn);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const deps = {
      ...(await configuredAttemptEvidenceSettlementDependencies(db)),
      store,
    };
    await setAttemptEvidenceStoragePolicy(db, {
      enabled: true,
      consumerContractVersion: 1,
      receiptBearing: true,
    });
    const rows = [];
    for (const p of points) {
      const original = await readStoredAttemptEvidenceText(db, p.id);
      const { archive } = await archiveAttemptEvidence(db, store, {
        attemptId: p.id,
        sourceInstance: "fixture",
        bucket: "fixture",
      });
      if (p === chosen) {
        const [oldScope] = await db.execute(
          sql`SELECT attempt_evidence_shortening_limiter(${p.id}::uuid,${archive.id}::uuid) AS reason`,
        );
        expect(oldScope.reason).toBe(
          "missing-exact-settled-progressive-receipt",
        );
        await setAttemptEvidenceStoragePolicy(db, {
          enabled: true,
          consumerContractVersion: 1,
          receiptUrans: true,
        });
        expect(archive.sourceByteSize).toBeGreaterThan(6 * 1024 * 1024);
        expect(
          (
            await db.execute(
              sql`SELECT attempt_evidence_urans_shortening_limiter(${p.id}::uuid,${archive.id}::uuid) AS reason`,
            )
          )[0].reason,
        ).toBe("source-byte-limit");
        await setAttemptEvidenceStoragePolicy(db, {
          enabled: true,
          consumerContractVersion: 1,
          receiptUrans: true,
          uransMaxSourceBytes: 8 * 1024 * 1024,
        });
        const [semantics] =
          await db.execute(sql`SELECT attempt_evidence_normalized_value(evidence_payload)::text=
          result_history_normalized(evidence_payload)::text AS identical FROM result_attempts WHERE id=${p.id}::uuid`);
        expect(semantics.identical).toBe(true);
      }
      if (p === refused) {
        const foreign = {
          ...deps,
          verifyDependencies: async (
            input: Parameters<typeof deps.verifyDependencies>[0],
          ) => ({
            ...(await deps.verifyDependencies(input)),
            verifier: "server-consumers/receipt-bearing-rans-v1",
          }),
        };
        await expect(
          settleAttemptEvidenceHistory(db, foreign, {
            attemptId: p.id,
            archiveId: archive.id,
          }),
        ).rejects.toThrow(/proof/i);
        expect(await readStoredAttemptEvidenceText(db, p.id)).toBe(original);
      }
      const out = await settleAttemptEvidenceHistory(db, deps, {
        attemptId: p.id,
        archiveId: archive.id,
      });
      expect(out.netValueBytesReclaimed).toBeGreaterThan(0);
      expect(await readStoredAttemptEvidenceText(db, p.id)).toBe(original);
      rows.push({ id: p.id, arc: archive.id, original });
    }
    expect(await scientific()).toEqual(before);
    const preliminary = await resultState(db);
    memory.lateError = true;
    await expect(select(db, chosen)).rejects.toThrow(
      /exact attempt history|unavailable|verification/,
    );
    memory.lateError = false;
    expect(await resultState(db)).toEqual(preliminary);
    const raceDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "transaction")
          return async (action: Parameters<DB["transaction"]>[0]) => {
            const saved = rows[0]!;
            await restoreAttemptEvidence(
              db,
              saved.id,
              saved.arc,
              saved.original,
              "fixture concurrent restore",
            );
            await settleAttemptEvidenceHistory(db, deps, {
              attemptId: saved.id,
              archiveId: saved.arc,
            });
            writing = true;
            try {
              return await db.transaction(action);
            } finally {
              writing = false;
            }
          };
        return Reflect.get(target, key, receiver);
      },
    });
    await expect(select(raceDb, chosen)).rejects.toThrow(
      /changed during archive interpretation/,
    );
    expect(await resultState(db)).toEqual(preliminary);
    const checked = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "transaction")
          return async (action: Parameters<DB["transaction"]>[0]) => {
            writing = true;
            try {
              return await db.transaction(action);
            } finally {
              writing = false;
            }
          };
        return Reflect.get(target, key, receiver);
      },
    });
    expect(await select(checked, refused)).toBe("not_eligible");
    expect(await select(checked, chosen)).toBe("selected");
    expect(await select(checked, steadyEquivalent)).toBe("selected");
    expect(await select(checked, chosen)).toBe("already_selected");
    expect(await resultState(db)).toEqual(hot);
    expect(
      (await resultState(db)).find((r) => r.id === chosen.cell)!.frame,
    ).toContain("0.810000");
    expect(await scientific()).toEqual(before);
    expect(
      (
        await db.execute(
          sql`SELECT count(*)::int n FROM result_canonical_selections WHERE result_id=${chosen.cell}::uuid`,
        )
      )[0].n,
    ).toBe(1);
  } finally {
    spy.mockRestore();
    env.evidenceBucket = oldBucket;
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
    await setAttemptEvidenceStoragePolicy(db, { enabled: false });
  }
}
