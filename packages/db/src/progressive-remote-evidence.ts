import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import {
  resolveProgressiveReportedPoint,
  validateProgressiveRemoteReport,
} from "./progressive-remote-report";

export interface ProgressiveRemoteEvidenceReference {
  sequence: number;
  reportContentSignature: string;
  pointContentSignature: string;
}

export class ProgressiveRemoteEvidenceConflict extends Error {}

export async function resolveProgressiveRemoteEvidence(
  db: DB,
  input: {
    solverId: string;
    promiseId: string;
    engineJobId: string;
    aoaDeg: number;
    engineCaseSlug: string | null;
    progressiveEvidence?: ProgressiveRemoteEvidenceReference;
  },
) {
  const [assigned] = await db.execute(sql`
    SELECT promise.request_payload, dispatch.sim_job_id, dispatch.solver_id,
      dispatch.content_signature, dispatch.envelope, solver.revoked_at
    FROM sync_sweep_promises promise LEFT JOIN progressive_remote_dispatches dispatch ON dispatch.promise_id = promise.id
    LEFT JOIN registered_remote_solvers solver ON solver.id = dispatch.solver_id
    WHERE promise.id = ${input.promiseId}::uuid
  `);
  if (!assigned?.sim_job_id) {
    if (
      input.progressiveEvidence ||
      (assigned?.request_payload as Record<string, unknown> | null)
        ?.executionContract === "progressive-cfd-v1"
    )
      throw new ProgressiveRemoteEvidenceConflict(
        "Progressive evidence has no exact stored dispatch",
      );
    return null;
  }
  const reference = input.progressiveEvidence;
  if (
    !reference ||
    !Number.isSafeInteger(reference.sequence) ||
    reference.sequence < 1 ||
    !/^[a-f0-9]{64}$/.test(reference.reportContentSignature) ||
    !/^[a-f0-9]{64}$/.test(reference.pointContentSignature)
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive evidence requires its exact report and point signatures",
    );
  if (
    assigned.solver_id !== input.solverId ||
    assigned.sim_job_id !== input.engineJobId ||
    assigned.revoked_at !== null
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive evidence sender does not own this execution",
    );
  const envelope = verifyProgressiveRemoteExecution(assigned.envelope, {
    solverId: input.solverId,
    promiseId: input.promiseId,
    executionId: input.engineJobId,
    contentSignature: String(assigned.content_signature),
  });
  const [stored] =
    await db.execute(sql`SELECT report, content_signature FROM progressive_remote_reports
    WHERE sim_job_id = ${input.engineJobId}::uuid AND sequence = ${reference.sequence}`);
  if (!stored)
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive evidence report has not reached the hub",
    );
  const validated = validateProgressiveRemoteReport(stored.report, envelope);
  if (
    validated.contentSignature !== stored.content_signature ||
    validated.contentSignature !== reference.reportContentSignature ||
    !validated.report.result
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive evidence differs from the stored report",
    );
  let source: ReturnType<typeof resolveProgressiveReportedPoint>;
  try {
    source = resolveProgressiveReportedPoint(validated.report.result, {
      alpha: input.aoaDeg,
      caseSlug: input.engineCaseSlug,
      speed: envelope.request.speeds![0],
      chord: envelope.request.chord_lengths![0],
    });
  } catch (error) {
    throw new ProgressiveRemoteEvidenceConflict(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (source.contentSignature !== reference.pointContentSignature)
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive evidence differs from the exact reported point",
    );
  return { ...source, envelope, report: validated.report };
}

export function assertProgressiveReportedManifest(
  source: NonNullable<
    Awaited<ReturnType<typeof resolveProgressiveRemoteEvidence>>
  >,
  input: { manifestSha256: string; manifestByteSize: number },
) {
  const manifests =
    source.point.evidence_artifacts?.filter(
      (artifact) => artifact.kind === "manifest",
    ) ?? [];
  if (
    !manifests.some(
      (manifest) =>
        manifest.sha256.toLowerCase() === input.manifestSha256 &&
        manifest.byte_size === input.manifestByteSize,
    )
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive archive manifest differs from its reported source evidence",
    );
}
