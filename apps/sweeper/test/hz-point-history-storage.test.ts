import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  copyFile,
  chmod,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createClient, type DB } from "@aerodb/db/client";
import {
  loadSolverHistorySource,
  registerSolverHistoryArchive,
} from "@aerodb/db/solver-history-storage";
import { loadResultHistorySource } from "@aerodb/db/result-history-storage";
import {
  scanHzHistories,
  prepareHzHistory,
  type HistorySelection,
} from "@aerodb/db/hz-point-history-storage";
import {
  encodePointHistory,
  pointHistoryKey,
  pointHistoryCrc32c,
  readPointHistoryWorkingCopy,
  type PointHistoryIdentity,
} from "@aerodb/core/point-history-working-copy";
import { readStoredForceHistory } from "../../api/src/solver-history-reader";
import { readStoredResultHistories } from "../../api/src/result-history-reader";
import { verifyHzApiHistory } from "../../api/src/hz-point-history-verify-cli";
import {
  handleHzHistoryRequest,
  hzHistoryWorkerFailure,
} from "../src/hz-point-history-custody-cli";
import {
  migrateHzHistory,
  type HistoryRelayServices,
  type HistoryRelayReceipt,
} from "../src/hz-point-history-relay";

// Existing history suites cover the original GCS path. This integration drives
// the credentialless controller/worker/API boundaries with the real driver and
// both versioned migrations in an isolated schema, not new scientific data.
const client = createClient({ max: 1 }),
  db = client.db,
  namespace = `hz_histories_${randomUUID().replaceAll("-", "")}`;
let root: string, instance: string;
const oldRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE,
  oldMedia = process.env.MEDIA_DIR;
