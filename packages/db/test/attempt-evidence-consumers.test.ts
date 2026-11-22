import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "../src/client";
import {
  attemptEvidenceArrayLengthSql,
  attemptEvidenceColdCohortSql,
  attemptEvidenceHasForceHistorySql,
  projectAttemptEvidenceForConsumers,
} from "../src/attempt-evidence-consumers";
import { attemptEvidenceMetadataMatches } from "../src/attempt-evidence-reader";
import { reportTextIdentity } from "../src/progressive-report-archive";

describe("lossless server-side history projection", () => {
  it("omits only actual agreed arrays while preserving nulls, aliases, certificates and unknown numeric values", () => {
    const original =
      '{"fidelity":"rans","unknown":{"samples":[9007199254740993]},"force_history":{"t":[0, 1],"cl":null,"cd":[0.1, 0.2],"cm":[]},"forceHistory":{"t":[2],"cl":[3],"cd":[4]},"steady_history":{"iterations":[1,2],"mean_stable":true,"note":"kept"},"rans_hold_certificate":{"windows":[{"mean":0.1}]},"frame_track":{"frames":[],"stationary":true}}';
    const projected = projectAttemptEvidenceForConsumers(original);
    const body = JSON.parse(projected.projectionText);
    expect(body.force_history).toEqual({ cl: null });
    expect(body.forceHistory).toEqual({});
    expect(body.steady_history).toEqual({ mean_stable: true, note: "kept" });
    expect(body.rans_hold_certificate.windows).toEqual([{ mean: 0.1 }]);
    expect(projected.projectionText).toContain("9007199254740993");
    expect(
      projected.arrayFacts.find(
        (entry) => entry.path.join(".") === "force_history.cm",
      )?.length,
    ).toBe(0);
    expect(
      projected.arrayFacts.find(
        (entry) => entry.path.join(".") === "force_history.t",
      ),
    ).toMatchObject({
      length: 2,
      byteSize: 6,
      sha256: reportTextIdentity("[0, 1]").sha256,
    });
    expect(
      attemptEvidenceMetadataMatches(
        original,
        projected.projectionText,
        projected.arrayFacts.map((entry) => entry.path),
      ),
    ).toBe(true);
    expect(() =>
      projectAttemptEvidenceForConsumers(original, [
        ["rans_hold_certificate", "windows"],
      ]),
    ).toThrow(/Unknown/);
    expect(() =>
      projectAttemptEvidenceForConsumers(original, [
        ["force_history", "t"],
        ["force_history", "t"],
      ]),
    ).toThrow(/duplicate/);
  });
});

