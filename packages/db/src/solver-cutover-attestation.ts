import { and, eq, sql } from "drizzle-orm";

import { CampaignError } from "./campaigns";
import type { DB } from "./client";
import {
  solverCutoverContinuationChecks,
  solverEngineCanaryAttestations,
  solverExecutionPools,
  solverRuntimeBuilds,
  simCampaignSolverCutovers,
} from "./schema";
import {
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
} from "./solver-implementations";

export interface PersistOpenCfd2606CanaryAttestationInput {
  solverRuntimeBuildId: string;
  receiptSha256: string;
  receipt: Record<string, unknown>;
  actor?: string | null;
}

export interface OpenCfd2606CanaryAttestation {
  id: string;
  solverImplementationId: string;
  solverRuntimeBuildId: string;
  solverExecutionPoolId: string;
  receiptSha256: string;
  receipt: Record<string, unknown>;
  attestedBy: string | null;
  createdAt: Date;
  runtime: {
    buildId: string;
    sourceRevision: string | null;
    imageDigest: string | null;
    applicationSourceSha256: string | null;
    packageSha256: string | null;
    binarySha256: string | null;
    architecture: string | null;
  };
}

export interface OpenCfd2606ContinuationStatus {
  canaryAttestationId: string;
  status: "pending" | "routed" | "evidence" | "not_required";
  simJobId: string | null;
  evidenceResultId: string | null;
  checkedAt: string;
  lastError: string | null;
  requiredCampaigns: number;
  campaigns: Array<{
    campaignId: string;
    cutoverId: string;
    status: "pending" | "routed" | "evidence";
    simJobId: string | null;
    evidenceResultId: string | null;
    lastError: string | null;
  }>;
}

/** Fetches and validates the relational ownership of an attestation. This is
 * also the direct-DB guard used by cutover finalization; an API caller cannot
 * bypass the canary endpoint by supplying an arbitrary UUID. */
export async function getOpenCfd2606CanaryAttestation(
  db: DB,
  id: string,
  options: { requireEnabledPool?: boolean } = {},
): Promise<OpenCfd2606CanaryAttestation> {
  const [row] = await db
    .select({
      id: solverEngineCanaryAttestations.id,
      solverImplementationId:
        solverEngineCanaryAttestations.solverImplementationId,
      solverRuntimeBuildId: solverEngineCanaryAttestations.solverRuntimeBuildId,
      solverExecutionPoolId:
        solverEngineCanaryAttestations.solverExecutionPoolId,
      receiptSha256: solverEngineCanaryAttestations.receiptSha256,
      receipt: solverEngineCanaryAttestations.receipt,
      attestedBy: solverEngineCanaryAttestations.attestedBy,
      createdAt: solverEngineCanaryAttestations.createdAt,
      poolEnabled: solverExecutionPools.enabled,
      poolImplementationId: solverExecutionPools.solverImplementationId,
      runtimeImplementationId: solverRuntimeBuilds.solverImplementationId,
      buildId: solverRuntimeBuilds.buildId,
      sourceRevision: solverRuntimeBuilds.sourceRevision,
      imageDigest: solverRuntimeBuilds.imageDigest,
      applicationSourceSha256: solverRuntimeBuilds.applicationSourceSha256,
      packageSha256: solverRuntimeBuilds.packageSha256,
      binarySha256: solverRuntimeBuilds.binarySha256,
      architecture: solverRuntimeBuilds.architecture,
    })
    .from(solverEngineCanaryAttestations)
    .innerJoin(
      solverExecutionPools,
      eq(
        solverExecutionPools.id,
        solverEngineCanaryAttestations.solverExecutionPoolId,
      ),
    )
    .innerJoin(
      solverRuntimeBuilds,
      eq(
        solverRuntimeBuilds.id,
        solverEngineCanaryAttestations.solverRuntimeBuildId,
      ),
    )
    .where(eq(solverEngineCanaryAttestations.id, id))
    .limit(1);
  if (!row) {
    throw new CampaignError(
      "validation",
      "a successful OpenCFD 2606 canary attestation is required",
    );
  }
  if (
    row.solverImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
    row.runtimeImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
    row.poolImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
    row.solverExecutionPoolId !== OPENCFD_2606_EXECUTION_POOL_ID
  ) {
    throw new CampaignError(
      "conflict",
      "canary attestation does not belong to the exact OpenCFD 2606 implementation and pool",
    );
  }
  if (options.requireEnabledPool && !row.poolEnabled) {
    throw new CampaignError(
      "invalid_state",
      "the attested OpenCFD 2606 execution pool is no longer enabled",
    );
  }
  return {
    id: row.id,
    solverImplementationId: row.solverImplementationId,
    solverRuntimeBuildId: row.solverRuntimeBuildId,
    solverExecutionPoolId: row.solverExecutionPoolId,
    receiptSha256: row.receiptSha256,
    receipt: row.receipt,
    attestedBy: row.attestedBy,
    createdAt: row.createdAt,
    runtime: {
      buildId: row.buildId,
      sourceRevision: row.sourceRevision,
      imageDigest: row.imageDigest,
      applicationSourceSha256: row.applicationSourceSha256,
      packageSha256: row.packageSha256,
      binarySha256: row.binarySha256,
      architecture: row.architecture,
    },
  };
}

