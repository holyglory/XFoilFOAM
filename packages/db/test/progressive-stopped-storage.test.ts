import {
  fixtureStagingCandidateView,
  useFixtureStagingKeys,
} from "../test-support/staging-candidate-view";
import { afterAll, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createClient, type DB } from "../src/client";
import {
  progressiveStoppedStorageEligible,
  requeueStoppedProgressiveStorage,
} from "../../../apps/sweeper/src/progressive-stopped-storage";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

async function withStoppedStorageFixture(
  run: (connection: DB) => Promise<void>,
) {
  await client.db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await transaction.execute(sql`CREATE TEMP TABLE fixture_jobs ON COMMIT DROP AS SELECT md5(variant)::uuid AS id,variant
      FROM unnest(ARRAY['eligible','active','expired','fulfilled','running','lease','wrong-solver','wrong-upstream','not-remote','unacknowledged',
        'not-stopped','wrong-signature','no-loss','review-conflict','storage-rejected','other-http']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS SELECT 1 AS id,
      md5('owner')::uuid AS remote_solver_registered_id,'https://fixture.invalid'::text AS upstream_base_url,
      'fixture-token'::text AS remote_solver_auth_token,false AS remote_solver_transfer_paused`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS SELECT id,
      CASE WHEN variant='wrong-solver' THEN md5('foreign')::uuid ELSE md5('owner')::uuid END AS registered_solver_id,
      CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END AS source_base_url,
      CASE WHEN variant IN ('active','expired','fulfilled') THEN variant ELSE 'cancelled' END AS status,
      jsonb_build_object('authoritativeLeaseLoss',variant<>'no-loss') AS response_payload FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS SELECT id,id::text AS engine_job_id,
      CASE WHEN variant='running' THEN 'running' ELSE 'failed' END AS status,
      CASE WHEN variant='lease' THEN md5('lease')::uuid END AS ingest_lease_token,
      CASE WHEN variant='lease' THEN clock_timestamp()+interval '1 day' END AS ingest_lease_expires_at,
      jsonb_build_object('remoteSolver',variant<>'not-remote','remoteProgressiveExecution','fixture','syncPromiseId',id::text,
        'upstreamBaseUrl','https://fixture.invalid') AS request_payload FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_submission_intents ON COMMIT DROP AS
      SELECT id AS sim_job_id,'signature'::text AS assignment_signature FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT 1::bigint AS sequence,timestamptz '2026-01-01' AS created_at,id AS sim_job_id,CASE WHEN variant='wrong-signature' THEN 'foreign' ELSE 'signature' END AS assignment_signature,
      CASE WHEN variant<>'not-stopped' THEN id::text END AS stopped_engine_job_id,
      CASE WHEN variant<>'unacknowledged' THEN clock_timestamp() END AS acknowledged_at,'{"result":{}}'::jsonb AS report FROM fixture_jobs`);
    await transaction.execute(fixtureStagingCandidateView);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_delivery_failures ON COMMIT DROP AS SELECT id AS sim_job_id,
      md5(variant) AS point_content_signature,'conflict'::text AS state,1::integer AS attempt_count,NULL::timestamptz AS retry_after,
      CASE WHEN variant='other-http' THEN 500 ELSE 409 END AS last_http_status,
      CASE WHEN variant='storage-rejected' THEN 'Stopped progressive storage delivery failed (409)' ELSE 'Progressive evidence delivery failed (409)' END AS last_error,
      CASE WHEN variant='review-conflict' THEN '["review"]' ELSE '[]' END::jsonb AS remote_conflict_ids,
      clock_timestamp() AS updated_at FROM fixture_jobs`);
    await run(connection);
  });
}

// Observe submitted statements while still executing every query in PostgreSQL.
// The hook changes fixture rows between the two statements without sleeps.
function recordRequeueQueries(
  connection: DB,
  afterProbe?: (rowCount: number) => Promise<void>,
) {
  const queries: string[] = [];
  const db = {
    async execute(query: SQL) {
      queries.push(
        new PgDialect().sqlToQuery(query).sql.replace(/\s+/gu, " ").trim(),
      );
      const rows = await connection.execute(query);
      if (queries.length === 1) await afterProbe?.(rows.length);
      return rows;
    },
  } as unknown as DB;
  return { db, queries };
}