// Product-schema column types are reused in temporary tables, with no mutation
// of an application row or singleton. Actual 0208 SQL helper bodies are used.
describe("server consumer SQL contract", () => {
  const client = createClient({ max: 1 });
  afterAll(async () => {
    await client.sql.end();
  });

  it("admits a real settled cohort, blocks each referenced dependency, and keeps inline/cold predicates equivalent", async () => {
    await client.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL search_path=pg_temp,public`);
      await tx.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS SELECT id,result_id,sim_job_id,airfoil_id,simulation_preset_revision_id,
        status,source,regime,unsteady,engine_job_id,evidence_payload FROM public.result_attempts WITH NO DATA`);
      await tx.execute(
        sql`ALTER TABLE result_attempts ADD COLUMN evidence_archive_id uuid`,
      );
      await tx.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS SELECT id,status,"ingestedAt",ingest_lease_token,ingest_lease_expires_at,
        engine_state,request_payload FROM public.sim_jobs WITH NO DATA`);
      const dialect = new PgDialect();
      const cohort = attemptEvidenceColdCohortSql(sql`a`);
      const query = dialect.sqlToQuery(cohort).sql;
      const blockers = [
        ...query.matchAll(
          /NOT EXISTS \(SELECT 1 FROM ([a-z_]+) ([a-z]+) WHERE ([^)]+)\)/g,
        ),
      ].map((match) => {
        const table = match[1]!,
          alias = match[2]!,
          condition = match[3]!;
        const columns = [
          ...new Set(
            [
              ...condition.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, "g")),
            ].map((entry) => entry[1]!),
          ),
        ];
        const target = new RegExp(
          `\\b${alias}\\.([a-z_]+)\\s*=\\s*a\\.(id|sim_job_id|engine_job_id)`,
        ).exec(condition);
        if (!target) throw new Error(`No exact source binding in ${table}`);
        return { table, columns, column: target[1]!, source: target[2]! };
      });
      expect(blockers.length).toBeGreaterThanOrEqual(25);
      for (const block of blockers)
        await tx.execute(sql`CREATE TEMP TABLE ${sql.identifier(block.table)} ON COMMIT DROP AS
        SELECT ${sql.join(
          block.columns.map((column) => sql.identifier(column)),
          sql`, `,
        )}
        FROM ${sql.identifier("public")}.${sql.identifier(block.table)} WITH NO DATA`);
      const attemptId = randomUUID(),
        jobId = randomUUID(),
        resultId = randomUUID();
      const engineJobId = "consumer-fixture-engine";
      const payload = {
        fidelity: "rans",
        mesh_recovery_version: 1,
        force_history: {
          t: [0, 1],
          cl: [0.4, 0.5],
          cd: [0.02, 0.03],
          cm: null,
        },
      };
      await tx.execute(sql`INSERT INTO sim_jobs(id,status,"ingestedAt",engine_state,request_payload)
        VALUES(${jobId}::uuid,'done',clock_timestamp(),'completed','{}'::jsonb)`);
      await tx.execute(sql`INSERT INTO result_attempts(id,result_id,sim_job_id,status,source,regime,unsteady,engine_job_id,evidence_payload)
        VALUES(${attemptId}::uuid,${resultId}::uuid,${jobId}::uuid,'done','solved','rans',false,${engineJobId},${JSON.stringify(payload)}::jsonb)`);
      const eligible = async () =>
        (
          await tx.execute(
            sql`SELECT ${cohort} AS eligible FROM result_attempts a WHERE id=${attemptId}::uuid`,
          )
        )[0].eligible;
      expect(await eligible()).toBe(true);
      for (const block of blockers) {
        const value =
          block.source === "id"
            ? attemptId
            : block.source === "sim_job_id"
              ? jobId
              : engineJobId;
        await tx.execute(
          sql`INSERT INTO ${sql.identifier(block.table)}(${sql.identifier(block.column)}) VALUES(${value})`,
        );
        expect(await eligible(), `dependency ${block.table}`).toBe(false);
        await tx.execute(sql`DELETE FROM ${sql.identifier(block.table)}`);
      }
      await tx.execute(
        sql`UPDATE sim_jobs SET ingest_lease_token=${randomUUID()}::uuid,ingest_lease_expires_at=NULL`,
      );
      expect(await eligible()).toBe(false);
      await tx.execute(
        sql`UPDATE sim_jobs SET ingest_lease_token=NULL,status='running'`,
      );
      expect(await eligible()).toBe(false);
      await tx.execute(sql`UPDATE sim_jobs SET status='done'`);
      await tx.execute(
        sql`UPDATE result_attempts SET evidence_payload=evidence_payload-'mesh_recovery_version'`,
      );
      expect(await eligible()).toBe(false);

      await tx.execute(
        sql`CREATE TEMP TABLE attempt_evidence_history_projections(result_attempt_id uuid,archive_id uuid,projection jsonb) ON COMMIT DROP`,
      );
      const normalized = sql`COALESCE(NULLIF(a.evidence_payload->'force_history','null'::jsonb),a.evidence_payload->'forceHistory')`;
      const native = sql`(jsonb_typeof(${normalized})='object' AND jsonb_typeof((${normalized})->'t')='array'
        AND jsonb_typeof((${normalized})->'cl')='array' AND jsonb_typeof((${normalized})->'cd')='array'
        AND jsonb_array_length((${normalized})->'t')>0 AND jsonb_array_length((${normalized})->'cl')>0 AND jsonb_array_length((${normalized})->'cd')>0)`;
      const variants = [
        payload,
        { force_history: null, forceHistory: payload.force_history },
        { force_history: {}, forceHistory: payload.force_history },
        { force_history: { t: [], cl: [], cd: [] } },
        { force_history: 7 },
        {},
        {
          frame_track: { frames: [], stationary: true },
          force_history: payload.force_history,
        },
      ];
      for (const value of variants) {
        await tx.execute(
          sql`UPDATE result_attempts SET evidence_payload=${JSON.stringify(value)}::jsonb,evidence_archive_id=NULL`,
        );
        const [before] = await tx.execute(sql`SELECT ${native} AS force,
          ${attemptEvidenceArrayLengthSql(sql`a`, ["force_history", "t"])} AS samples,
          ${attemptEvidenceArrayLengthSql(sql`a`, ["frame_track", "frames"])} AS frames FROM result_attempts a`);
        const [inline] = await tx.execute(
          sql`SELECT ${attemptEvidenceHasForceHistorySql(sql`a.evidence_payload`, sql`a`)} AS force FROM result_attempts a`,
        );
        expect(inline.force).toBe(before.force);
        const archiveId = randomUUID();
        await tx.execute(sql`DELETE FROM attempt_evidence_history_projections`);
        await tx.execute(sql`INSERT INTO attempt_evidence_history_projections
          SELECT id,${archiveId}::uuid,attempt_evidence_make_projection(evidence_payload,id,${archiveId}::uuid) FROM result_attempts`);
        await tx.execute(
          sql`UPDATE result_attempts SET evidence_payload=attempt_evidence_compact(evidence_payload),evidence_archive_id=${archiveId}::uuid`,
        );
        const [after] =
          await tx.execute(sql`SELECT ${attemptEvidenceHasForceHistorySql(sql`a.evidence_payload`, sql`a`, sql`p.projection`)} AS force,
          ${attemptEvidenceArrayLengthSql(sql`a`, ["force_history", "t"], sql`p.projection`)} AS samples,
          ${attemptEvidenceArrayLengthSql(sql`a`, ["frame_track", "frames"], sql`p.projection`)} AS frames FROM result_attempts a
          LEFT JOIN attempt_evidence_history_projections p ON p.result_attempt_id=a.id AND p.archive_id=a.evidence_archive_id`);
        expect(after).toEqual(before);
      }
    });
  });
});
