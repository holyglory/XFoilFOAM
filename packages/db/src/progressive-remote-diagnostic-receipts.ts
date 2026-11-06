import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import { resolveProgressiveRemoteEvidence, ProgressiveRemoteEvidenceConflict } from "./progressive-remote-evidence";
import type { ProgressiveRemoteEvidenceDelivery } from "./progressive-remote-evidence-receipts";
import { readProgressiveRemoteSourceClassifications, progressiveReportedDiagnosticFailureKind } from "./progressive-remote-retention";
import { assertProgressiveRemotePhysicalCase } from "./progressive-remote-point-projection";
import { ProgressiveCfdEvidenceScopePending } from "./progressive-storage-recovery-scope";

interface ProgressiveRemoteDiagnosticReceiptIdentity {
  kind: "retained-progressive-diagnostic";
  executionId: string;
  sequence: number;
  reportContentSignature: string;
  pointContentSignature: string;
  receivedAt: string;
}

export type ProgressiveRemoteDiagnosticReceipt = ProgressiveRemoteDiagnosticReceiptIdentity & (
  { version: 1; failureKind?: never } |
  { version: 2; failureKind: "infrastructure" | "hard_solver" }
);

export async function recordProgressiveRemoteDiagnosticReceipt(
  db: DB,
  delivery: Omit<ProgressiveRemoteEvidenceDelivery, "remoteResultId" | "remoteResultAttemptId">,
): Promise<ProgressiveRemoteDiagnosticReceipt> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const source = await resolveProgressiveRemoteEvidence(connection, delivery);
    if (!source) throw new ProgressiveRemoteEvidenceConflict("Diagnostic receipt requires its exact retained report source");
    const [existing] = await connection.execute(sql`SELECT receipt FROM progressive_remote_diagnostic_receipts
      WHERE sim_job_id=${delivery.engineJobId}::uuid AND point_content_signature=${delivery.progressiveEvidence.pointContentSignature}`);
    if (existing) {
      const receipt = existing.receipt as ProgressiveRemoteDiagnosticReceipt;
      const anchor = await resolveProgressiveRemoteEvidence(connection, {
        ...delivery, progressiveEvidence: {
          sequence: receipt.sequence, reportContentSignature: receipt.reportContentSignature,
          pointContentSignature: receipt.pointContentSignature,
        },
      });
      if (!anchor || (receipt.version !== 1 && receipt.version !== 2) ||
        (receipt.version === 2 && !["infrastructure", "hard_solver"].includes(receipt.failureKind)) ||
        receipt.kind !== "retained-progressive-diagnostic" ||
        receipt.executionId !== delivery.engineJobId || receipt.pointContentSignature !== source.contentSignature)
        throw new ProgressiveRemoteEvidenceConflict("Diagnostic receipt replay changed its exact retained source identity");
      return receipt;
    }
    const [physical] = await connection.execute(sql`SELECT result_attempt_id FROM progressive_remote_evidence_receipts
      WHERE sim_job_id=${delivery.engineJobId}::uuid AND point_content_signature=${source.contentSignature}`);
    if (physical) throw new ProgressiveRemoteEvidenceConflict("Diagnostic source already has an immutable retained-attempt receipt");
    const [stopped] = await connection.execute(sql`SELECT sim_job_id FROM progressive_cfd_execution_stops
      WHERE sim_job_id=${delivery.engineJobId}::uuid AND engine_job_id=${delivery.engineJobId}`);
    if (!stopped) throw new ProgressiveCfdEvidenceScopePending("Diagnostic receipt awaits the exact terminal stop acknowledgement");
    const classifications = await readProgressiveRemoteSourceClassifications(connection, delivery.engineJobId, [delivery.aoaDeg]);
    const failureKind = progressiveReportedDiagnosticFailureKind(source.point);
    if (failureKind === null || !classifications.some((entry) =>
      (entry.kind === "material_diagnostic" || entry.kind === "failure_diagnostic") &&
      entry.pointContentSignature === delivery.progressiveEvidence.pointContentSignature))
      throw new ProgressiveRemoteEvidenceConflict("Diagnostic receipt requires authenticated reported failure history without physical evidence");
    const [job] = await connection.execute(sql`SELECT job.request_payload,job.airfoil_id,campaign.current_plan_revision_id
      FROM sim_jobs job JOIN sim_campaigns campaign ON campaign.id=job.campaign_id
      JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
      JOIN registered_remote_solvers solver ON solver.id=dispatch.solver_id AND solver.revoked_at IS NULL
      WHERE job.id=${delivery.engineJobId}::uuid AND job.engine_job_id=job.id::text
        AND dispatch.solver_id=${delivery.solverId}::uuid AND dispatch.promise_id=${delivery.promiseId}::uuid
        AND campaign.status IN ('active','attention','paused','completed')
      FOR SHARE OF job,campaign,dispatch,solver`);
    if (!job) throw new ProgressiveRemoteEvidenceConflict("Diagnostic receipt has no current authenticated execution owner");
    const metadata = (job.request_payload as { progressive: Record<string, unknown> }).progressive;
    const units = await connection.execute(sql`SELECT attempt.token,attempt.outcome,attempt.execution_recipe_id,
      unit.aoa_deg,unit.state,unit.lease_token,unit.lease_until,work.target_id,work.stage,
      generation.id AS generation_id,generation.epoch_id,revision.snapshot,
      NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts newer WHERE newer.unit_id=unit.id
        AND (newer.started_at,newer.token)>(attempt.started_at,attempt.token)) AS latest_attempt
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      JOIN progressive_work work ON work.id=unit.work_id
      JOIN progressive_generations generation ON generation.id=work.generation_id
      JOIN calculation_epochs epoch ON epoch.id=generation.epoch_id AND epoch.current
      JOIN progressive_cfd_execution_recipes recipe ON recipe.id=attempt.execution_recipe_id
      JOIN simulation_preset_revisions revision ON revision.id=recipe.execution_revision_id
      WHERE attempt.sim_job_id=${delivery.engineJobId}::uuid
        AND generation.plan_revision_id=${job.current_plan_revision_id}::uuid
        AND generation.status IN ('active','attention','complete')
      ORDER BY unit.id FOR SHARE OF attempt,unit,work,generation,epoch,recipe,revision`);
    const [count] = await connection.execute(sql`SELECT count(*)::integer AS count
      FROM progressive_cfd_attempts WHERE sim_job_id=${delivery.engineJobId}::uuid`);
    const tokens = metadata.tokens;
    const selected = units.filter((unit) => Number(unit.aoa_deg) === delivery.aoaDeg);
    if (!units.length || units.length !== Number(count.count) || !Array.isArray(tokens) ||
      tokens.length !== units.length || new Set(tokens).size !== units.length ||
      units.some((unit) => !tokens.includes(unit.token) || unit.generation_id !== metadata.generationId ||
        unit.epoch_id !== metadata.epochId || unit.target_id !== metadata.targetId ||
        unit.stage !== metadata.stage || unit.execution_recipe_id !== metadata.recipeId) ||
      selected.length !== 1 || selected[0].latest_attempt !== true ||
      !((selected[0].outcome === "failed" && ["gap","pending"].includes(String(selected[0].state)) &&
        selected[0].lease_token == null && selected[0].lease_until == null) ||
        (selected[0].outcome === "running" && ["leased","blocked"].includes(String(selected[0].state)) &&
          (selected[0].state === "blocked" ? selected[0].lease_token == null
            : selected[0].lease_token === selected[0].token))))
      throw new ProgressiveRemoteEvidenceConflict("Diagnostic receipt differs from the latest stopped material-failure ownership");
    assertProgressiveRemotePhysicalCase(source, selected[0].snapshot as Parameters<typeof assertProgressiveRemotePhysicalCase>[1]);
    const [clock] = await connection.execute(sql`SELECT clock_timestamp() AS at`);
    const receipt: ProgressiveRemoteDiagnosticReceipt = {
      ...(failureKind === "material_domain" ? { version: 1 as const }
        : { version: 2 as const, failureKind }),
      kind: "retained-progressive-diagnostic", executionId: delivery.engineJobId,
      sequence: delivery.progressiveEvidence.sequence,
      reportContentSignature: delivery.progressiveEvidence.reportContentSignature,
      pointContentSignature: delivery.progressiveEvidence.pointContentSignature,
      receivedAt: new Date(clock.at as string | Date).toISOString(),
    };
    await connection.execute(sql`INSERT INTO progressive_remote_diagnostic_receipts
      (sim_job_id,sequence,point_content_signature,receipt)
      VALUES (${delivery.engineJobId}::uuid,${receipt.sequence},${receipt.pointContentSignature},${JSON.stringify(receipt)}::jsonb)
      ON CONFLICT (sim_job_id,point_content_signature) DO NOTHING`);
    const [stored] = await connection.execute(sql`SELECT receipt FROM progressive_remote_diagnostic_receipts
      WHERE sim_job_id=${delivery.engineJobId}::uuid AND point_content_signature=${receipt.pointContentSignature}`);
    if (stored) receipt.receivedAt = (stored.receipt as ProgressiveRemoteDiagnosticReceipt).receivedAt;
    if (!stored || analysisContentHash(stored.receipt) !== analysisContentHash(receipt))
      throw new ProgressiveRemoteEvidenceConflict("Diagnostic receipt replay changed its exact retained source identity");
    return stored.receipt as ProgressiveRemoteDiagnosticReceipt;
  });
}