/** Inserts one immutable attestation, or returns the exact prior row for a
 * replay of the same canonical receipt. Runtime/pool ownership is checked
 * before and after conflict handling. */
export async function persistOpenCfd2606CanaryAttestation(
  db: DB,
  input: PersistOpenCfd2606CanaryAttestationInput,
): Promise<OpenCfd2606CanaryAttestation & { replayed: boolean }> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [pool] = await tx
      .select({
        id: solverExecutionPools.id,
        enabled: solverExecutionPools.enabled,
        solverImplementationId: solverExecutionPools.solverImplementationId,
      })
      .from(solverExecutionPools)
      .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID))
      .for("update")
      .limit(1);
    const [runtime] = await tx
      .select({ id: solverRuntimeBuilds.id })
      .from(solverRuntimeBuilds)
      .where(
        and(
          eq(solverRuntimeBuilds.id, input.solverRuntimeBuildId),
          eq(
            solverRuntimeBuilds.solverImplementationId,
            OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          ),
        ),
      )
      .limit(1);
    if (
      !pool ||
      !pool.enabled ||
      pool.solverImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID
    ) {
      throw new CampaignError(
        "invalid_state",
        "the exact OpenCFD 2606 execution pool must remain enabled while attesting",
      );
    }
    if (!runtime) {
      throw new CampaignError(
        "validation",
        "canary runtime is not registered to OpenCFD 2606",
      );
    }
    const [inserted] = await tx
      .insert(solverEngineCanaryAttestations)
      .values({
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        solverRuntimeBuildId: input.solverRuntimeBuildId,
        solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
        receiptSha256: input.receiptSha256,
        receipt: input.receipt,
        attestedBy: input.actor?.trim() || null,
      })
      .onConflictDoNothing({
        target: solverEngineCanaryAttestations.receiptSha256,
      })
      .returning({ id: solverEngineCanaryAttestations.id });
    const [existing] = inserted
      ? [inserted]
      : await tx
          .select({ id: solverEngineCanaryAttestations.id })
          .from(solverEngineCanaryAttestations)
          .where(
            eq(
              solverEngineCanaryAttestations.receiptSha256,
              input.receiptSha256,
            ),
          )
          .limit(1);
    if (!existing) {
      throw new Error("failed to persist OpenCFD 2606 canary attestation");
    }
    const attestation = await getOpenCfd2606CanaryAttestation(tx, existing.id, {
      requireEnabledPool: true,
    });
    if (attestation.solverRuntimeBuildId !== input.solverRuntimeBuildId) {
      throw new CampaignError(
        "conflict",
        "canary receipt replay resolved to a different runtime build",
      );
    }
    return { ...attestation, replayed: !inserted };
  });
}

export async function ensureOpenCfd2606ContinuationCheck(
  db: DB,
  canaryAttestationId: string,
): Promise<void> {
  await db
    .insert(solverCutoverContinuationChecks)
    .values({ canaryAttestationId })
    .onConflictDoNothing({
      target: solverCutoverContinuationChecks.canaryAttestationId,
    });
}

