import type { DB } from "@aerodb/db/client";
import { sql } from "drizzle-orm";
import { analysisContentHash } from "@aerodb/db/analysis-target";
import { validateProgressiveExecutionStopProof } from "@aerodb/db/progressive-cfd-settlement";
import { readProgressiveReport } from "@aerodb/db/progressive-report-reader";
import { validateProgressiveRemoteReport } from "@aerodb/db/progressive-remote-report";
import { verifyProgressiveRemoteExecution } from "@aerodb/db/progressive-remote-execution";
import type { SharedReportOwner } from "./shared-report-archive";
import type { EngineExecutionStopProof } from "@aerodb/engine-client";

/** Read and authenticate the true terminal report before taking custody locks.
 * Scientific acceptance and whether the result is null remain properties of
 * the original report, independent of storage. */
export async function prepareStoppedAnchorHead(
  db: DB,
  owner: SharedReportOwner,
  stop: string,
) {
  const [j] =
    await db.execute(sql`SELECT d.envelope,st.proof,st.proof_signature,last.sequence::int seq,last.content_signature sig
    FROM progressive_remote_dispatches d JOIN sim_jobs job ON job.id=d.sim_job_id AND job.engine_job_id=job.id::text
    JOIN progressive_cfd_execution_stops st ON st.sim_job_id=job.id AND st.engine_job_id=job.engine_job_id
    JOIN LATERAL (SELECT sequence,content_signature FROM progressive_remote_reports WHERE sim_job_id=job.id ORDER BY sequence DESC LIMIT 1) last ON true
    WHERE job.id=${owner.executionId}::uuid AND d.solver_id=${owner.solverId}::uuid AND d.promise_id=${owner.promiseId}::uuid AND d.content_signature=${owner.assignmentSignature}`);
  if (!j || j.proof_signature !== stop || analysisContentHash(j.proof) !== stop)
    throw new Error("Terminal anchor stop proof changed");
  const proof = j.proof as EngineExecutionStopProof;
  validateProgressiveExecutionStopProof(proof);
  const envelope = verifyProgressiveRemoteExecution(j.envelope, {
    ...owner,
    contentSignature: owner.assignmentSignature,
  });
  const head = await readProgressiveReport(db, {
    sourceKind: "remote",
    executionId: owner.executionId,
    sequence: Number(j.seq),
    contentSignature: String(j.sig),
  });
  const validated = validateProgressiveRemoteReport(head, envelope);
  if (
    validated.contentSignature !== j.sig ||
    proof.job_id !== owner.executionId ||
    !head.stopProof ||
    head.stopProof.job_id !== owner.executionId ||
    !["completed", "failed", "cancelled"].includes(head.status.state)
  )
    throw new Error("Terminal anchor has no authenticated closed report");
  validateProgressiveExecutionStopProof(head.stopProof);
  return { sequence: Number(j.seq), signature: String(j.sig) };
}
