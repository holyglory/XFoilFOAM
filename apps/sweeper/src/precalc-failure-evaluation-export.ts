import {
  createClient,
  databaseUrl,
  hasCanonicalAcceptedUransForObligationSql,
  restartablePrecalcWarningSql,
} from "@aerodb/db";
import { sql } from "drizzle-orm";

const parsedLimit = Number.parseInt(
  process.env.PRECALC_EXPORT_LIMIT ?? "5000",
  10,
);
if (
  !Number.isSafeInteger(parsedLimit) ||
  parsedLimit < 1 ||
  parsedLimit > 5_000
) {
  throw new Error(
    "PRECALC_EXPORT_LIMIT must be an integer from 1 through 5000",
  );
}

const { db, sql: client } = createClient({ url: databaseUrl(), max: 1 });
try {
  const rows = (await db.execute(sql`
    SELECT
      obligation.id AS obligation_id,
      latest.result_attempt_id,
      attempt.status,
      attempt.evidence_payload,
      attempt.quality_warnings,
      classification.reasons AS classification_reasons,
      attempt.evidence_payload ->> 'failure_disposition' AS failure_disposition,
      COALESCE(
        (revision.snapshot #>> '{flowState,speedMps}')::float8,
        (revision.snapshot #>> '{flow_state,speed_mps}')::float8
      ) AS speed,
      COALESCE(
        (revision.snapshot #>> '{referenceGeometry,referenceLengthM}')::float8,
        (revision.snapshot #>> '{reference_geometry,reference_length_m}')::float8,
        revision.reference_length_m::float8
      ) AS chord,
      COALESCE(
        attempt.engine_job_id IS NOT NULL
        AND attempt.engine_case_slug IS NOT NULL
        AND ${restartablePrecalcWarningSql(sql`attempt.quality_warnings`)},
        false
      ) AS restartable,
      CASE
        WHEN job."submittedAt" IS NOT NULL
         AND job."finishedAt" IS NOT NULL
         AND job."finishedAt" >= job."submittedAt"
        THEN EXTRACT(EPOCH FROM (job."finishedAt" - job."submittedAt"))
             * GREATEST(job.admission_cpu_slots, 1)::float8
             / 3600.0
             / GREATEST(job.total_cases, 1)::float8
        ELSE NULL
      END AS estimated_cpu_hours
    FROM sim_precalc_obligations obligation
    JOIN simulation_preset_revisions revision ON revision.id = obligation.revision_id
    JOIN LATERAL (
      SELECT submission.result_attempt_id, submission.sim_job_id
      FROM sim_precalc_obligation_attempts submission
      WHERE submission.obligation_id = obligation.id
      ORDER BY submission.attempt_number DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN result_attempts attempt ON attempt.id = latest.result_attempt_id
    LEFT JOIN result_classifications classification
      ON classification.result_attempt_id = attempt.id
    LEFT JOIN sim_jobs job ON job.id = latest.sim_job_id
    WHERE obligation.state = 'blocked'
      AND COALESCE(obligation.last_outcome, '') <> 'deterministic_failure'
      AND NOT (${hasCanonicalAcceptedUransForObligationSql})
    ORDER BY obligation.id
    LIMIT ${parsedLimit}
  `)) as unknown as Array<Record<string, unknown>>;
  for (const row of rows) {
    process.stdout.write(`${JSON.stringify(row)}\n`);
  }
} finally {
  await client.end();
}
