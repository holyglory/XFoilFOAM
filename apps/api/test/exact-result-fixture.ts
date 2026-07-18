import {
  type DB,
  forceHistory,
  resultAttempts,
  resultMedia,
  results,
  simulationPresetRevisions,
  solverEvidenceArtifacts,
} from "@aerodb/db";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";

let generation = 0;

export type ExactFixturePublication =
  | "selected-eligible"
  | "historical-rejected"
  | "legacy-selected-reclassified";

/**
 * Test-only exact-owner adapter for results assembled directly in SQL instead
 * of passing through sweeper ingestion. Public evidence readers deliberately
 * refuse mutable projection-only rows after migration 0053, so integration
 * fixtures must bind their existing force/media/artifact rows to one immutable
 * attempt. This is NOT a production publication path and never invents solver
 * coefficients or media. When a fixture explicitly asks to model a selected
 * generation, the helper does create one deterministic test-only manifest
 * association if the fixture did not supply one; exact publication now
 * requires that sole owner-valid manifest before the classifier can expose the
 * selected coefficients. The real classifier still decides the verdict.
 *
 * Publication intent is mandatory so a rejected fixture cannot become current
 * through permissive status/source inference:
 * - selected-eligible: fixture-authored accepted/provisional evidence;
 * - historical-rejected: retained attempt history, pointer unchanged;
 * - legacy-selected-reclassified: a generation selected under an older gate
 *   and subsequently rejected by a stricter classifier. This models legacy
 *   repair state only; fresh production ingestion must never do this.
 */
export async function createExactResultAttemptFixture(
  db: DB,
  resultId: string,
  opts: {
    publication: ExactFixturePublication;
    evidencePayload?: Record<string, unknown>;
  },
): Promise<string> {
  const [result] = await db
    .select()
    .from(results)
    .where(eq(results.id, resultId))
    .limit(1);
  if (!result) throw new Error(`test result ${resultId} does not exist`);
  const [revision] = result.simulationPresetRevisionId
    ? await db
        .select({
          solverImplementationId:
            simulationPresetRevisions.solverImplementationId,
        })
        .from(simulationPresetRevisions)
        .where(
          eq(simulationPresetRevisions.id, result.simulationPresetRevisionId),
        )
        .limit(1)
    : [];

  const [history] = await db
    .select()
    .from(forceHistory)
    .where(
      and(
        eq(forceHistory.resultId, resultId),
        isNull(forceHistory.resultAttemptId),
      ),
    )
    .limit(1);
  const evidencePayload: Record<string, unknown> = {
    ...(result.fidelity ? { fidelity: result.fidelity } : {}),
    ...(result.frameTrack != null ? { frame_track: result.frameTrack } : {}),
    ...(result.steadyHistory != null
      ? { steady_history: result.steadyHistory }
      : {}),
    ...(history
      ? {
          force_history: {
            t: history.t,
            cl: history.cl,
            cd: history.cd,
            cm: history.cm,
            cl_mean: history.clMean,
            cl_rms: history.clRms,
            cd_mean: history.cdMean,
            cd_rms: history.cdRms,
            strouhal: history.strouhal,
            shedding_freq_hz: history.sheddingFreqHz,
            samples: history.sampleCount,
          },
        }
      : {}),
    ...(opts.evidencePayload ?? {}),
  };
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId: result.airfoilId,
      bcId: result.bcId,
      simulationPresetRevisionId: result.simulationPresetRevisionId,
      aoaDeg: result.aoaDeg,
      simJobId: result.simJobId,
      engineJobId:
        result.engineJobId ??
        `test-exact:${result.id}:${Date.now()}:${generation++}`,
      engineCaseSlug:
        result.engineCaseSlug ??
        `aoa-${String(result.aoaDeg).replace("-", "m")}`,
      methodKey: result.methodKey,
      solverImplementationId:
        result.solverImplementationId ??
        revision?.solverImplementationId ??
        null,
      status: result.status,
      source: result.source,
      regime: result.regime,
      validForPolar: opts.publication === "selected-eligible",
      cl: result.cl,
      cd: result.cd,
      cm: result.cm,
      clCd: result.clCd,
      clStd: result.clStd,
      cdStd: result.cdStd,
      cmStd: result.cmStd,
      stalled: result.stalled,
      unsteady: result.unsteady,
      converged: result.converged,
      finalResidual: result.finalResidual,
      iterations: result.iterations,
      yPlusAvg: result.yPlusAvg,
      yPlusMax: result.yPlusMax,
      nCells: result.nCells,
      firstOrderFallback: result.firstOrderFallback,
      strouhal: result.strouhal,
      error: result.error,
      qualityWarnings: result.qualityWarnings,
      evidencePayload,
      solvedAt: result.solvedAt,
    })
    .returning({
      id: resultAttempts.id,
      simJobId: resultAttempts.simJobId,
      engineJobId: resultAttempts.engineJobId,
      engineCaseSlug: resultAttempts.engineCaseSlug,
      aoaDeg: resultAttempts.aoaDeg,
    });

  await db
    .update(forceHistory)
    .set({ resultAttemptId: attempt.id })
    .where(
      and(
        eq(forceHistory.resultId, resultId),
        isNull(forceHistory.resultAttemptId),
      ),
    );
  await db
    .update(resultMedia)
    .set({ resultAttemptId: attempt.id })
    .where(
      and(
        eq(resultMedia.resultId, resultId),
        isNull(resultMedia.resultAttemptId),
      ),
    );
  await db
    .update(solverEvidenceArtifacts)
    .set({ resultAttemptId: attempt.id })
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, resultId),
        isNull(solverEvidenceArtifacts.resultAttemptId),
      ),
    );
  if (opts.publication !== "historical-rejected") {
    const manifests = await db
      .select({ id: solverEvidenceArtifacts.id })
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, resultId),
          eq(solverEvidenceArtifacts.resultAttemptId, attempt.id),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      );
    if (manifests.length > 1) {
      throw new Error(
        `selected test attempt ${attempt.id} has ambiguous manifest evidence`,
      );
    }
    if (manifests.length === 0) {
      const manifestPayload = JSON.stringify({
        fixture: "exact-result-attempt",
        resultId,
        resultAttemptId: attempt.id,
      });
      await db.insert(solverEvidenceArtifacts).values({
        resultId,
        resultAttemptId: attempt.id,
        airfoilId: result.airfoilId,
        simJobId: attempt.simJobId,
        engineJobId: attempt.engineJobId,
        engineCaseSlug: attempt.engineCaseSlug,
        aoaDeg: attempt.aoaDeg,
        kind: "manifest",
        storageKey: `test-fixtures/${result.id}/${attempt.id}/manifest.json`,
        mimeType: "application/json",
        sha256: createHash("sha256").update(manifestPayload).digest("hex"),
        byteSize: Buffer.byteLength(manifestPayload),
        metadata: { fixture: "exact-result-attempt" },
      });
    }
  }
  if (opts.publication !== "historical-rejected") {
    await db
      .update(results)
      .set({ currentResultAttemptId: attempt.id })
      .where(eq(results.id, resultId));
  }
  return attempt.id;
}