/** Re-reads the database execution path after campaigns resume. A wrong
 * successor route never advances the durable record. Every campaign that was
 * runnable before the cutover must independently submit through the attested
 * route, and evidence is recognized only when a real target-generation point
 * owns a done result/current attempt plus a checksummed manifest artifact. */
export async function inspectOpenCfd2606Continuation(
  db: DB,
  canaryAttestationId: string,
): Promise<OpenCfd2606ContinuationStatus> {
  const attestation = await getOpenCfd2606CanaryAttestation(
    db,
    canaryAttestationId,
  );
  await ensureOpenCfd2606ContinuationCheck(db, canaryAttestationId);
  const [current] = await db
    .select()
    .from(solverCutoverContinuationChecks)
    .where(
      eq(
        solverCutoverContinuationChecks.canaryAttestationId,
        canaryAttestationId,
      ),
    )
    .limit(1);
  if (!current) throw new Error("continuation check disappeared after insert");
  const checkedAt = new Date();
  const completedCutovers = await db
    .select({
      id: simCampaignSolverCutovers.id,
      campaignId: simCampaignSolverCutovers.campaignId,
      targetGeneration: simCampaignSolverCutovers.targetGeneration,
      targetPointCount: simCampaignSolverCutovers.targetPointCount,
      completedAt: simCampaignSolverCutovers.completedAt,
      priorCampaignStatus: simCampaignSolverCutovers.priorCampaignStatus,
    })
    .from(simCampaignSolverCutovers)
    .where(
      and(
        eq(simCampaignSolverCutovers.canaryAttestationId, canaryAttestationId),
        eq(simCampaignSolverCutovers.status, "completed"),
      ),
    );
  const requiredCutovers = completedCutovers.filter(
    (cutover) =>
      cutover.priorCampaignStatus === "active" ||
      cutover.priorCampaignStatus === "attention",
  );
  requiredCutovers.sort((left, right) =>
    left.campaignId.localeCompare(right.campaignId),
  );

  if (completedCutovers.length === 0) {
    await db
      .update(solverCutoverContinuationChecks)
      .set({ checkedAt, lastError: null })
      .where(eq(solverCutoverContinuationChecks.id, current.id));
    return {
      canaryAttestationId,
      status: current.status as OpenCfd2606ContinuationStatus["status"],
      simJobId: current.simJobId,
      evidenceResultId: current.evidenceResultId,
      checkedAt: checkedAt.toISOString(),
      lastError: null,
      requiredCampaigns: 0,
      campaigns: [],
    };
  }

  if (requiredCutovers.length === 0) {
    if (current.status !== "pending" && current.status !== "not_required") {
      throw new CampaignError(
        "conflict",
        "continuation already recorded runnable campaign work and cannot become not-required",
      );
    }
    await db
      .update(solverCutoverContinuationChecks)
      .set({ status: "not_required", checkedAt, lastError: null })
      .where(eq(solverCutoverContinuationChecks.id, current.id));
    return {
      canaryAttestationId,
      status: "not_required",
      simJobId: null,
      evidenceResultId: null,
      checkedAt: checkedAt.toISOString(),
      lastError: null,
      requiredCampaigns: 0,
      campaigns: [],
    };
  }

  type Candidate = {
    id: string;
    evidence_result_id: string | null;
    submitted_at: Date;
  };
  const campaignProofs: OpenCfd2606ContinuationStatus["campaigns"] = [];
  const candidatesByCampaign = new Map<string, Candidate[]>();

  for (const cutover of requiredCutovers) {
    if (!cutover.completedAt) {
      throw new Error(`completed cutover ${cutover.id} lacks completedAt`);
    }
    const completedAtIso = cutover.completedAt.toISOString();
    const [coverage] = (await db.execute(sql`
      WITH expected_cells AS (
        SELECT source_condition_id, target_condition_id, airfoil_id, aoa_deg,
               target_revision_id
          FROM sim_campaign_solver_cutover_points
         WHERE cutover_id = ${cutover.id}
           AND campaign_id = ${cutover.campaignId}
      ), target_cells AS (
        SELECT condition.supersedes_condition_id AS source_condition_id,
               condition.id AS target_condition_id,
               point.airfoil_id, point.aoa_deg, point.revision_id
          FROM sim_campaign_points point
          JOIN sim_campaign_conditions condition
            ON condition.id = point.condition_id
           AND condition.campaign_id = ${cutover.campaignId}
           AND condition.generation = ${cutover.targetGeneration}
           AND condition.simulation_preset_revision_id = point.revision_id
           AND condition.supersedes_condition_id IS NOT NULL
          JOIN simulation_preset_revisions revision
            ON revision.id = point.revision_id
           AND revision.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
         WHERE point.campaign_id = ${cutover.campaignId}
           AND point.state <> 'released'
      )
      SELECT
        (SELECT count(*)::int FROM expected_cells) AS expected_count,
        (SELECT count(*)::int FROM target_cells) AS target_count,
        (SELECT count(*)::int
           FROM (
             SELECT * FROM expected_cells
             EXCEPT
             SELECT * FROM target_cells
           ) missing
        ) AS missing_count,
        (SELECT count(*)::int
           FROM (
             SELECT * FROM target_cells
             EXCEPT
             SELECT * FROM expected_cells
           ) unexpected
        ) AS unexpected_count
    `)) as unknown as Array<{
      expected_count: number;
      target_count: number;
      missing_count: number;
      unexpected_count: number;
    }>;
    const coverageError =
      !coverage ||
      coverage.expected_count !== cutover.targetPointCount ||
      coverage.target_count !== cutover.targetPointCount ||
      coverage.missing_count !== 0 ||
      coverage.unexpected_count !== 0
        ? `target-generation point coverage is not an exact immutable replay (recorded ${cutover.targetPointCount}, snapshot ${coverage?.expected_count ?? 0}, found ${coverage?.target_count ?? 0}, missing ${coverage?.missing_count ?? 0}, unexpected ${coverage?.unexpected_count ?? 0})`
        : null;
    const candidates = (await db.execute(sql`
      WITH evidence_candidates AS (
        SELECT DISTINCT job.id, result.id AS evidence_result_id,
               job."submittedAt" AS submitted_at, job."createdAt" AS created_at
          FROM sim_campaign_points point
          JOIN sim_campaign_conditions point_condition
            ON point_condition.id = point.condition_id
           AND point_condition.campaign_id = ${cutover.campaignId}
           AND point_condition.generation = ${cutover.targetGeneration}
           AND point_condition.simulation_preset_revision_id = point.revision_id
          JOIN results result
            ON result.id = point.result_id
           AND result.airfoil_id = point.airfoil_id
           AND result.aoa_deg = point.aoa_deg
           AND result.simulation_preset_revision_id = point.revision_id
          JOIN result_attempts attempt
            ON attempt.id = result.current_result_attempt_id
           AND attempt.result_id = result.id
          JOIN sim_jobs job
            ON job.id = result.sim_job_id
           AND job.id = attempt.sim_job_id
           AND job.airfoil_id = result.airfoil_id
           AND job.engine_job_id = result.engine_job_id
           AND job.engine_job_id = attempt.engine_job_id
          JOIN solver_evidence_artifacts artifact
            ON artifact.result_id = result.id
           AND artifact.result_attempt_id = attempt.id
           AND artifact.sim_job_id = job.id
           AND artifact.engine_job_id = job.engine_job_id
           AND artifact.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
           AND result.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
           AND artifact.airfoil_id = result.airfoil_id
           AND artifact.aoa_deg = result.aoa_deg
           AND artifact.kind = 'manifest'
           AND artifact.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           AND artifact.solver_runtime_build_id = ${attestation.solverRuntimeBuildId}
           AND btrim(artifact.storage_key) <> ''
           AND btrim(artifact.mime_type) <> ''
           AND artifact.sha256 ~ '^[0-9a-f]{64}$'
           AND artifact.byte_size > 0
         WHERE point.campaign_id = ${cutover.campaignId}
           AND point.state = 'terminal'
           AND NOT point.derived_by_symmetry
           AND result.status = 'done'
           AND attempt.status = 'done'
           AND result.source = 'solved'
           AND attempt.source = 'solved'
           AND attempt.airfoil_id = result.airfoil_id
           AND attempt.bc_id = result.bc_id
           AND attempt.simulation_preset_revision_id = result.simulation_preset_revision_id
           AND attempt.aoa_deg = result.aoa_deg
           AND result.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           AND result.solver_runtime_build_id = ${attestation.solverRuntimeBuildId}
           AND attempt.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           AND attempt.solver_runtime_build_id = ${attestation.solverRuntimeBuildId}
           AND job."createdAt" >= ${completedAtIso}::timestamptz
           AND job.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           AND job.solver_execution_pool_id = ${OPENCFD_2606_EXECUTION_POOL_ID}
           AND job.solver_runtime_build_id = ${attestation.solverRuntimeBuildId}
           AND job.engine_job_id IS NOT NULL
           AND job."submittedAt" IS NOT NULL
      ), routed_candidates AS (
        SELECT job.id, NULL::uuid AS evidence_result_id,
               job."submittedAt" AS submitted_at, job."createdAt" AS created_at
          FROM sim_jobs job
         WHERE job.campaign_id = ${cutover.campaignId}
           AND job."createdAt" >= ${completedAtIso}::timestamptz
           AND EXISTS (
             SELECT 1
               FROM sim_campaign_conditions condition
              WHERE condition.campaign_id = ${cutover.campaignId}
                AND condition.generation = ${cutover.targetGeneration}
                AND condition.simulation_preset_revision_id = job.simulation_preset_revision_id
           )
           AND job.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           AND job.solver_execution_pool_id = ${OPENCFD_2606_EXECUTION_POOL_ID}
           AND job.solver_runtime_build_id = ${attestation.solverRuntimeBuildId}
           AND job.engine_job_id IS NOT NULL
           AND job."submittedAt" IS NOT NULL
      )
      SELECT id, evidence_result_id, submitted_at
        FROM (
          SELECT * FROM evidence_candidates
          UNION ALL
          SELECT * FROM routed_candidates
        ) candidate
       ORDER BY evidence_result_id DESC NULLS LAST, submitted_at, created_at, id
    `)) as unknown as Candidate[];

    // A cancelled/failed shell with no submission acknowledgement provably
    // never reached the engine (for example a transient pre-acceptance 5xx).
    // Pending/submitted rows can still execute later and therefore poison
    // continuation immediately if their route stamp is absent or wrong.
    const wrongRoutes = (await db.execute(sql`
      SELECT job.id
        FROM sim_jobs job
       WHERE job.campaign_id = ${cutover.campaignId}
         AND job."createdAt" >= ${completedAtIso}::timestamptz
         AND EXISTS (
           SELECT 1
             FROM sim_campaign_conditions condition
            WHERE condition.campaign_id = ${cutover.campaignId}
              AND condition.generation = ${cutover.targetGeneration}
              AND condition.simulation_preset_revision_id = job.simulation_preset_revision_id
         )
         AND NOT (
           job.status IN ('cancelled', 'failed')
           AND job.engine_job_id IS NULL
           AND job."submittedAt" IS NULL
         )
         AND (
           job.solver_implementation_id IS DISTINCT FROM ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
           OR job.solver_execution_pool_id IS DISTINCT FROM ${OPENCFD_2606_EXECUTION_POOL_ID}
         )
       ORDER BY job.id
    `)) as unknown as Array<{ id: string }>;
    const runtimeDefects = (await db.execute(sql`
      SELECT job.id
        FROM sim_jobs job
       WHERE job.campaign_id = ${cutover.campaignId}
         AND job."createdAt" >= ${completedAtIso}::timestamptz
         AND EXISTS (
           SELECT 1
             FROM sim_campaign_conditions condition
            WHERE condition.campaign_id = ${cutover.campaignId}
              AND condition.generation = ${cutover.targetGeneration}
              AND condition.simulation_preset_revision_id = job.simulation_preset_revision_id
         )
         AND NOT (
           job.status IN ('cancelled', 'failed')
           AND job.engine_job_id IS NULL
           AND job."submittedAt" IS NULL
         )
         AND job.solver_implementation_id = ${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}
         AND job.solver_execution_pool_id = ${OPENCFD_2606_EXECUTION_POOL_ID}
         AND job.solver_runtime_build_id IS DISTINCT FROM ${attestation.solverRuntimeBuildId}
       ORDER BY job.id
    `)) as unknown as Array<{ id: string }>;

    candidatesByCampaign.set(cutover.campaignId, candidates);
    const selected = candidates[0];
    const routeIds = wrongRoutes.map((row) => row.id);
    const runtimeIds = runtimeDefects.map((row) => row.id);
    const lastError =
      [
        coverageError,
        routeIds.length
          ? `successor-generation jobs used a non-attested route: ${routeIds.join(", ")}`
          : null,
        runtimeIds.length
          ? `successor-generation jobs used a non-attested runtime: ${runtimeIds.join(", ")}`
          : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join("; ") || null;
    campaignProofs.push({
      campaignId: cutover.campaignId,
      cutoverId: cutover.id,
      status: selected?.evidence_result_id
        ? "evidence"
        : selected
          ? "routed"
          : "pending",
      simJobId: selected?.id ?? null,
      evidenceResultId: selected?.evidence_result_id ?? null,
      lastError,
    });
  }

  const aggregateStatus: "pending" | "routed" | "evidence" =
    campaignProofs.every((proof) => proof.status === "evidence")
      ? "evidence"
      : campaignProofs.every(
            (proof) => proof.status === "routed" || proof.status === "evidence",
          )
        ? "routed"
        : "pending";
  let lastError =
    campaignProofs
      .filter((proof) => proof.lastError)
      .map((proof) => `campaign ${proof.campaignId}: ${proof.lastError}`)
      .join("; ") || null;
  let status = current.status as OpenCfd2606ContinuationStatus["status"];
  let simJobId = current.simJobId;
  let evidenceResultId = current.evidenceResultId;
  const rank = { pending: 0, routed: 1, evidence: 2, not_required: 2 } as const;

  if (status === "not_required") {
    lastError =
      "continuation was previously certified as not required, but runnable completed cutovers now exist";
  } else if (rank[status] > rank[aggregateStatus]) {
    lastError =
      lastError ??
      "successor continuation proof disappeared after the durable status advanced";
  } else if (!lastError) {
    status = aggregateStatus;
    const allCandidates = campaignProofs.flatMap(
      (proof) => candidatesByCampaign.get(proof.campaignId) ?? [],
    );
    if (status === "pending") {
      simJobId = null;
      evidenceResultId = null;
    } else if (status === "routed") {
      const selected =
        allCandidates.find((candidate) => candidate.id === current.simJobId) ??
        allCandidates[0];
      simJobId = selected?.id ?? null;
      evidenceResultId = null;
    } else {
      const selected =
        (current.status === "evidence"
          ? allCandidates.find(
              (candidate) =>
                candidate.id === current.simJobId &&
                candidate.evidence_result_id === current.evidenceResultId,
            )
          : null) ??
        allCandidates.find((candidate) => candidate.evidence_result_id);
      simJobId = selected?.id ?? null;
      evidenceResultId = selected?.evidence_result_id ?? null;
    }
  }

  if (lastError) {
    await db
      .update(solverCutoverContinuationChecks)
      .set({ checkedAt, lastError })
      .where(eq(solverCutoverContinuationChecks.id, current.id));
  } else {
    await db
      .update(solverCutoverContinuationChecks)
      .set({
        status,
        simJobId,
        evidenceResultId,
        checkedAt,
        lastError: null,
        routedAt: status === "pending" ? null : (current.routedAt ?? checkedAt),
        evidenceAt:
          status === "evidence" ? (current.evidenceAt ?? checkedAt) : null,
      })
      .where(eq(solverCutoverContinuationChecks.id, current.id));
  }

  return {
    canaryAttestationId,
    status,
    simJobId,
    evidenceResultId,
    checkedAt: checkedAt.toISOString(),
    lastError,
    requiredCampaigns: requiredCutovers.length,
    campaigns: campaignProofs,
  };
}
