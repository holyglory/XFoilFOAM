import { sql } from "drizzle-orm";
import { createClient, type DB } from "@aerodb/db";
import { advanceGeneration } from "@aerodb/db/progressive-campaigns";
import { promoteRetainedProgressiveAttempts } from "./progressive-remote-settlement";

const [campaignId, expectedCountText, mode = "--dry-run"] = process.argv.slice(2);
const expectedCount = Number(expectedCountText);
if (
  !campaignId ||
  !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(campaignId) ||
  !Number.isSafeInteger(expectedCount) ||
  expectedCount < 1 ||
  expectedCount > 2048 ||
  !["--dry-run", "--apply"].includes(mode)
)
  throw new Error(
    "Usage: recover-accepted-progressive-gaps CAMPAIGN_UUID EXPECTED_COUNT [--dry-run|--apply]",
  );

const { db, sql: end } = createClient({ max: 2 });
const rollback = new Error("accepted progressive gap recovery dry-run rollback");
try {
  const result = await db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const candidates = await connection.execute(sql`
      SELECT DISTINCT ON (unit.id)
        unit.id AS unit_id, work.id AS work_id, generation.id AS generation_id,
        attempt.sim_job_id AS job_id, raw.id AS result_attempt_id,
        job.airfoil_id, job.simulation_preset_revision_id
      FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id
      JOIN progressive_cfd_evidence evidence ON evidence.attempt_token = attempt.token
      JOIN result_attempts raw ON raw.id = evidence.result_attempt_id
      JOIN results result ON result.id = raw.result_id
      JOIN result_classifications classification
        ON classification.result_attempt_id = raw.id AND classification.state = 'accepted'
      JOIN sim_jobs job ON job.id = attempt.sim_job_id
      WHERE generation.campaign_id = ${campaignId}::uuid
        AND generation.status = 'active'
        AND generation.plan_revision_id = campaign.current_plan_revision_id
        AND campaign.status IN ('active', 'attention', 'paused')
        AND work.stage IN (2, 3)
        AND unit.state = 'gap'
        AND raw.status = 'done' AND raw.valid_for_polar
        AND result.current_result_attempt_id IS DISTINCT FROM raw.id
        AND coalesce((SELECT review.verdict::text FROM result_review_verdicts review
          WHERE review.result_id = raw.result_id AND review."revokedAt" IS NULL
          ORDER BY review."createdAt" DESC, review.id DESC LIMIT 1), '')
          NOT IN ('exclude', 'defer')
        AND (SELECT count(*) = 1 AND count(*) FILTER (WHERE manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
          AND manifest.byte_size > 0 AND length(trim(manifest.storage_key)) > 0
          AND length(trim(manifest.mime_type)) > 0) = 1
          FROM solver_evidence_artifacts manifest
          WHERE manifest.result_id = raw.result_id AND manifest.result_attempt_id = raw.id
            AND manifest.kind = 'manifest')
        AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts running
          WHERE running.unit_id = unit.id AND running.outcome = 'running')
      ORDER BY unit.id, raw."solvedAt" DESC NULLS LAST, raw.id
      LIMIT ${expectedCount}::int
    `);
    if (candidates.length !== expectedCount)
      throw new Error(
        `Accepted progressive gap candidate count changed: expected ${expectedCount}, found ${candidates.length}`,
      );
    if (mode === "--dry-run") throw rollback;

    const grouped = new Map<string, { airfoilId: string; revisionId: string; attemptIds: string[] }>();
    for (const candidate of candidates) {
      const jobId = String(candidate.job_id);
      const group = grouped.get(jobId) ?? {
        airfoilId: String(candidate.airfoil_id),
        revisionId: String(candidate.simulation_preset_revision_id),
        attemptIds: [],
      };
      group.attemptIds.push(String(candidate.result_attempt_id));
      grouped.set(jobId, group);
    }
    for (const [jobId, group] of grouped) {
      await promoteRetainedProgressiveAttempts(connection, {
        executionId: jobId,
        airfoilId: group.airfoilId,
        simulationPresetRevisionId: group.revisionId,
        attemptIds: group.attemptIds,
      });
    }
    const unitIds = candidates.map((candidate) => sql`${candidate.unit_id}::uuid`);
    const completed = await connection.execute(sql`
      UPDATE progressive_cfd_units unit SET state = 'complete', error = NULL,
        lease_token = NULL, lease_owner = NULL, lease_until = NULL
      WHERE unit.id IN (${sql.join(unitIds, sql`, `)} )
        AND unit.state = 'gap'
        AND EXISTS (
          SELECT 1 FROM progressive_cfd_attempts attempt
          JOIN progressive_cfd_evidence evidence ON evidence.attempt_token = attempt.token
          JOIN result_attempts raw ON raw.id = evidence.result_attempt_id
          JOIN results result ON result.id = raw.result_id
          JOIN result_classifications classification
            ON classification.result_attempt_id = raw.id AND classification.state = 'accepted'
          WHERE attempt.unit_id = unit.id AND result.current_result_attempt_id = raw.id
            AND raw.status = 'done' AND raw.valid_for_polar
        )
      RETURNING unit.id, unit.work_id
    `);
    const workIds = [...new Set(completed.map((row) => String(row.work_id)))];
    for (const workId of workIds)
      await connection.execute(sql`
        UPDATE progressive_work work SET state = 'complete', completed_at = clock_timestamp(), error = NULL
        WHERE work.id = ${workId}::uuid AND work.state IN ('pending', 'gap')
          AND NOT EXISTS (SELECT 1 FROM progressive_cfd_units unit
            WHERE unit.work_id = work.id AND unit.state <> 'complete')
      `);
    const generationIds = [...new Set(candidates.map((candidate) => String(candidate.generation_id)))];
    for (const generationId of generationIds) await advanceGeneration(connection, generationId);
    return { candidateCount: candidates.length, completedUnits: completed.length, jobs: grouped.size };
  }).catch((error) => {
    if (error === rollback) return { mode, candidateCount: expectedCount, completedUnits: 0, jobs: 0 };
    throw error;
  });
  console.log(JSON.stringify({ mode, result }));
} finally {
  await end.end();
}
