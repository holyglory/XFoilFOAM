import { randomUUID } from "node:crypto";
import { progressiveSolverIsTransient } from "@aerodb/core";
import { eq, sql } from "drizzle-orm";
import {
  airfoils,
  canonicalAnalysisJson,
  lockProgressiveCfdExecution,
  materializeProgressiveCfdExecution,
  progressiveCfdAttempts,
  simJobs,
  type DB,
  type ProgressiveCfdLease,
} from "@aerodb/db";
import {
  validateProgressiveExecutionScope,
  type PolarRequest,
} from "@aerodb/engine-client";
import {
  admissionCpuSlotsForRequest,
  buildPolarRequest,
  solverImplementationIdForSetup,
} from "./build-request";
import { claimAoas } from "./claim";
import { requireExecutionPoolForSetup } from "./engine-pool";

export async function composeProgressiveCfdJob(
  db: DB,
  leases: ProgressiveCfdLease[],
  input: {
    cpuSlots: number;
    meshRecoveryVersion: number;
    solverBudgetVersion?: number | null;
  },
): Promise<{ jobId: string; request: PolarRequest; replayed: boolean }> {
  if (
    !leases.length ||
    leases.length > 512 ||
    !Number.isInteger(input.cpuSlots) ||
    input.cpuSlots < 1 ||
    !Number.isInteger(input.meshRecoveryVersion) ||
    input.meshRecoveryVersion < 0
  )
    throw new Error("Invalid CFD batch composition");
  const first = leases[0];
  if (input.solverBudgetVersion !== 2)
    throw new Error(
      "Progressive CFD composition requires a known solver-budget capability",
    );
  const mixedBudgets = leases.some(
    (lease) => lease.remainingActiveSeconds !== first.remainingActiveSeconds,
  );
  if (
    leases.some(
      (lease) =>
        !Number.isFinite(lease.remainingActiveSeconds) ||
        lease.remainingActiveSeconds <= 0 ||
        lease.remainingActiveSeconds > 43200,
    )
  )
    throw new Error("CFD batch requires finite positive case allocations");
  if (
    new Set(leases.map((lease) => lease.id)).size !== leases.length ||
    new Set(leases.map((lease) => lease.alpha)).size !== leases.length ||
    leases.some(
      (lease) =>
        lease.targetId !== first.targetId ||
        lease.generationId !== first.generationId ||
        lease.stage !== first.stage ||
        lease.revisionId !== first.revisionId ||
        (lease.recoveryParentJobId ?? null) !==
          (first.recoveryParentJobId ?? null) ||
        canonicalAnalysisJson(lease.recipe) !==
          canonicalAnalysisJson(first.recipe),
    )
  )
    throw new Error(
      "CFD batch must share one immutable physical target and numerical recipe",
    );
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    const [state] = await connection.execute(
      sql`SELECT enabled FROM sweeper_state WHERE id = 1 FOR SHARE`,
    );
    if (!state?.enabled) throw new Error("CFD admission is paused");
    const bindings = [];
    for (const lease of [...leases].sort((left, right) =>
      left.id.localeCompare(right.id),
    ))
      bindings.push(await lockProgressiveCfdExecution(connection, lease));
    const jobs = new Set(
      bindings.map((binding) => binding.sim_job_id).filter(Boolean),
    );
    if (jobs.size) {
      if (jobs.size !== 1 || bindings.some((binding) => !binding.sim_job_id))
        throw new Error("CFD batch contains competing execution ownership");
      const [job] = await connection
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, String([...jobs][0])))
        .limit(1);
      const payload = job?.requestPayload as {
        engineRequest?: PolarRequest;
        progressive?: { tokens?: string[] };
      } | null;
      if (
        !job ||
        !payload?.engineRequest ||
        canonicalAnalysisJson(
          [...(payload.progressive?.tokens ?? [])].sort(),
        ) !== canonicalAnalysisJson(leases.map((lease) => lease.token).sort())
      )
        throw new Error(
          "Stored CFD job scope does not match the requested lease batch",
        );
      return { jobId: job.id, request: payload.engineRequest, replayed: true };
    }
    const execution = await materializeProgressiveCfdExecution(
      connection,
      first,
    );
    const pool = await requireExecutionPoolForSetup(
      connection,
      execution.snapshot,
    );
    const [airfoil] = await connection
      .select()
      .from(airfoils)
      .where(eq(airfoils.id, first.physical.airfoilId))
      .limit(1);
    if (!airfoil || airfoil.archivedAt || airfoil.deletedAt)
      throw new Error("CFD profile is missing or inactive");
    const transient = progressiveSolverIsTransient(
      execution.snapshot.solver.flowSolverFamily!,
      execution.snapshot.solver.timeCoordinate,
    );
    const angles = leases
      .map((lease) => lease.alpha)
      .sort((left, right) => left - right);
    const fidelity =
      first.recipe.uransFidelity ?? (first.stage === 2 ? "precalc" : "full");
    if (fidelity !== "precalc" && fidelity !== "full")
      throw new Error("CFD recipe has an unsupported URANS fidelity");
    const { request, speed } = buildPolarRequest({
      airfoil: {
        ...airfoil,
        points: first.physical.geometry.map(([coordinateX, coordinateY]) => ({
          x: coordinateX,
          y: coordinateY,
        })),
      },
      setup: execution.snapshot,
      aoaList: angles,
      wave: transient ? 2 : 1,
      uransFidelity: fidelity,
      ransFailurePolicy:
        !transient && angles.length > 1 ? "abort_for_precalc" : "continue",
      cpuSlots: input.cpuSlots,
    });
    request.expected_execution_pool = pool.routingKey;
    request.expected_mesh_recovery_version = input.meshRecoveryVersion;
    request.solver = { ...request.solver, warm_start: true };
    request.resources = {
      ...request.resources,
      case_concurrency: 1,
      ...(mixedBudgets
        ? {
            case_solver_allocations: leases
              .map((lease) => ({
                chord: execution.snapshot.referenceGeometry.referenceLengthM,
                speed,
                aoa_deg: lease.alpha,
                limit_seconds: lease.remainingActiveSeconds,
              }))
              .sort((left, right) => left.aoa_deg - right.aoa_deg),
          }
        : { case_solver_budget_seconds: first.remainingActiveSeconds }),
    };
    if (input.solverBudgetVersion === 2)
      request.expected_solver_budget_version = 2;
    const jobId = randomUUID();
    request.execution_id = jobId;
    const progressive = validateProgressiveExecutionScope(request, {
      executionContract: "progressive-cfd-v1",
      executionId: jobId,
      epochId: first.epochId,
      generationId: first.generationId,
      targetId: first.targetId,
      stage: first.stage,
      recipeId: execution.recipeId,
      tokens: leases.map((lease) => lease.token),
      units: leases.map((lease) => ({
        unitId: lease.id,
        alpha: lease.alpha,
        token: lease.token,
        activeBudgetSeconds: lease.remainingActiveSeconds,
      })),
    });
    const boundaryId = execution.snapshot.preset.legacyBoundaryConditionId!;
    await connection.insert(simJobs).values({
      id: jobId,
      airfoilId: airfoil.id,
      bcIds: [boundaryId],
      simulationPresetRevisionId: execution.revision.id,
      solverImplementationId: solverImplementationIdForSetup(
        execution.snapshot,
      ),
      solverExecutionPoolId: pool.id,
      methodKey: transient ? "openfoam.urans" : "openfoam.rans",
      campaignId: first.campaignId,
      parentJobId: first.recoveryParentJobId ?? null,
      jobKind: angles.length > 1 ? "sweep" : "targeted",
      referenceChordM: execution.snapshot.referenceGeometry.referenceLengthM,
      wave: transient ? 2 : 1,
      status: "pending",
      admissionCpuSlots: admissionCpuSlotsForRequest(request),
      totalCases: angles.length,
      requestPayload: {
        speedMap: [
          {
            speed,
            bcId: boundaryId,
            presetRevisionId: execution.revision.id,
            mach: execution.snapshot.flowState.mach,
          },
        ],
        aoas: angles,
        resources: request.resources,
        setupSnapshot: execution.snapshot,
        meshRecoveryVersion: input.meshRecoveryVersion,
        engineRequest: request,
        progressive,
      },
    });
    const claimed = await claimAoas(
      connection,
      airfoil.id,
      boundaryId,
      execution.revision.id,
      angles,
      jobId,
    );
    if (
      canonicalAnalysisJson(
        [...claimed].sort((left, right) => left - right),
      ) !== canonicalAnalysisJson(angles)
    )
      throw new Error(
        "CFD evidence cells already have another execution owner",
      );
    for (const lease of leases)
      await connection
        .update(progressiveCfdAttempts)
        .set({ executionRecipeId: execution.recipeId, simJobId: jobId })
        .where(eq(progressiveCfdAttempts.token, lease.token));
    return { jobId, request, replayed: false };
  });
}