function expectFailureProbe(queries: string[]) {
  expect(queries[0]).toMatch(
    /^SELECT 1 FROM progressive_worker_delivery_failures failure\b/u,
  );
  expect(queries[0]).toMatch(/\bLIMIT 1$/u);
  expect(queries[0].match(/\bFROM\b/gu)).toHaveLength(1);
  expect(queries[0]).not.toMatch(
    /\b(?:JOIN|WITH|UPDATE|EXISTS)\b|progressive_worker_staging_candidates/u,
  );
}

function expectLockedUpdate(queries: string[]) {
  expect(queries).toHaveLength(2);
  expectFailureProbe(queries);
  expect(queries[1]).toMatch(/^WITH candidates AS/u);
  expect(queries[1]).toContain("UPDATE progressive_worker_delivery_failures");
  expect(queries[1]).toContain("FOR UPDATE OF failure SKIP LOCKED");
}

it("retries only authenticated stopped inactive-promise refusals once without changing evidence", async () => {
  await withStoppedStorageFixture(async (connection) => {
    const before =
      await connection.execute(sql`SELECT to_jsonb(job) AS job,to_jsonb(promise) AS promise,to_jsonb(report) AS report
      FROM sim_jobs job JOIN sync_sweep_promises promise USING(id) JOIN progressive_worker_reports report ON report.sim_job_id=job.id ORDER BY job.id`);
    const [eligible] = await connection.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant='eligible'`,
    );
    expect(
      await progressiveStoppedStorageEligible(connection, String(eligible.id)),
    ).toBe(true);
    const ordinary = await connection.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant IN ('active','expired','fulfilled')`,
    );
    for (const row of ordinary)
      expect(
        await progressiveStoppedStorageEligible(connection, String(row.id)),
      ).toBe(false);
    const owners = await connection.execute(
      sql`SELECT id FROM fixture_jobs ORDER BY id`,
    );
    const originalEligibility = [];
    for (const owner of owners)
      originalEligibility.push(
        await progressiveStoppedStorageEligible(connection, String(owner.id)),
      );
    await useFixtureStagingKeys(connection);
    const projectedEligibility = [];
    for (const owner of owners)
      projectedEligibility.push(
        await progressiveStoppedStorageEligible(connection, String(owner.id)),
      );
    expect(projectedEligibility).toEqual(originalEligibility);
    expect(await requeueStoppedProgressiveStorage(connection)).toBe(1);
    expect(await requeueStoppedProgressiveStorage(connection)).toBe(0);
    const retries =
      await connection.execute(sql`SELECT fixture.variant FROM progressive_worker_delivery_failures failure
      JOIN fixture_jobs fixture ON fixture.id=failure.sim_job_id WHERE state='retry'`);
    expect(retries).toEqual([{ variant: "eligible" }]);
    await connection.execute(sql`UPDATE progressive_worker_delivery_failures SET state='conflict',last_error='Stopped progressive storage delivery failed (409)'
      WHERE sim_job_id=${eligible.id}::uuid`);
    expect(await requeueStoppedProgressiveStorage(connection)).toBe(0);
    expect(
      await requeueStoppedProgressiveStorage(connection, {
        retryStoppedStorage: true,
      }),
    ).toBe(2);
    expect(
      await connection.execute(sql`SELECT to_jsonb(job) AS job,to_jsonb(promise) AS promise,to_jsonb(report) AS report
      FROM sim_jobs job JOIN sync_sweep_promises promise USING(id) JOIN progressive_worker_reports report ON report.sim_job_id=job.id ORDER BY job.id`),
    ).toEqual(before);
  });
});