beforeAll(async () => {
  await db.execute(sql.raw(`CREATE SCHEMA ${namespace}`));
  await db.execute(sql.raw(`SET search_path TO ${namespace},public`));
  for (const statement of [
    "CREATE TABLE sim_jobs(id uuid PRIMARY KEY,status text,ingest_lease_token uuid,ingest_lease_expires_at timestamptz)",
    "CREATE TABLE results(id uuid PRIMARY KEY,current_result_attempt_id uuid,sim_job_id uuid,steady_history jsonb,frame_track jsonb,cl float8,cd float8,cm float8,status text)",
    "CREATE TABLE result_attempts(id uuid PRIMARY KEY,result_id uuid REFERENCES results(id),status text,sim_job_id uuid,evidence_payload jsonb,UNIQUE(id,result_id))",
    'CREATE TABLE force_history(id uuid PRIMARY KEY,result_id uuid NOT NULL REFERENCES results(id),result_attempt_id uuid,t jsonb NOT NULL,cl jsonb NOT NULL,cd jsonb NOT NULL,cm jsonb,cl_mean float8,cl_rms float8,cd_mean float8,cd_rms float8,strouhal float8,shedding_freq_hz float8,sample_count integer,"createdAt" timestamptz DEFAULT now())',
    "CREATE TABLE sync_api_settings(id integer PRIMARY KEY,instance_id uuid)",
  ])
    await db.execute(sql.raw(statement));
  for (const file of [
    "0204_solver_history_storage.sql",
    "0206_result_history_storage.sql",
  ]) {
    const text = await readFile(
      new URL(`../../../packages/db/migrations/${file}`, import.meta.url),
      "utf8",
    );
    for (const statement of text
      .split("--> statement-breakpoint")
      .filter((value) => value.trim()))
      await db.execute(sql.raw(statement));
  }
  instance = randomUUID();
  await db.execute(
    sql`INSERT INTO sync_api_settings VALUES (1,${instance}::uuid)`,
  );
  root = await mkdtemp(join(tmpdir(), "hz-history-journey-"));
  process.env.MEDIA_DIR = root;
  process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (oldRole === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
  else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = oldRole;
  if (oldMedia === undefined) delete process.env.MEDIA_DIR;
  else process.env.MEDIA_DIR = oldMedia;
  await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`));
  await client.sql.end();
});
async function fixture(r = randomUUID()) {
  const a = randomUUID(),
    h = randomUUID(),
    j = randomUUID();
  await db.execute(
    sql`INSERT INTO sim_jobs VALUES (${j}::uuid,'done',NULL,NULL)`,
  );
  const history = JSON.stringify({
    units: { time: "s", cl: "1", cd: "1", cm: "1" },
    sample_interval: 0.01,
    t: Array.from({ length: 1024 }, (_, i) => i / 100),
    cl: Array.from({ length: 1024 }, () => 0.63),
    cd: Array.from({ length: 1024 }, () => 0.014),
    unknown: "preserved",
  });
  await db.execute(
    sql`INSERT INTO results(id,current_result_attempt_id,sim_job_id,cl,cd,cm,status,steady_history,frame_track) VALUES (${r}::uuid,${a}::uuid,${j}::uuid,0.41,0.021,-0.01,'done',${history}::jsonb,${history}::jsonb)`,
  );
  await db.execute(
    sql`INSERT INTO result_attempts VALUES (${a}::uuid,${r}::uuid,'done',${j}::uuid,'{"cl":0.63,"cd":0.014,"cm":-0.025,"valid_for_polar":false}'::jsonb)`,
  );
  await db.execute(
    sql`INSERT INTO force_history(id,result_id,result_attempt_id,t,cl,cd,cm,sample_count,cl_mean,cd_mean) VALUES (${h}::uuid,${r}::uuid,${a}::uuid,'[0,0.100000000000000000001,900719925474099312345]'::jsonb,'[0.62,0.63,0.64]'::jsonb,'[0.013,0.014,0.015]'::jsonb,'[-0.02,-0.025,-0.03]'::jsonb,3,0.63,0.014)`,
  );
  return { r, a, h, j };
}
function transport() {
  const objects = new Map<string, Buffer>();
  let puts = 0,
    reads = 0;
  const services: HistoryRelayServices = {
    prepare: (selection) =>
      handleHzHistoryRequest(db, {
        operation: "prepare",
        selection,
      }) as ReturnType<HistoryRelayServices["prepare"]>,
    put: async (source, sourceInstance) => {
      puts++;
      const { stored, ...encoded } = encodePointHistory(sourceInstance, source);
      const identity = {
        ...encoded,
        ...source,
        sourceInstance,
        bucket: "history-fixture",
        objectKey: pointHistoryKey(
          sourceInstance,
          source,
          encoded.storedSha256,
        ),
        generation: "18446744073709551615",
        crc32c: pointHistoryCrc32c(stored),
        verifiedAt: new Date(),
      } as PointHistoryIdentity;
      objects.set(identity.objectKey, stored);
      return { identity, packed: stored };
    },
    read: async (identity) => {
      reads++;
      const bytes = objects.get(identity.objectKey);
      if (!bytes) throw new Error("Missing exact generation");
      return bytes;
    },
    store: (identity, packed) =>
      handleHzHistoryRequest(db, {
        operation: "store",
        identity,
        packed: packed.toString("base64"),
      }),
    apiRead: (identity, throughCatalog) =>
      verifyHzApiHistory(db, identity, throughCatalog),
    apply: (identity, apiReadback, hubReadbackAt) =>
      handleHzHistoryRequest(db, {
        operation: "apply",
        identity,
        apiReadback,
        hubReadbackAt,
      }) as ReturnType<HistoryRelayServices["apply"]>,
  };
  return {
    services,
    objects,
    get puts() {
      return puts;
    },
    get reads() {
      return reads;
    },
  };
}
it("runs the real operator commands over fixture SSH, resumes a rejected API read, then verifies the catalog generation", async () => {
  const f = await fixture("90000000-0000-4000-8000-000000000001");
  const fixtureRoot = await mkdtemp(join(root, "operator-"));
  const shim = join(fixtureRoot, "ssh"),
    progress = join(fixtureRoot, "progress"),
    block = join(fixtureRoot, "hide-volume");
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  await copyFile(
    new URL("./fixtures/hz-history-ssh.sh", import.meta.url),
    shim,
  );
  await chmod(shim, 0o700);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("search_path", namespace + ",public");
  const env = {
    ...process.env,
    PATH: fixtureRoot + ":" + process.env.PATH,
    DATABASE_URL: url.toString(),
    HISTORY_TEST_STATE: fixtureRoot,
    HISTORY_TEST_NODE: process.execPath,
    HISTORY_TEST_REPO: repo,
    HZ_SSH_HOST: "fixture-hz",
    HZ_SWEEPER_CONTAINER: "hz-worker",
    HZ_API_CONTAINER: "hz-api",
    HUB_SSH_HOST: "fixture-hub",
    HUB_SWEEPER_CONTAINER: "hub-worker",
    HUB_EVIDENCE_BUCKET: "fixture-bucket",
    HUB_SERVICE_ACCOUNT: "canonical@fixture-project.iam.gserviceaccount.com",
  };
  const cli = (mode: string, ...flags: string[]) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "apps/sweeper/src/hz-point-history-storage-cli.ts",
        mode,
        "--kind=steady_history",
        "--id=" + f.r,
        "--limit=1",
        "--directory=" + progress,
        ...flags,
      ],
      { cwd: repo, env, timeout: 120000, maxBuffer: 65536 },
    );
  const candidates = JSON.parse((await cli("candidates")).stdout);
  expect(candidates.items).toEqual([{ kind: "steady_history", id: f.r }]);
  const counts = JSON.parse((await cli("status")).stdout);
  expect(counts.counts.steady_inline_rows).toBe("1");
  const plan = await cli("pass");
  expect(JSON.parse(plan.stdout)).toMatchObject({ mode: "plan", id: f.r });
  await writeFile(block, "fixture volume unavailable");
  await expect(cli("pass", "--readers-ready", "--apply")).rejects.toMatchObject(
    { code: 1 },
  );
  const state = JSON.parse(
    await readFile(join(progress, "checkpoint.json"), "utf8"),
  );
  expect(state.pending).toMatch(/\.archive\.json$/);
  expect(state.queue).toEqual([{ kind: "steady_history", id: f.r }]);
  const [kept] = await db.execute(
    sql`SELECT steady_history,steady_history_archive_id FROM results WHERE id=${f.r}::uuid`,
  );
  expect(kept.steady_history_archive_id).toBeNull();
  await rm(block);
  const baseline = await readFile(join(progress, "checkpoint.json"), "utf8");
  const saved = JSON.parse(baseline);
  const receipt = await readFile(join(progress, saved.pending), "utf8");
  const recreating = join(fixtureRoot, "recreating");
  await writeFile(recreating, "container undergoing restart");
  try {
    const failure = await cli("pass", "--readers-ready", "--apply").then(
      () => null,
      (e: { stderr: string }) => JSON.parse(e.stderr.trim()),
    );
    expect(failure).toMatchObject({
      operation: "container_restart",
      category: "transport",
      retryable: true,
    });
    expect(await readFile(join(progress, "checkpoint.json"), "utf8")).toBe(
      baseline,
    );
    expect(await readFile(join(progress, saved.pending), "utf8")).toBe(receipt);
  } finally {
    await rm(recreating);
  }
  const blocker = createClient({ max: 1 });
  try {
    await blocker.sql.begin(async (held) => {
      await held.unsafe(
        `SELECT id FROM "${namespace}".sim_jobs WHERE id=$1::uuid FOR UPDATE`,
        [f.j],
      );
      const failure = await cli("pass", "--readers-ready", "--apply").then(
        () => null,
        (error: { stderr: string }) => JSON.parse(error.stderr.trim()),
      );
      expect(failure).toMatchObject({
        operation: "worker_apply_lock_timeout",
        category: "database_busy",
        retryable: true,
      });
      expect(await readFile(join(progress, "checkpoint.json"), "utf8")).toBe(
        baseline,
      );
      expect(await readFile(join(progress, saved.pending), "utf8")).toBe(
        receipt,
      );
      const [stillWarm] = await db.execute(
        sql`SELECT steady_history,steady_history_archive_id FROM results WHERE id=${f.r}::uuid`,
      );
      expect(stillWarm.steady_history_archive_id).toBeNull();
      expect(stillWarm.steady_history).toEqual(kept.steady_history);
    });
  } finally {
    await blocker.sql.end({ timeout: 1 });
  }
  const permanent = hzHistoryWorkerFailure("apply", {
    cause: { code: "23514", message: "sensitive path and private data" },
  });
  expect({
    operation: permanent.operation,
    retryable: permanent.retryable,
    category: permanent.category,
  }).toEqual({
    operation: "worker_apply_23514",
    retryable: false,
    category: "integrity",
  });
  expect(permanent.message).not.toContain("sensitive");
  const migrated = await cli("migrate", "--readers-ready", "--apply");
  expect(JSON.parse(migrated.stdout.trim().split("\n").at(-1)!)).toMatchObject({
    complete: true,
    offloaded: 1,
  });
  const verified = JSON.parse((await cli("verify")).stdout);
  expect(verified).toMatchObject({
    verified: true,
    selection: { id: f.r },
    api: { throughCatalog: true },
    archive: { generation: "18446744073709551615" },
  });
  expect((await readdir(progress)).some((name) => name.endsWith(".gz"))).toBe(
    false,
  );
  // Complete an unpinned bulk sweep, then insert a newly eligible row
  // below its old high UUID. Starting watch must revisit that key.
  const automatic = join(fixtureRoot, "automatic");
  const sweep = (mode: string) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "apps/sweeper/src/hz-point-history-storage-cli.ts",
        mode,
        "--kind=steady_history",
        "--limit=1",
        "--max-passes=1",
        "--directory=" + automatic,
        "--readers-ready",
        "--apply",
      ],
      { cwd: repo, env, timeout: 120000, maxBuffer: 65536 },
    );
  expect(
    JSON.parse((await sweep("migrate")).stdout.trim().split("\n").at(-1)!),
  ).toMatchObject({ complete: true, offloaded: 0 });
  const added = await fixture("10000000-0000-4000-8000-000000000001");
  const watched = await sweep("watch");
  const events = watched.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events).toContainEqual(
    expect.objectContaining({ event: "history", id: added.r, offloaded: true }),
  );
  expect(events.at(-1)).toMatchObject({
    stopped: "pass_limit",
    offloaded: 1,
    cycle: 2,
  });
}, 180000);

it("offloads all three kinds through normal HZ readers preserving PG precision, scalars, units and immutable evidence", async () => {
  const f = await fixture(),
    cloud = transport();
  const [attemptBefore] = await db.execute(
    sql`SELECT to_jsonb(a.*) AS row FROM result_attempts a WHERE id=${f.a}::uuid`,
  );
  for (const selection of [
    { kind: "force_history", id: f.h },
    { kind: "steady_history", id: f.r },
    { kind: "frame_track", id: f.r },
  ] as HistorySelection[]) {
    const source = (await prepareHzHistory(db, selection)).source!;
    let receipt: HistoryRelayReceipt | undefined;
    const applied = await migrateHzHistory(
      selection,
      instance,
      cloud.services,
      async (value) => {
        receipt = value;
      },
    );
    expect(applied).toMatchObject({
      offloaded: true,
      replayed: false,
      inlineRetained: false,
      sourceBytes: Buffer.byteLength(source.payloadText),
    });
    if ("attemptArchive" in applied) throw Error("Expected a standalone point-history archive");
    expect(
      (await readPointHistoryWorkingCopy(applied.identity)).payloadText,
    ).toBe(source.payloadText);
    const replay = await migrateHzHistory(
      selection,
      instance,
      cloud.services,
      async () => {},
      receipt,
    );
    expect(replay).toMatchObject({
      offloaded: false,
      replayed: true,
      inlineRetained: false,
      sourceBytes: 0,
    });
    if (selection.kind === "force_history") {
      const [stored] = await db.execute(
        sql`SELECT id,result_id AS "resultId",result_attempt_id AS "resultAttemptId",history_archive_id AS "historyArchiveId",t,cl,cd,cm,sample_count AS "sampleCount" FROM force_history WHERE id=${f.h}::uuid`,
      );
      expect([stored.t, stored.cl, stored.cd, stored.cm]).toEqual([
        null,
        null,
        null,
        null,
      ]);
      const hydrated = await readStoredForceHistory(db, stored as never);
      expect(hydrated).toMatchObject({
        sampleCount: 3,
        cl: [0.62, 0.63, 0.64],
        cd: [0.013, 0.014, 0.015],
        cm: [-0.02, -0.025, -0.03],
      });
      expect(source.payloadText).toContain("0.100000000000000000001");
      expect(source.payloadText).toContain("900719925474099312345");
    }
  }
  const [raw] = await db.execute(
    sql`SELECT id,cl,cd,cm,steady_history AS "steadyHistory",frame_track AS "frameTrack",steady_history_archive_id AS "steadyHistoryArchiveId",frame_track_archive_id AS "frameTrackArchiveId" FROM results WHERE id=${f.r}::uuid`,
  );
  expect(raw).toMatchObject({ cl: 0.41, cd: 0.021, cm: -0.01 });
  const hydrated = await readStoredResultHistories(db, raw as never);
  expect(hydrated).toMatchObject({
    steadyHistory: {
      units: { time: "s" },
      sample_interval: 0.01,
      unknown: "preserved",
    },
    frameTrack: { units: { time: "s" } },
  });
  const [attemptAfter] = await db.execute(
    sql`SELECT to_jsonb(a.*) AS row FROM result_attempts a WHERE id=${f.a}::uuid`,
  );
  expect(attemptAfter).toEqual(attemptBefore);
  expect(cloud.puts).toBe(3);
  expect(cloud.reads).toBeGreaterThan(3);
});
it("retains inline data on failed hub custody, missing API copy, changed source and active ingestion", async () => {
  for (const fault of ["hub", "api", "race", "active"]) {
    const f = await fixture(),
      cloud = transport();
    const original = cloud.services,
      selection: HistorySelection = { kind: "force_history", id: f.h };
    const broken: HistoryRelayServices = {
      ...original,
      read:
        fault === "hub" ? async () => Buffer.from("corrupt") : original.read,
      apiRead:
        fault === "api"
          ? async () => {
              throw new Error("API copy unavailable");
            }
          : original.apiRead,
      apply: async (...args) => {
        if (fault === "race")
          await db.execute(
            sql`UPDATE force_history SET cl='[9,8,7]'::jsonb WHERE id=${f.h}::uuid`,
          );
        if (fault === "active")
          await db.execute(
            sql`UPDATE sim_jobs SET status='running' WHERE id=${f.j}::uuid`,
          );
        return original.apply(...args);
      },
    };
    if (fault === "active")
      expect(
        await migrateHzHistory(selection, instance, broken, async () => {}),
      ).toMatchObject({
        offloaded: false,
        inlineRetained: true,
        reason: "job_or_ingestion_active",
      });
    else
      await expect(
        migrateHzHistory(selection, instance, broken, async () => {}),
      ).rejects.toThrow();
    const [row] = await db.execute(
      sql`SELECT t,cl,history_archive_id FROM force_history WHERE id=${f.h}::uuid`,
    );
    expect(row.history_archive_id).toBeNull();
    expect(Array.isArray(row.t)).toBe(true);
    if (fault === "race") expect(row.cl).toEqual([9, 8, 7]);
  }
});
it("reuses a catalog generation after a crash and advances bounded independent scans", async () => {
  const f = await fixture(),
    cloud = transport(),
    source = await loadSolverHistorySource(db, "force_history", f.h);
  const old = await cloud.services.put(source, instance);
  await registerSolverHistoryArchive(
    db,
    old.identity as Parameters<typeof registerSolverHistoryArchive>[1],
  );
  const prepared = await prepareHzHistory(db, {
    kind: "force_history",
    id: f.h,
  });
  expect(prepared.prior?.generation).toBe(old.identity.generation);
  expect(
    await migrateHzHistory(
      { kind: "force_history", id: f.h },
      instance,
      cloud.services,
      async () => {},
    ),
  ).toMatchObject({ offloaded: true });
  expect(cloud.puts).toBe(1);
  const scan = await scanHzHistories(db, {
    kind: "steady_history",
    after: null,
    high: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    limit: 1,
    maxBytes: 1,
  });
  expect(scan.items.length).toBeLessThanOrEqual(1);
  expect(scan.after).not.toBeNull();
});

it("restores a pre-existing original-instance receipt without changing its owner or requiring upstream fetch", async () => {
  const f = await fixture(),
    cloud = transport(),
    source = await loadSolverHistorySource(db, "force_history", f.h),
    origin = randomUUID();
  const original = await cloud.services.put(source, origin);
  await registerSolverHistoryArchive(
    db,
    original.identity as Parameters<typeof registerSolverHistoryArchive>[1],
  );
  const prepared = await prepareHzHistory(db, {
    kind: "force_history",
    id: f.h,
  });
  expect(prepared.prior?.sourceInstance).toBe(origin);
  const result = await migrateHzHistory(
    { kind: "force_history", id: f.h },
    instance,
    cloud.services,
    async () => {},
  );
  expect(result).toMatchObject({
    offloaded: true,
    identity: {
      sourceInstance: origin,
      generation: original.identity.generation,
    },
  });
  expect(cloud.puts).toBe(1);
});

it("preserves corrupt working bytes and all inline arrays when the retained file cannot be authenticated", async () => {
  const f = await fixture(),
    cloud = transport(),
    selection: HistorySelection = { kind: "force_history", id: f.h };
  const source = await loadSolverHistorySource(db, "force_history", f.h);
  const { identity, packed } = await cloud.services.put(source, instance);
  await cloud.services.store(identity, packed);
  const path = join(
    root,
    "point-histories/v1",
    identity.storedSha256.slice(0, 2),
    identity.storedSha256 + ".json.gz",
  );
  const damaged = Buffer.from(packed);
  damaged[damaged.length - 1] ^= 1;
  await writeFile(path, damaged);
  await expect(
    migrateHzHistory(selection, instance, cloud.services, async () => {}),
  ).rejects.toThrow();
  const [row] = await db.execute(
    sql`SELECT history_archive_id,t FROM force_history WHERE id=${f.h}::uuid`,
  );
  expect(row.history_archive_id).toBeNull();
  expect(row.t).not.toBeNull();
  expect(await readFile(path)).toEqual(damaged);
});

it("finds a steady history beyond a full page of frame-only rows", async () => {
  const after = "00000000-0000-4000-8000-000000000000",
    last = "00000000-0000-4000-8000-000000000033";
  // A per-kind cursor must not stop at, or spend its entire page on, the sibling stream.
  await db.execute(
    sql`INSERT INTO results(id,frame_track) SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'{}'::jsonb FROM generate_series(1,32) n`,
  );
  await db.execute(
    sql`INSERT INTO results(id,steady_history) VALUES (${last}::uuid,jsonb_build_object('samples',(SELECT jsonb_agg(n ORDER BY n) FROM generate_series(1,1800)n)))`,
  );
  expect(
    await scanHzHistories(db, {
      kind: "steady_history",
      after,
      high: last,
      limit: 1,
      maxBytes: 8388608,
    }),
  ).toMatchObject({
    items: [{ kind: "steady_history", id: last }],
    after: last,
    done: true,
  });
});
