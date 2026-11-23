import { type DB, resultAttempts, resultClassifications } from "@aerodb/db";

export const stageCoefficients = {
  fast: { cl: 0.44, cd: 0.017, cm: -0.02, fidelity: "urans_precalc" },
  final: { cl: 0.45, cd: 0.018, cm: -0.021, fidelity: "urans_full" },
} as const;

/** The two immutable test attempts in campaigns.test.ts share the same physical cell and result. */
export async function insertCampaignStageAttempt(
  db: DB,
  cell: { resultId: string; airfoilId: string; bcId: string; simulationPresetRevisionId: string; aoaDeg: number },
  stage: keyof typeof stageCoefficients,
  simJobId: string,
  engineJobId: string,
) {
  const { fidelity, ...coefficients } = stageCoefficients[stage];
  const [attempt] = await db.insert(resultAttempts).values({
    ...cell, ...coefficients, simJobId, engineJobId, engineCaseSlug: "aoa_4.00",
    status: "done", source: "solved", regime: "urans", validForPolar: true,
    converged: true, unsteady: true, evidencePayload: { fidelity }, solvedAt: new Date(),
  }).returning({ id: resultAttempts.id });
  const [classification] = await db.insert(resultClassifications).values({
    resultAttemptId: attempt.id, airfoilId: cell.airfoilId,
    simulationPresetRevisionId: cell.simulationPresetRevisionId, aoaDeg: cell.aoaDeg,
    regime: "urans", state: "accepted", reasons: [],
    classifierVersion: stage === "fast" ? "authoritative-preliminary-flow-fast-v1" : "authoritative-preliminary-flow-verify-v1",
  }).returning({ id: resultClassifications.id });
  return { attempt, classification };
}