it("submits only the cheap probe for empty pools and 438 nonmatching review conflicts", async () => {
  await withStoppedStorageFixture(async (connection) => {
    await connection.execute(
      sql`DELETE FROM progressive_worker_delivery_failures`,
    );
    const empty = recordRequeueQueries(connection);
    expect(await requeueStoppedProgressiveStorage(empty.db)).toBe(0);
    expect(empty.queries).toHaveLength(1);
    expectFailureProbe(empty.queries);

    // Otherwise eligible owners, real conflict-id shapes, and 64-character
    // point signatures ensure this exercises the transport predicate itself.
    await connection.execute(sql`INSERT INTO progressive_worker_delivery_failures
      (sim_job_id,point_content_signature,state,attempt_count,retry_after,last_http_status,last_error,remote_conflict_ids,updated_at)
      SELECT job.id,repeat(md5('point:'||n),2),'conflict',1+n%6,NULL,409,
        'Progressive evidence delivery failed (409)',jsonb_build_array(md5('review:'||n)::uuid),clock_timestamp()
      FROM fixture_jobs job CROSS JOIN generate_series(1,438) n WHERE job.variant='eligible'`);
    const snapshot = () =>
      connection.execute(
        sql`SELECT * FROM progressive_worker_delivery_failures ORDER BY point_content_signature`,
      );
    const before = await snapshot();
    expect(before).toHaveLength(438);
    for (const retryStoppedStorage of [false, true]) {
      for (let poll = 0; poll < 2; poll++) {
        const observed = recordRequeueQueries(connection);
        expect(
          await requeueStoppedProgressiveStorage(observed.db, {
            retryStoppedStorage,
          }),
        ).toBe(0);
        expect(observed.queries).toHaveLength(1);
        expectFailureProbe(observed.queries);
      }
    }
    expect(await snapshot()).toEqual(before);
  });
});

it("requires opt-in for stopped-storage 409s and stops retrying them at five attempts", async () => {
  await withStoppedStorageFixture(async (connection) => {
    await connection.execute(
      sql`DELETE FROM progressive_worker_delivery_failures`,
    );
    await connection.execute(sql`INSERT INTO progressive_worker_delivery_failures
      (sim_job_id,point_content_signature,state,attempt_count,retry_after,last_http_status,last_error,remote_conflict_ids,updated_at)
      SELECT job.id,repeat(md5('storage:'||attempts),2),'conflict',attempts,NULL,409,
        'Stopped progressive storage delivery failed (409)','[]'::jsonb,clock_timestamp()
      FROM fixture_jobs job CROSS JOIN unnest(ARRAY[1,4,5,6]) attempts WHERE job.variant='eligible'`);
    const snapshot = () =>
      connection.execute(
        sql`SELECT * FROM progressive_worker_delivery_failures ORDER BY attempt_count`,
      );
    const before = await snapshot();
    for (const options of [undefined, { retryStoppedStorage: false }]) {
      const observed = recordRequeueQueries(connection);
      expect(await requeueStoppedProgressiveStorage(observed.db, options)).toBe(
        0,
      );
      expect(observed.queries).toHaveLength(1);
      expectFailureProbe(observed.queries);
    }
    expect(await snapshot()).toEqual(before);

    // The five-attempt cap belongs only to the stopped-storage refusal.
    await connection.execute(sql`INSERT INTO progressive_worker_delivery_failures
      (sim_job_id,point_content_signature,state,attempt_count,retry_after,last_http_status,last_error,remote_conflict_ids,updated_at)
      SELECT id,repeat(md5('ordinary'),2),'conflict',8,NULL,409,
        'Progressive evidence delivery failed (409)','[]'::jsonb,clock_timestamp() FROM fixture_jobs WHERE variant='eligible'`);
    const ordinary = recordRequeueQueries(connection);
    expect(
      await requeueStoppedProgressiveStorage(ordinary.db, {
        retryStoppedStorage: false,
      }),
    ).toBe(1);
    expectLockedUpdate(ordinary.queries);
    const optedIn = recordRequeueQueries(connection);
    expect(
      await requeueStoppedProgressiveStorage(optedIn.db, {
        retryStoppedStorage: true,
      }),
    ).toBe(2);
    expectLockedUpdate(optedIn.queries);
    expect(
      await connection.execute(sql`SELECT attempt_count,state,retry_after IS NOT NULL AS scheduled
      FROM progressive_worker_delivery_failures ORDER BY attempt_count`),
    ).toEqual([
      { attempt_count: 1, state: "retry", scheduled: true },
      { attempt_count: 4, state: "retry", scheduled: true },
      { attempt_count: 5, state: "conflict", scheduled: false },
      { attempt_count: 6, state: "conflict", scheduled: false },
      { attempt_count: 8, state: "retry", scheduled: true },
    ]);
    const after = await snapshot();
    const repeated = recordRequeueQueries(connection);
    expect(
      await requeueStoppedProgressiveStorage(repeated.db, {
        retryStoppedStorage: true,
      }),
    ).toBe(0);
    expect(repeated.queries).toHaveLength(1);
    expectFailureProbe(repeated.queries);
    expect(await snapshot()).toEqual(after);
  });
});