export async function issueProgressiveRemoteDiagnosticReceipts(db: DB, executionId: string) {
  const sources = await readProgressiveRemoteSourceClassifications(db, executionId);
  const [dispatch] = await db.execute(sql`SELECT solver_id,promise_id FROM progressive_remote_dispatches
    WHERE sim_job_id=${executionId}::uuid`);
  if (!dispatch) return [];
  const physical = await db.execute(sql`SELECT point_content_signature FROM progressive_remote_evidence_receipts
    WHERE sim_job_id=${executionId}::uuid`);
  const retainedAttempts = new Set(physical.map((entry) => String(entry.point_content_signature)));
  const receipts: ProgressiveRemoteDiagnosticReceipt[] = [];
  for (const source of sources.filter((entry) => !retainedAttempts.has(entry.pointContentSignature) &&
    (entry.kind === "material_diagnostic" || entry.kind === "failure_diagnostic")))
    receipts.push(await recordProgressiveRemoteDiagnosticReceipt(db, {
      solverId: String(dispatch.solver_id), promiseId: String(dispatch.promise_id),
      engineJobId: executionId, aoaDeg: source.aoaDeg, engineCaseSlug: source.engineCaseSlug,
      progressiveEvidence: {
        sequence: source.sequence, reportContentSignature: source.reportContentSignature,
        pointContentSignature: source.pointContentSignature,
      },
    }));
  return receipts;
}
