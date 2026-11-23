import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@aerodb/db/client";
import { analysisContentHash } from "@aerodb/db/analysis-target";
import { readProgressiveEvidenceCustodyReceipt } from "@aerodb/db/progressive-evidence-custody";
import {
  assertProgressiveRemoteEvidenceAttempt,
  readProgressiveRemoteEvidenceReceipt,
} from "@aerodb/db/progressive-remote-evidence-receipts";
import { ProgressiveRemoteEvidenceConflict } from "@aerodb/db/progressive-remote-evidence";
import type { prepareProgressivePolarImport } from "./progressive-polar-import";

// Inspect the original JSON. The regular importer applies defaults and strips
// unknown keys, so its parsed value cannot distinguish a receipt request from
// a proposed change of content.
const signature = z.string().regex(/^[0-9a-f]{64}$/);
const identityOnly = z
  .object({
    promiseId: z.string().uuid(),
    sourceInstanceId: z.string().min(1),
    sourceInstanceName: z.string().optional(),
    results: z.tuple([
      z
        .object({
          aoaDeg: z.number().finite(),
          engineJobId: z.string().uuid(),
          engineCaseSlug: z.string().nullable(),
          remoteResultId: z.string().uuid(),
          remoteResultAttemptId: z.string().uuid(),
          progressiveEvidence: z
            .object({
              sequence: z.number().int().positive(),
              reportContentSignature: signature,
              pointContentSignature: signature,
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict();

export function isPolarReceiptReplayRequest(body: unknown) {
  return identityOnly.safeParse(body).success;
}

type PreparedEntry =
  Awaited<ReturnType<typeof prepareProgressivePolarImport>> extends Map<
    number,
    infer Entry
  >
    ? Entry
    : never;

/** Recover a lost acknowledgement of the original delivery on closed work.
 * Auth, exact report/point verification and attempt archive I/O already ran.
 * The snapshot joins the same closed promise, attempt, raw generation and
 * member inventory before returning the original immutable receipt. */
export async function readBoundPolarReplayReceipt(
  db: DB,
  entry: PreparedEntry,
  instanceId: string,
) {
  const { delivery, receipt, source, projection } = entry;
  if (!receipt || receipt.sequence !== delivery.progressiveEvidence.sequence)
    return null;
  return db.transaction(
    async (tx) => {
      const connection = tx as unknown as DB;
      const uploads =
        await connection.execute(sql`SELECT u.id,cf.attempt_token,cf.evidence_signature
      FROM sync_sweep_promises p JOIN registered_remote_solvers solver ON solver.id=p.registered_solver_id AND solver.revoked_at IS NULL
      JOIN progressive_remote_dispatches d ON d.promise_id=p.id AND d.solver_id=solver.id
      JOIN sync_sweep_promise_points pp ON pp.promise_id=p.id AND pp.aoa_deg=${delivery.aoaDeg}
      JOIN result_attempts a ON a.id=${receipt.resultAttemptId}::uuid AND a.sim_job_id=d.sim_job_id
        AND a.engine_job_id=d.sim_job_id::text AND a.engine_case_slug IS NOT DISTINCT FROM ${delivery.engineCaseSlug}
        AND a.aoa_deg=pp.aoa_deg AND a.airfoil_id=p.airfoil_id AND a.simulation_preset_revision_id=p.simulation_preset_revision_id
      JOIN results r ON r.id=a.result_id AND r.id=${receipt.resultId}::uuid AND r.airfoil_id=a.airfoil_id
        AND r.simulation_preset_revision_id=a.simulation_preset_revision_id AND r.aoa_deg=a.aoa_deg
      LEFT JOIN progressive_cfd_evidence cf ON cf.result_attempt_id=a.id
      JOIN sync_brokered_evidence_uploads u ON u.promise_id=p.id AND u.solver_id=solver.id AND u.state='bound'
        AND u.canonical_result_attempt_id=a.id AND u.canonical_result_id=r.id AND u.remote_result_id=${delivery.remoteResultId}::uuid
        AND u.remote_result_attempt_id=${delivery.remoteResultAttemptId}::uuid AND u.engine_job_id=a.engine_job_id
        AND u.engine_case_slug IS NOT DISTINCT FROM a.engine_case_slug AND u.aoa_deg=a.aoa_deg
      WHERE p.id=${delivery.promiseId}::uuid AND p.status='cancelled' AND pp.status<>'fulfilled'
        AND d.sim_job_id=${delivery.engineJobId}::uuid AND d.content_signature=${source.report.assignmentSignature}
        AND solver.id=${delivery.solverId}::uuid AND p.request_payload->>'solverId'=solver.id::text
        AND p.source_instance_id=${instanceId} AND solver.instance_id=p.source_instance_id LIMIT 2`);
      if (uploads.length !== 1) return null;
      const bound = uploads[0]!;
      if (
        bound.attempt_token != null &&
        (!source.envelope.scope.units.some(
          (u) => u.token === bound.attempt_token && u.alpha === delivery.aoaDeg,
        ) ||
          bound.evidence_signature !==
            analysisContentHash(projection.evidencePayload))
      )
        throw new ProgressiveRemoteEvidenceConflict(
          "Stored scientific receipt differs from its signed point",
        );
      await assertProgressiveRemoteEvidenceAttempt(connection, {
        ...delivery,
        resultAttemptId: receipt.resultAttemptId,
      });
      await readProgressiveEvidenceCustodyReceipt(
        connection,
        delivery,
        String(bound.id),
      );
      const confirmed = await readProgressiveRemoteEvidenceReceipt(
        connection,
        delivery,
      );
      if (
        !confirmed ||
        confirmed.resultAttemptId !== receipt.resultAttemptId ||
        confirmed.resultId !== receipt.resultId ||
        confirmed.receivedAt !== receipt.receivedAt ||
        confirmed.sequence !== receipt.sequence ||
        confirmed.storageOnly !== receipt.storageOnly
      )
        throw new ProgressiveRemoteEvidenceConflict(
          "Original evidence receipt changed before acknowledgement",
        );
      return confirmed;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