it("finds a candidate arriving after an empty probe on the next poll", async () => {
  await withStoppedStorageFixture(async (connection) => {
    await connection.execute(
      sql`DELETE FROM progressive_worker_delivery_failures`,
    );
    const arriving = recordRequeueQueries(connection, async (rowCount) => {
      expect(rowCount).toBe(0);
      await connection.execute(sql`INSERT INTO progressive_worker_delivery_failures
        (sim_job_id,point_content_signature,state,attempt_count,retry_after,last_http_status,last_error,remote_conflict_ids,updated_at)
        SELECT id,repeat(md5('late-arrival'),2),'conflict',1,NULL,409,
          'Progressive evidence delivery failed (409)','[]'::jsonb,clock_timestamp() FROM fixture_jobs WHERE variant='eligible'`);
    });
    expect(await requeueStoppedProgressiveStorage(arriving.db)).toBe(0);
    expect(arriving.queries).toHaveLength(1);
    expectFailureProbe(arriving.queries);
    expect(
      await connection.execute(
        sql`SELECT state FROM progressive_worker_delivery_failures`,
      ),
    ).toEqual([{ state: "conflict" }]);

    const next = recordRequeueQueries(connection);
    expect(await requeueStoppedProgressiveStorage(next.db)).toBe(1);
    expectLockedUpdate(next.queries);
    expect(
      await connection.execute(sql`SELECT state,retry_after IS NOT NULL AS scheduled
      FROM progressive_worker_delivery_failures`),
    ).toEqual([{ state: "retry", scheduled: true }]);
    const repeated = recordRequeueQueries(connection);
    expect(await requeueStoppedProgressiveStorage(repeated.db)).toBe(0);
    expect(repeated.queries).toHaveLength(1);
    expectFailureProbe(repeated.queries);
  });
});

it.each([
  [
    "failure state",
    sql`UPDATE progressive_worker_delivery_failures SET state='retry',retry_after=clock_timestamp()`,
  ],
  [
    "HTTP status",
    sql`UPDATE progressive_worker_delivery_failures SET last_http_status=503`,
  ],
  [
    "review conflict",
    sql`UPDATE progressive_worker_delivery_failures SET remote_conflict_ids=jsonb_build_array(md5('new-review')::uuid)`,
  ],
  [
    "registered owner",
    sql`UPDATE sync_sweep_promises SET registered_solver_id=md5('foreign')::uuid WHERE id=md5('eligible')::uuid`,
  ],
] as const)(
  "revalidates a changed %s between the probe and locked update",
  async (_name, mutation) => {
    await withStoppedStorageFixture(async (connection) => {
      await connection.execute(
        sql`DELETE FROM progressive_worker_delivery_failures WHERE sim_job_id<>md5('eligible')::uuid`,
      );
      const snapshot = () =>
        connection.execute(sql`SELECT to_jsonb(failure) AS failure,to_jsonb(job) AS job,
      to_jsonb(promise) AS promise,to_jsonb(report) AS report FROM progressive_worker_delivery_failures failure
      JOIN sim_jobs job ON job.id=failure.sim_job_id JOIN sync_sweep_promises promise ON promise.id=job.id
      JOIN progressive_worker_reports report ON report.sim_job_id=job.id`);
      let changed: Awaited<ReturnType<typeof snapshot>> | undefined;
      const observed = recordRequeueQueries(connection, async (rowCount) => {
        expect(rowCount).toBe(1);
        await connection.execute(mutation);
        changed = await snapshot();
      });
      expect(await requeueStoppedProgressiveStorage(observed.db)).toBe(0);
      expectLockedUpdate(observed.queries);
      expect(changed).toBeDefined();
      expect(await snapshot()).toEqual(changed);
    });
  },
);

