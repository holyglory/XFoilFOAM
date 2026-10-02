import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import { progressiveDeliverySelectionSql } from "../../../apps/sweeper/src/progressive-delivery-selection";
import { progressiveSettlementJobsSql } from "../../../apps/sweeper/src/progressive-progress-selection";
import {
  nextProgressiveArchiveWakeAt,
  progressiveArchiveSelectionSql,
} from "../../../apps/sweeper/src/progressive-worker-archive-delivery";
import type { DB } from "../src/client";
import { reconcileCompletedProgressiveArchiveReclaims } from "../../../apps/sweeper/src/progressive-archive-reclaim";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("recognizes exact completed canonical cleanup without deleting again or double-counting bytes", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE reclaim_cases ON COMMIT DROP AS
      SELECT md5(variant)::uuid id,variant FROM unnest(ARRAY['exact','live-claim','pending','wrong-job','wrong-attempt-job',
        'wrong-result','wrong-upload','wrong-promise','wrong-source','wrong-generation','missing-remote','already-complete']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_archive_reclaims ON COMMIT DROP AS
      SELECT id AS sim_job_id,'signature'::text AS point_content_signature,
        CASE WHEN variant='already-complete' THEN timestamptz '2026-01-01' END AS completed_at,
        CASE WHEN variant='already-complete' THEN 123 ELSE 0 END::bigint AS reclaimed_bytes,
        CASE WHEN variant='live-claim' THEN md5('claim')::uuid END AS claim_token,
        CASE WHEN variant='live-claim' THEN clock_timestamp()+interval '1 day' END AS claim_expires_at,
        'stale failure'::text AS last_error FROM reclaim_cases`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_hub_receipts ON COMMIT DROP AS
      SELECT id AS sim_job_id,'signature'::text AS point_content_signature,id AS result_attempt_id FROM reclaim_cases`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
      SELECT id,id AS result_id,CASE WHEN variant='wrong-attempt-job' THEN md5('foreign')::uuid ELSE id END AS sim_job_id,
        id::text AS engine_job_id FROM reclaim_cases`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_archive_receipts ON COMMIT DROP AS
      SELECT id AS sim_job_id,'signature'::text AS point_content_signature,id AS brokered_upload_id,
        jsonb_build_object('receipt',jsonb_build_object('source',jsonb_build_object('promiseId',id::text),
          'remote',jsonb_build_object('generation','1','storedSha256','sha','storedByteSize',42))) AS receipt FROM reclaim_cases`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_remote_hub_binding_receipts ON COMMIT DROP AS
      SELECT id AS result_attempt_id,CASE WHEN variant='wrong-result' THEN md5('foreign')::uuid ELSE id END AS result_id,
        CASE WHEN variant='wrong-job' THEN md5('foreign')::uuid ELSE id END AS sim_job_id,
        CASE WHEN variant='wrong-upload' THEN md5('foreign')::uuid ELSE id END AS brokered_upload_id,
        CASE WHEN variant='wrong-promise' THEN md5('foreign')::uuid ELSE id END AS promise_id,
        CASE WHEN variant='pending' THEN 'pending' ELSE 'reclaimed' END AS reclaim_state,
        timestamptz '2026-01-01' AS reclaimed_at,42::bigint AS reclaimed_bytes,
        jsonb_build_object('engineJobId',CASE WHEN variant='wrong-source' THEN 'foreign' ELSE id::text END,
          'remote',CASE WHEN variant='missing-remote' THEN NULL::jsonb ELSE
          jsonb_build_object('generation',CASE WHEN variant='wrong-generation' THEN '2' ELSE '1' END,'storedSha256','sha','storedByteSize',42) END) AS receipt
      FROM reclaim_cases`);
    const before = await transaction.execute(
      sql`SELECT to_jsonb(receipt) AS value FROM sync_remote_hub_binding_receipts receipt ORDER BY result_attempt_id`,
    );
    expect(
      await reconcileCompletedProgressiveArchiveReclaims(
        transaction as unknown as DB,
      ),
    ).toBe(1);
    expect(
      await reconcileCompletedProgressiveArchiveReclaims(
        transaction as unknown as DB,
      ),
    ).toBe(0);
    const [settled] =
      await transaction.execute(sql`SELECT completed_at,reclaimed_bytes,claim_token,last_error
      FROM progressive_worker_archive_reclaims WHERE sim_job_id=md5('exact')::uuid`);
    expect(settled).toMatchObject({
      reclaimed_bytes: "0",
      claim_token: null,
      last_error: null,
    });
    expect(new Date(String(settled.completed_at)).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(
      await transaction.execute(
        sql`SELECT to_jsonb(receipt) AS value FROM sync_remote_hub_binding_receipts receipt ORDER BY result_attempt_id`,
      ),
    ).toEqual(before);
    const [retained] = await transaction.execute(
      sql`SELECT count(*)::int AS count FROM progressive_worker_archive_reclaims WHERE completed_at IS NULL`,
    );
    expect(retained.count).toBe(10);
    const [original] = await transaction.execute(
      sql`SELECT reclaimed_bytes FROM progressive_worker_archive_reclaims WHERE sim_job_id=md5('already-complete')::uuid`,
    );
    expect(String(original.reclaimed_bytes)).toBe("123");
  });
});

it("settles fulfilled and active jobs fairly while expired work keeps arriving", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_settlement_jobs ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['fulfilled','active','unapplied','unindexed','executing','not-dispatched']) variant
      UNION ALL SELECT md5('expired-'||ordinal)::uuid,'expired-'||ordinal FROM generate_series(1,36) ordinal`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_campaigns ON COMMIT DROP AS
      SELECT md5('campaign')::uuid AS id,'active'::text AS status`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,md5('campaign')::uuid AS campaign_id,
        CASE WHEN variant='executing' THEN 'running' ELSE 'ingesting' END AS status,
        CASE WHEN variant='executing' THEN 'running' ELSE 'completed' END AS engine_state,
        clock_timestamp()-interval '2 days' AS "updatedAt",
        clock_timestamp()-CASE WHEN variant='fulfilled' THEN interval '1 day' ELSE interval '1 hour' END AS "polledAt"
      FROM fixture_settlement_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches ON COMMIT DROP AS
      SELECT id AS sim_job_id,id AS promise_id FROM fixture_settlement_jobs WHERE variant<>'not-dispatched'`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant LIKE 'expired-%' THEN 'expired' WHEN variant='fulfilled' THEN 'fulfilled' ELSE 'active' END AS status
      FROM fixture_settlement_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,1 AS sequence FROM fixture_settlement_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_progress_receipts ON COMMIT DROP AS
      SELECT id AS sim_job_id,1 AS sequence FROM fixture_settlement_jobs WHERE variant<>'unapplied'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_report_inventories ON COMMIT DROP AS
      SELECT id AS sim_job_id,1 AS sequence FROM fixture_settlement_jobs WHERE variant<>'unindexed'`);
    await transaction.execute(
      sql`CREATE TEMP TABLE progressive_cfd_execution_stops (sim_job_id uuid) ON COMMIT DROP`,
    );
    await transaction.execute(
      sql`CREATE TEMP TABLE progressive_cfd_attempts (sim_job_id uuid,outcome text) ON COMMIT DROP`,
    );
    const [fulfilled] = await transaction.execute(
      sql`SELECT id FROM fixture_settlement_jobs WHERE variant='fulfilled'`,
    );
    const first = await transaction.execute(progressiveSettlementJobsSql());
    expect(first).toHaveLength(32);
    expect(first[0].sim_job_id).toBe(fulfilled.id);
    for (const row of first) {
      await transaction.execute(
        sql`UPDATE sim_jobs SET "polledAt"=clock_timestamp() WHERE id=${row.sim_job_id}::uuid`,
      );
    }
    const second = await transaction.execute(progressiveSettlementJobsSql());
    const visited = new Set([...first, ...second].map((row) => row.sim_job_id));
    expect(visited.size).toBe(38);
    const excluded =
      await transaction.execute(sql`SELECT id FROM fixture_settlement_jobs
      WHERE variant IN ('unapplied','unindexed','executing','not-dispatched')`);
    for (const row of excluded) expect(visited.has(row.id)).toBe(false);
    expect(
      await transaction.execute(
        progressiveSettlementJobsSql([String(fulfilled.id)]),
      ),
    ).toEqual([
      { sim_job_id: fulfilled.id, campaign_id: first[0].campaign_id },
    ]);
  });
});

it("resumes due archive retries and expired claims before untouched work while preserving ownership and deadlines", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_archives ON COMMIT DROP AS
      SELECT md5(variant)::uuid id,variant,ordinal FROM unnest(ARRAY['ordinary','due-retry','expired-claim',
        'unselected-accepted','selected-accepted','already-retained','future-retry','live-claim',
        'wrong-solver','wrong-upstream','wrong-job-upstream','not-remote','not-progressive',
        'wrong-attempt-job','wrong-engine','missing-result','missing-manifest','malformed-manifest'])
        WITH ORDINALITY AS variants(variant,ordinal)`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 id,false remote_solver_transfer_paused,'fixture-token'::text remote_solver_auth_token,
        'https://fixture.invalid'::text upstream_base_url,md5('solver')::uuid remote_solver_registered_id`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,jsonb_build_object('syncPromiseId',id::text,'remoteSolver',variant<>'not-remote',
        'upstreamBaseUrl',CASE WHEN variant='wrong-job-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END)
        || CASE WHEN variant='not-progressive' THEN '{}'::jsonb ELSE '{"remoteProgressiveExecution":{}}'::jsonb END request_payload
      FROM fixture_archives`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant='wrong-solver' THEN md5('foreign')::uuid ELSE md5('solver')::uuid END registered_solver_id,
        CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END source_base_url
      FROM fixture_archives`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
      SELECT md5('attempt'||variant)::uuid id,
        CASE WHEN variant='wrong-attempt-job' THEN md5('foreign')::uuid ELSE id END sim_job_id,
        CASE WHEN variant='wrong-engine' THEN 'foreign' ELSE id::text END engine_job_id,
        CASE WHEN variant='missing-result' THEN NULL ELSE md5('result'||variant)::uuid END result_id,
        CASE WHEN variant='missing-manifest' THEN '{"evidence_artifacts":[{"kind":"log"}]}'::jsonb
          WHEN variant='malformed-manifest' THEN '{"evidence_artifacts":{"kind":"manifest"}}'::jsonb
          ELSE '{"evidence_artifacts":[{"kind":"manifest"}]}'::jsonb END evidence_payload
      FROM fixture_archives`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_hub_receipts ON COMMIT DROP AS
      SELECT id sim_job_id,md5(variant)::text point_content_signature,md5('attempt'||variant)::uuid result_attempt_id,
        timestamptz '2026-01-01' + ordinal * interval '1 second' delivered_at FROM fixture_archives`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_archive_receipts ON COMMIT DROP AS
      SELECT id sim_job_id,md5(variant)::text point_content_signature FROM fixture_archives WHERE variant='already-retained'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_archive_deliveries ON COMMIT DROP AS
      SELECT id sim_job_id,md5(variant)::text point_content_signature,
        CASE WHEN variant IN ('live-claim','expired-claim') THEN md5(variant||'claim')::uuid END claim_token,
        CASE WHEN variant IN ('future-retry','due-retry') THEN 1 ELSE 0 END attempt_count,
        CASE WHEN variant='live-claim' THEN clock_timestamp()+interval '2 days'
          WHEN variant='expired-claim' THEN clock_timestamp()-interval '1 day' END claim_expires_at,
        CASE WHEN variant='future-retry' THEN clock_timestamp()+interval '1 day'
          WHEN variant='due-retry' THEN clock_timestamp()-interval '1 minute' END retry_after
      FROM fixture_archives WHERE variant IN ('future-retry','due-retry','live-claim','expired-claim')`);
    await transaction.execute(sql`CREATE TEMP TABLE result_classifications ON COMMIT DROP AS
      SELECT md5('attempt'||variant)::uuid result_attempt_id,'accepted'::text state
      FROM fixture_archives WHERE variant IN ('selected-accepted','unselected-accepted')`);
    await transaction.execute(sql`CREATE TEMP TABLE results ON COMMIT DROP AS
      SELECT md5('attempt'||variant)::uuid current_result_attempt_id FROM fixture_archives WHERE variant='selected-accepted'`);
    const connection = transaction as unknown as DB;
    for (const variant of [
      "expired-claim",
      "due-retry",
      "ordinary",
      "unselected-accepted",
    ]) {
      const selected = await transaction.execute(
        progressiveArchiveSelectionSql(),
      );
      const expected =
        await transaction.execute(sql`SELECT id sim_job_id,md5(variant)::text point_content_signature,
        md5('attempt'||variant)::uuid result_attempt_id FROM fixture_archives WHERE variant=${variant}`);
      expect(selected).toEqual(expected);
      await transaction.execute(sql`INSERT INTO progressive_worker_archive_receipts VALUES
        (${selected[0].sim_job_id}::uuid,${selected[0].point_content_signature})`);
    }
    expect(await transaction.execute(progressiveArchiveSelectionSql())).toEqual(
      [],
    );
    const [deadline] =
      await transaction.execute(sql`SELECT retry_after FROM progressive_worker_archive_deliveries
      WHERE sim_job_id=(SELECT id FROM fixture_archives WHERE variant='future-retry')`);
    expect(
      (await nextProgressiveArchiveWakeAt(connection))?.toISOString(),
    ).toBe(new Date(String(deadline.retry_after)).toISOString());
    for (const statement of [
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true`,
      sql`UPDATE sync_api_settings SET remote_solver_auth_token=''`,
      sql`UPDATE sync_api_settings SET upstream_base_url=NULL`,
      sql`UPDATE sync_api_settings SET remote_solver_registered_id=md5('unregistered')::uuid`,
    ]) {
      const rollback = new Error("Rollback isolated archive settings");
      await expect(
        transaction.transaction(async (nested) => {
          await nested.execute(statement);
          expect(
            await nested.execute(progressiveArchiveSelectionSql()),
          ).toEqual([]);
          expect(
            await nextProgressiveArchiveWakeAt(nested as unknown as DB),
          ).toBeNull();
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
  });
});

it("preserves exact eligible deliveries, active priority, fallback and cumulative-report ordering", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_jobs ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['eligible-active','eligible-cancelled','eligible-expired',
        'future-retry','due-retry','conflict','wrong-solver','wrong-upstream','wrong-job-upstream','not-remote',
        'unacknowledged','already-delivered','wrong-attempt-job','wrong-engine','missing-result']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 AS id,false AS remote_solver_transfer_paused,'fixture-token'::text AS remote_solver_auth_token,
        'https://fixture.invalid'::text AS upstream_base_url,md5('solver')::uuid AS remote_solver_registered_id,
        md5('instance')::uuid AS instance_id,'fixture'::text AS instance_name`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,jsonb_build_object('syncPromiseId',id::text,'remoteSolver',variant<>'not-remote',
        'upstreamBaseUrl',CASE WHEN variant='wrong-job-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END) AS request_payload
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant='eligible-cancelled' THEN 'cancelled' ELSE 'active' END AS status,
        CASE WHEN variant='eligible-expired' THEN clock_timestamp()-interval '1 day' ELSE clock_timestamp()+interval '1 day' END AS "expiresAt",
        CASE WHEN variant='wrong-solver' THEN md5('foreign')::uuid ELSE md5('solver')::uuid END AS registered_solver_id,
        CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END AS source_base_url
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,sequence,CASE WHEN variant='unacknowledged' THEN NULL ELSE clock_timestamp() END AS acknowledged_at,
        '{"result":{}}'::jsonb AS report,md5(variant||sequence)::text AS content_signature,
        timestamptz '2026-01-01T00:00:00Z' + CASE WHEN variant='eligible-cancelled' THEN interval '0 seconds' ELSE interval '1 second' END AS created_at
      FROM fixture_jobs CROSS JOIN generate_series(1,2) sequence`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
      SELECT md5(variant||angle||replay)::uuid AS id,
        CASE WHEN variant='wrong-attempt-job' THEN md5('foreign')::uuid ELSE id END AS sim_job_id,
        CASE WHEN variant='wrong-engine' THEN md5('foreign')::text ELSE id::text END AS engine_job_id,
        CASE WHEN variant='missing-result' THEN NULL ELSE md5('result'||variant)::uuid END AS result_id,
        angle AS aoa_deg,'fixture-'||angle AS engine_case_slug,'{"realFixture":true}'::jsonb AS evidence_payload
      FROM fixture_jobs CROSS JOIN unnest(ARRAY[-2,3]) angle CROSS JOIN generate_series(1,2) replay`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_attempts ON COMMIT DROP AS
      SELECT fixture.id AS sim_job_id,sequence,md5(variant||angle||replay)::uuid AS result_attempt_id,
        md5('point'||variant||angle||replay)::text AS point_content_signature
      FROM fixture_jobs fixture CROSS JOIN generate_series(1,2) sequence CROSS JOIN unnest(ARRAY[-2,3]) angle CROSS JOIN generate_series(1,2) replay`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_delivery_claims (
      sim_job_id uuid NOT NULL,
      sequence bigint NOT NULL,
      result_attempt_id uuid NOT NULL,
      point_content_signature text NOT NULL,
      claim_token uuid NOT NULL,
      claim_expires_at timestamptz NOT NULL,
      PRIMARY KEY (sim_job_id, point_content_signature)
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_hub_receipts ON COMMIT DROP AS
      SELECT source.sim_job_id,source.point_content_signature FROM progressive_worker_evidence_attempts source
      JOIN fixture_jobs fixture ON fixture.id=source.sim_job_id WHERE fixture.variant='already-delivered' GROUP BY 1,2`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_delivery_failures ON COMMIT DROP AS
      SELECT source.sim_job_id,source.point_content_signature,CASE WHEN variant='conflict' THEN 'conflict' ELSE 'retry' END AS state,
        CASE WHEN variant='future-retry' THEN clock_timestamp()+interval '1 day'
          WHEN variant='due-retry' THEN clock_timestamp()-interval '1 day' END AS retry_after
      FROM progressive_worker_evidence_attempts source JOIN fixture_jobs fixture ON fixture.id=source.sim_job_id
      WHERE variant IN ('future-retry','due-retry','conflict') GROUP BY 1,2,variant`);
    const selected = (active: boolean) =>
      transaction.execute(progressiveDeliverySelectionSql(active));
    const expected = (active: boolean) =>
      transaction.execute(sql`
      SELECT source.sim_job_id,source.sequence,source.result_attempt_id,source.point_content_signature,
        report.content_signature AS report_signature,report.report,attempt.result_id,attempt.aoa_deg,attempt.engine_case_slug,attempt.evidence_payload,
        job.request_payload,settings.upstream_base_url,settings.remote_solver_auth_token,settings.remote_solver_registered_id,
        settings.instance_id,settings.instance_name,promise.id AS promise_id
      FROM progressive_worker_evidence_attempts source
      JOIN fixture_jobs fixture ON fixture.id=source.sim_job_id
      JOIN progressive_worker_reports report ON report.sim_job_id=source.sim_job_id AND report.sequence=source.sequence
      JOIN result_attempts attempt ON attempt.id=source.result_attempt_id
      JOIN sim_jobs job ON job.id=source.sim_job_id JOIN sync_sweep_promises promise ON promise.id=job.id
      CROSS JOIN sync_api_settings settings
      WHERE fixture.variant IN ('eligible-active','eligible-cancelled','eligible-expired','due-retry')
        AND NOT EXISTS(SELECT 1 FROM progressive_worker_hub_receipts delivered
          WHERE delivered.sim_job_id=source.sim_job_id AND delivered.point_content_signature=source.point_content_signature)
      ORDER BY CASE WHEN ${active} AND promise.status='active' AND promise."expiresAt">clock_timestamp() THEN 0 ELSE 1 END,
        CASE WHEN fixture.variant='due-retry' THEN 0 ELSE 1 END,
        report.created_at,source.sim_job_id,source.sequence,attempt.aoa_deg,source.result_attempt_id LIMIT 1`);
    for (const active of [true, false]) {
      const rollback = new Error(
        "Rollback isolated complete delivery ordering",
      );
      await expect(
        transaction.transaction(async (nested) => {
          let count = 0;
          while (true) {
            const actual = await nested.execute(
              progressiveDeliverySelectionSql(active),
            );
            expect(actual).toEqual(await expected(active));
            if (!actual.length) break;
            const point = actual[0];
            expect(point.sequence).toBe(1);
            await nested.execute(sql`INSERT INTO progressive_worker_hub_receipts VALUES
            (${point.sim_job_id}::uuid,${point.point_content_signature})`);
            count += 1;
            expect(count).toBeLessThanOrEqual(16);
          }
          expect(count).toBe(16);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
    const claimRollback = new Error("Rollback isolated delivery claim");
    await expect(
      transaction.transaction(async (nested) => {
        const first = await nested.execute(
          progressiveDeliverySelectionSql(
            true,
            "11111111-1111-4111-8111-111111111111",
          ),
        );
        expect(first).toHaveLength(1);
        const [storedClaim] = await nested.execute(
          sql`SELECT claim_token FROM progressive_worker_evidence_delivery_claims
            WHERE sim_job_id=${first[0].sim_job_id}::uuid
              AND point_content_signature=${first[0].point_content_signature}`,
        );
        expect(storedClaim.claim_token).toBe(
          "11111111-1111-4111-8111-111111111111",
        );
        expect(
          await nested.execute(
            progressiveDeliverySelectionSql(
              true,
              "22222222-2222-4222-8222-222222222222",
            ),
          ),
        ).toEqual([]);
        throw claimRollback;
      }),
    ).rejects.toBe(claimRollback);
    const [due] = await transaction.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant='due-retry'`,
    );
    await transaction.execute(sql`UPDATE progressive_worker_reports SET created_at=timestamptz '2020-01-01T00:00:00Z'
      WHERE sim_job_id IN (SELECT id FROM fixture_jobs WHERE variant IN ('eligible-active','eligible-cancelled','eligible-expired'))`);
    for (const active of [true, false])
      expect((await selected(active))[0].sim_job_id).toBe(due.id);
    await transaction.execute(sql`UPDATE progressive_worker_delivery_failures SET retry_after=clock_timestamp()+interval '1 day'
      WHERE sim_job_id=${due.id}::uuid`);
    for (const active of [true, false])
      expect((await selected(active))[0].sim_job_id).not.toBe(due.id);
    await transaction.execute(sql`UPDATE progressive_worker_delivery_failures SET retry_after=clock_timestamp()-interval '1 second'
      WHERE sim_job_id=${due.id}::uuid`);
    await transaction.execute(
      sql`UPDATE sync_sweep_promises SET status='cancelled'`,
    );
    expect(await selected(true)).toEqual(await expected(false));
    for (const statement of [
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true`,
      sql`UPDATE sync_api_settings SET remote_solver_auth_token=''`,
      sql`UPDATE sync_api_settings SET upstream_base_url=NULL`,
      sql`UPDATE sync_api_settings SET remote_solver_registered_id=md5('unregistered')::uuid`,
    ]) {
      const rollback = new Error("Rollback isolated delivery settings");
      await expect(
        transaction.transaction(async (nested) => {
          await nested.execute(statement);
          expect(
            await nested.execute(progressiveDeliverySelectionSql(true)),
          ).toEqual([]);
          expect(
            await nested.execute(progressiveDeliverySelectionSql(false)),
          ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
  });
});
