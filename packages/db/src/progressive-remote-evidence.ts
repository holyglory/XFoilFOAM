import {
  recheckRemoteReportMember,
  resolveStoredProgressiveReport,
  verifiedProgressiveReportMember,
} from "./progressive-report-reader";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import {
  resolveProgressiveReportedPoint,
  validateProgressiveRemoteReport,
  type ProgressiveRemoteReport,
} from "./progressive-remote-report";

export interface ProgressiveRemoteEvidenceReference {
  sequence: number;
  reportContentSignature: string;
  pointContentSignature: string;
}

export class ProgressiveRemoteEvidenceConflict extends Error {}

// Only the server prepares these reference objects. The HTTP caller supplies
// identifiers, never the reusable authenticated body. The database rechecks
// dispatch ownership and the immutable sequence/signature on every use.
type EvidenceInput = {
  solverId: string;
  promiseId: string;
  engineJobId: string;
  aoaDeg: number;
  engineCaseSlug: string | null;
  progressiveEvidence?: ProgressiveRemoteEvidenceReference;
};
type PointSource = ReturnType<typeof resolveProgressiveReportedPoint> & {
  envelope: ReturnType<typeof verifyProgressiveRemoteExecution>;
  report: ProgressiveRemoteReport;
};
type VerifiedMember = NonNullable<
  ReturnType<typeof verifiedProgressiveReportMember>
>;
const preparedReports = new WeakMap<
  ProgressiveRemoteEvidenceReference,
  {
    report: ProgressiveRemoteReport;
    member?: { proof: VerifiedMember; source: PointSource };
  }
>();

function freezeReport(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeReport(child);
}

export function prepareProgressiveRemoteEvidence(db: DB, input: EvidenceInput) {
  if (input.progressiveEvidence)
    preparedReports.delete(input.progressiveEvidence);
  return resolveEvidence(db, input, true);
}

export function resolveProgressiveRemoteEvidence(db: DB, input: EvidenceInput) {
  return resolveEvidence(db, input, false);
}

async function resolveEvidence(
  db: DB,
  input: EvidenceInput,
  prepare: boolean,
): Promise<PointSource | null> {
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
  const prepared = preparedReports.get(reference);
  if (prepared?.member) {
    const { proof, source } = prepared.member;
    if (
      source.report.assignmentSignature !== envelope.contentSignature ||
      source.report.solverId !== input.solverId ||
      source.report.promiseId !== input.promiseId ||
      proof.identity.executionId !== input.engineJobId ||
      proof.identity.sequence !== reference.sequence ||
      proof.identity.signature !== reference.reportContentSignature ||
      source.contentSignature !== reference.pointContentSignature ||
      source.point.aoa_deg !== input.aoaDeg ||
      (source.point.case_slug ?? null) !== input.engineCaseSlug ||
      !(await recheckRemoteReportMember(db, proof))
    )
      throw new ProgressiveRemoteEvidenceConflict(
        "Prepared point owner or exact signed report source changed",
      );
    return { ...source, envelope };
  }
  const [stored] =
    await db.execute(sql`SELECT ${prepared ? sql`NULL::jsonb` : sql`resolve_progressive_report(to_jsonb(progressive_remote_reports.*))`} AS report, content_signature FROM progressive_remote_reports
    WHERE sim_job_id = ${input.engineJobId}::uuid AND sequence = ${reference.sequence}`);
  if (!stored)
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive evidence report has not reached the hub",
    );
  const report =
    prepared?.report ??
    (await resolveStoredProgressiveReport(
      db,
      "remote",
      stored,
      input.engineJobId,
    ));
  const validated = validateProgressiveRemoteReport(report, envelope);
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
  const selected = { ...source, envelope, report: validated.report };
  if (prepare) {
    const proof = verifiedProgressiveReportMember(report);
    if (proof) {
      if (!(await recheckRemoteReportMember(db, proof)))
        throw new ProgressiveRemoteEvidenceConflict(
          "Archived signed report changed during preparation",
        );
      // Consumers retain the same point and polar objects as the verified report.
      // Freeze before sharing them across checks inside this one import.
      freezeReport(validated.report);
      preparedReports.set(reference, {
        report: validated.report,
        member: { proof, source: { ...selected } },
      });
    } else {
      preparedReports.set(reference, { report: validated.report });
    }
  }
  return selected;
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