it("revalidates the stopped-storage retry cap after a positive probe", async () => {
  await withStoppedStorageFixture(async (connection) => {
    await connection.execute(
      sql`DELETE FROM progressive_worker_delivery_failures WHERE sim_job_id<>md5('eligible')::uuid`,
    );
    await connection.execute(sql`UPDATE progressive_worker_delivery_failures
      SET last_error='Stopped progressive storage delivery failed (409)',attempt_count=4`);
    let changed: unknown;
    const observed = recordRequeueQueries(connection, async (rowCount) => {
      expect(rowCount).toBe(1);
      await connection.execute(
        sql`UPDATE progressive_worker_delivery_failures SET attempt_count=5`,
      );
      changed = await connection.execute(
        sql`SELECT * FROM progressive_worker_delivery_failures`,
      );
    });
    expect(
      await requeueStoppedProgressiveStorage(observed.db, {
        retryStoppedStorage: true,
      }),
    ).toBe(0);
    expectLockedUpdate(observed.queries);
    expect(changed).toBeDefined();
    expect(
      await connection.execute(
        sql`SELECT * FROM progressive_worker_delivery_failures`,
      ),
    ).toEqual(changed);
  });
});

it("keeps genuine candidates bounded to the current 16-row page", async () => {
  await withStoppedStorageFixture(async (connection) => {
    await connection.execute(
      sql`DELETE FROM progressive_worker_delivery_failures`,
    );
    await connection.execute(sql`INSERT INTO progressive_worker_delivery_failures
      (sim_job_id,point_content_signature,state,attempt_count,retry_after,last_http_status,last_error,remote_conflict_ids,updated_at)
      SELECT job.id,repeat(md5('page:'||n),2),'conflict',1,NULL,409,
        'Progressive evidence delivery failed (409)','[]'::jsonb,timestamptz '2026-01-01'+n*interval '1 second'
      FROM fixture_jobs job CROSS JOIN generate_series(1,17) n WHERE job.variant='eligible'`);
    const first = recordRequeueQueries(connection);
    expect(await requeueStoppedProgressiveStorage(first.db)).toBe(16);
    expectLockedUpdate(first.queries);
    expect(
      await connection.execute(sql`SELECT n,state,attempt_count,retry_after IS NOT NULL AS scheduled
      FROM progressive_worker_delivery_failures CROSS JOIN generate_series(1,17) n
      WHERE point_content_signature=repeat(md5('page:'||n),2) ORDER BY n`),
    ).toEqual(
      Array.from({ length: 17 }, (_, index) => ({
        n: index + 1,
        state: index < 16 ? "retry" : "conflict",
        attempt_count: 1,
        scheduled: index < 16,
      })),
    );
    const second = recordRequeueQueries(connection);
    expect(await requeueStoppedProgressiveStorage(second.db)).toBe(1);
    expectLockedUpdate(second.queries);
    const drained = recordRequeueQueries(connection);
    expect(await requeueStoppedProgressiveStorage(drained.db)).toBe(0);
    expect(drained.queries).toHaveLength(1);
    expectFailureProbe(drained.queries);
    expect(
      await connection.execute(sql`SELECT count(*)::int AS count FROM progressive_worker_delivery_failures
      WHERE state='retry' AND attempt_count=1 AND retry_after IS NOT NULL`),
    ).toEqual([{ count: 17 }]);
  });
});
