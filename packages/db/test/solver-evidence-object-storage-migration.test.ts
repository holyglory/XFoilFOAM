import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareReportPayloadReferenceIndexes } from "../src/report-payload-reference-indexes";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { databaseUrl } from "../src/env";
import type { DB } from "../src/client";
import { prepareSolverEvidenceOwnerIndexes } from "../src/solver-evidence-owner-indexes";
import {
  acquireEvidenceArtifactKeyLock,
  acquireEvidenceArtifactKeyLocks,
  acquireResultEvidenceLocks,
} from "../src/result-evidence-lock";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const dbName = `aerodb_evidence_storage_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

const IDS = {
  category: "67000000-0000-0000-0000-000000000001",
  airfoil: "67000000-0000-0000-0000-000000000002",
  medium: "67000000-0000-0000-0000-000000000003",
  bc: "67000000-0000-0000-0000-000000000004",
  resultA: "67000000-0000-0000-0000-000000000005",
  attemptA: "67000000-0000-0000-0000-000000000006",
  bundleA: "67000000-0000-0000-0000-000000000007",
  memberA: "67000000-0000-0000-0000-000000000008",
  resultB: "67000000-0000-0000-0000-000000000009",
  attemptB: "67000000-0000-0000-0000-00000000000a",
  bundleB: "67000000-0000-0000-0000-00000000000b",
  blobA: "67000000-0000-0000-0000-00000000000c",
  blobB: "67000000-0000-0000-0000-00000000000d",
  archiveA: "67000000-0000-0000-0000-00000000000e",
  archiveB: "67000000-0000-0000-0000-00000000000f",
  memberA2: "67000000-0000-0000-0000-000000000010",
} as const;

const OPENCFD_2606_SOLVER_IMPLEMENTATION_ID =
  "2f8bc764-09ae-4ff3-8fd2-260600000001";
const STORED_SHA_A = "c".repeat(64);
const STORED_SHA_B = "d".repeat(64);
const TAR_SHA = "e".repeat(64);

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let through66 = "";
let through67 = "";
let legacyArtifactsBefore: unknown[] = [];

function makeMigrationFolder(upTo: number): string {
  const dir = mkdtempSync(join(tmpdir(), `aerodb-migrations-00${upTo}-`));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= upTo);
  for (const entry of entries) {
    cpSync(join(migrations, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return dir;
}

async function insertBlob(
  id: string,
  key: string,
  generation: string,
  sha256: string,
) {
  if (!client) throw new Error("migration test database is unavailable");
  await client.unsafe(`
    INSERT INTO solver_evidence_blobs
      (id, backend, bucket, object_key, generation, compression, mime_type,
       sha256, byte_size, crc32c, uncompressed_tar_sha256,
       uncompressed_tar_byte_size, "verifiedAt", metadata)
    VALUES
      ('${id}', 'gcs', 'airfoils-pro-storage-bucket', '${key}',
       '${generation}', 'zstd', 'application/zstd', '${sha256}', 4096,
       'ImIEBA==', '${TAR_SHA}', 8192, now(), '{"verifiedBy":"test"}'::jsonb)
  `);
}

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  client = postgres(targetUrl.toString(), { max: 1 });
  through66 = makeMigrationFolder(66);
  through67 = makeMigrationFolder(67);
  await migrate(drizzle(client), { migrationsFolder: through66 });

  await client.unsafe(`
    INSERT INTO categories (id, slug, name, path)
    VALUES ('${IDS.category}', 'evidence-storage', 'Evidence storage', 'evidence-storage');

    INSERT INTO airfoils (id, slug, name, category_id, source, points)
    VALUES (
      '${IDS.airfoil}', 'evidence-storage-foil', 'Evidence storage foil',
      '${IDS.category}', 'test-coordinates',
      '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb
    );

    INSERT INTO mediums
      (id, slug, name, phase, density, viscosity_model,
       constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity)
    VALUES
      ('${IDS.medium}', 'evidence-storage-air', 'Evidence storage air', 'gas',
       1.225, 'constant', 0.00001789, 0.00001789, 0.000014604);

    INSERT INTO boundary_conditions (id, slug, name, medium_id, reynolds)
    VALUES
      ('${IDS.bc}', 'evidence-storage-bc', 'Evidence storage BC',
       '${IDS.medium}', 100000);

    INSERT INTO results
      (id, airfoil_id, bc_id, aoa_deg, status, source, regime,
       method_key, solver_implementation_id)
    VALUES
      ('${IDS.resultA}', '${IDS.airfoil}', '${IDS.bc}', 0, 'done', 'solved',
       'rans', 'openfoam.rans', '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}'),
      ('${IDS.resultB}', '${IDS.airfoil}', '${IDS.bc}', 1, 'done', 'solved',
       'rans', 'openfoam.rans', '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}');

    INSERT INTO result_attempts
      (id, result_id, airfoil_id, bc_id, aoa_deg, status, source, regime,
       method_key, solver_implementation_id)
    VALUES
      ('${IDS.attemptA}', '${IDS.resultA}', '${IDS.airfoil}', '${IDS.bc}', 0,
       'done', 'solved', 'rans', 'openfoam.rans',
       '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}'),
      ('${IDS.attemptB}', '${IDS.resultB}', '${IDS.airfoil}', '${IDS.bc}', 1,
       'done', 'solved', 'rans', 'openfoam.rans',
       '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}');

    INSERT INTO solver_evidence_artifacts
      (id, result_id, result_attempt_id, airfoil_id, aoa_deg, kind, field,
       role, storage_key, mime_type, sha256, byte_size, metadata, method_key,
       solver_implementation_id)
    VALUES
      ('${IDS.bundleA}', '${IDS.resultA}', '${IDS.attemptA}', '${IDS.airfoil}',
       0, 'openfoam_bundle', NULL, 'raw-evidence',
       'legacy/a/openfoam-evidence.tar.gz', 'application/gzip',
       '${"a".repeat(64)}', 6000, '{"legacy":true}'::jsonb,
       'openfoam.rans', '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}'),
      ('${IDS.memberA}', '${IDS.resultA}', '${IDS.attemptA}', '${IDS.airfoil}',
       0, 'vtk_window', 'velocity', 'mean', 'legacy/a/VTK/0/U.vtu',
       'application/vnd.vtk', '${"b".repeat(64)}', 3000,
       '{"legacy":true}'::jsonb, 'openfoam.rans',
       '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}'),
      ('${IDS.memberA2}', '${IDS.resultA}', '${IDS.attemptA}', '${IDS.airfoil}',
       0, 'log', NULL, 'solver-log', 'legacy/a/log.simpleFoam', 'text/plain',
       '${"1".repeat(64)}', 2000, '{"legacy":true}'::jsonb,
       'openfoam.rans', '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}'),
      ('${IDS.bundleB}', '${IDS.resultB}', '${IDS.attemptB}', '${IDS.airfoil}',
       1, 'openfoam_bundle', NULL, 'raw-evidence',
       'legacy/b/openfoam-evidence.tar.gz', 'application/gzip',
       '${"f".repeat(64)}', 7000, '{"legacy":true}'::jsonb,
       'openfoam.rans', '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}');
  `);

  legacyArtifactsBefore = await client`
    SELECT id::text, result_id::text, result_attempt_id::text, kind::text,
           field, role, storage_key, mime_type, sha256, byte_size::text,
           metadata, method_key, solver_implementation_id::text,
           "createdAt"::text
    FROM solver_evidence_artifacts
    ORDER BY id
  `;

  await migrate(drizzle(client), { migrationsFolder: through67 });
});

afterAll(async () => {
  await client?.end();
  if (admin) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
  if (through66) rmSync(through66, { recursive: true, force: true });
  if (through67) rmSync(through67, { recursive: true, force: true });
});

describe("artifact advisory lock transactions", () => {
  it("acquires reversed contenders in the same backend order before result locks and releases on rollback", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const inspector = client;
    const blockerClient = postgres(targetUrl.toString(), { max: 1 });
    const batchClient = postgres(targetUrl.toString(), { max: 1 });
    const contenderClient = postgres(targetUrl.toString(), { max: 1 });
    const first = { storageKey: `${dbName}/ä`, sha256: "a".repeat(64) };
    const last = { storageKey: `${dbName}/Z:🚀`, sha256: "BC".repeat(32) };
    expect(
      `${first.storageKey}\0${first.sha256}`.localeCompare(
        `${last.storageKey}\0${last.sha256}`,
      ),
    ).toBeLessThan(0);
    const identity = (key: typeof first) =>
      `evidence-artifact:${key.storageKey.length}:${key.storageKey}:${key.sha256.toLowerCase()}`;
    const locks = async (backendPid: number) => inspector`
      WITH expected(name, key) AS (VALUES
        ('first', hashtextextended(${identity(first)}, 0)),
        ('last', hashtextextended(${identity(last)}, 0)),
        ('result', hashtextextended(${`result-evidence:${IDS.resultA}`}, 0))
      )
      SELECT expected.name, observed.granted
      FROM expected JOIN pg_locks observed ON observed.locktype = 'advisory'
        AND observed.objsubid = 1 AND observed.pid = ${backendPid}
        AND observed.classid::bigint = ((expected.key >> 32) & 4294967295)
        AND observed.objid::bigint = (expected.key & 4294967295)
      ORDER BY expected.name
    `;
    let releaseBlocker!: () => void;
    let signalBlocker!: () => void;
    let releaseBatch!: () => void;
    let signalBatch!: (backendPid: number) => void;
    let signalContender!: (backendPid: number) => void;
    let signalAcquired!: () => void;
    const holdBlocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerReady = new Promise<void>((resolve) => {
      signalBlocker = resolve;
    });
    const holdBatch = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const batchReady = new Promise<number>((resolve) => {
      signalBatch = resolve;
    });
    const contenderReady = new Promise<number>((resolve) => {
      signalContender = resolve;
    });
    const batchAcquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const rollback = new Error("Rollback ordered artifact locks");
    let blocker: Promise<unknown> | undefined;
    let batch: Promise<unknown> | undefined;
    let contender: Promise<unknown> | undefined;
    try {
      blocker = drizzle(blockerClient)
        .transaction(async (transaction) => {
          await acquireEvidenceArtifactKeyLock(
            transaction as unknown as DB,
            last.storageKey,
            last.sha256.toLowerCase(),
          );
          signalBlocker();
          await holdBlocker;
        })
        .catch((error: unknown) => error);
      const blockerOutcome = await Promise.race([blockerReady, blocker]);
      if (blockerOutcome instanceof Error) throw blockerOutcome;
      batch = drizzle(batchClient)
        .transaction(async (transaction) => {
          await transaction.execute(drizzleSql`SET LOCAL lock_timeout = '10s'`);
          const [backend] = await transaction.execute(
            drizzleSql`SELECT pg_backend_pid() AS pid`,
          );
          signalBatch(Number(backend.pid));
          const connection = transaction as unknown as DB;
          await acquireEvidenceArtifactKeyLocks(connection, [last, first]);
          await acquireResultEvidenceLocks(connection, [IDS.resultA]);
          signalAcquired();
          await holdBatch;
          throw rollback;
        })
        .catch((error: unknown) => error);
      const batchPid = await Promise.race([batchReady, batch]);
      if (typeof batchPid !== "number") throw batchPid;
      await vi.waitFor(
        async () => {
          expect(await locks(batchPid)).toEqual([
            { name: "first", granted: true },
            { name: "last", granted: false },
          ]);
        },
        { timeout: 3000, interval: 20 },
      );
      contender = drizzle(contenderClient)
        .transaction(async (transaction) => {
          await transaction.execute(drizzleSql`SET LOCAL lock_timeout = '10s'`);
          const [backend] = await transaction.execute(
            drizzleSql`SELECT pg_backend_pid() AS pid`,
          );
          signalContender(Number(backend.pid));
          const connection = transaction as unknown as DB;
          await acquireEvidenceArtifactKeyLocks(connection, [first, last]);
          await acquireResultEvidenceLocks(connection, [IDS.resultA]);
          expect(await locks(Number(backend.pid))).toEqual([
            { name: "first", granted: true },
            { name: "last", granted: true },
            { name: "result", granted: true },
          ]);
        })
        .catch((error: unknown) => error);
      const contenderPid = await Promise.race([contenderReady, contender]);
      if (typeof contenderPid !== "number") throw contenderPid;
      await vi.waitFor(
        async () => {
          expect(await locks(contenderPid)).toEqual([
            { name: "first", granted: false },
          ]);
        },
        { timeout: 3000, interval: 20 },
      );
      releaseBlocker();
      expect(await blocker).toBeUndefined();
      const acquiredOutcome = await Promise.race([batchAcquired, batch]);
      if (acquiredOutcome instanceof Error) throw acquiredOutcome;
      expect(await locks(batchPid)).toEqual([
        { name: "first", granted: true },
        { name: "last", granted: true },
        { name: "result", granted: true },
      ]);
      expect(await locks(contenderPid)).toEqual([
        { name: "first", granted: false },
      ]);
      releaseBatch();
      expect(await batch).toBe(rollback);
      expect(await contender).toBeUndefined();
      expect(await locks(batchPid)).toEqual([]);
      expect(await locks(contenderPid)).toEqual([]);
    } finally {
      releaseBlocker();
      releaseBatch();
      await Promise.allSettled([blocker, batch, contender]);
      await Promise.all([
        blockerClient.end(),
        batchClient.end(),
        contenderClient.end(),
      ]);
    }
  }, 15_000);

  it("preserves length-prefixed identities, case collisions, deduplication and empty bounded batches", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const inspector = client;
    const holderClient = postgres(targetUrl.toString(), { max: 1 });
    const keys = [
      { storageKey: `${dbName}:left:right`, sha256: "tail" },
      { storageKey: `${dbName}:left`, sha256: "right:tail" },
      { storageKey: `${dbName}/🛩`, sha256: "AB".repeat(32) },
      ...Array.from({ length: 62 }, (_, index) => ({
        storageKey: `${dbName}/batch/${String(index).padStart(2, "0")}`,
        sha256: "c".repeat(64),
      })),
    ];
    const identities = keys.map(
      (key) =>
        `evidence-artifact:${key.storageKey.length}:${key.storageKey}:${key.sha256.toLowerCase()}`,
    );
    expect(`${keys[0].storageKey}:${keys[0].sha256}`).toBe(
      `${keys[1].storageKey}:${keys[1].sha256}`,
    );
    expect(identities[0]).not.toBe(identities[1]);
    const batches: number[] = [];
    holderClient.options.debug = (_connection, query, parameters) => {
      if (query.includes("pg_advisory_xact_lock"))
        batches.push(
          parameters.filter(
            (value) =>
              typeof value === "string" &&
              value.startsWith("evidence-artifact:"),
          ).length,
        );
    };
    let release!: () => void;
    let signalHeld!: (backendPid: number) => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<number>((resolve) => {
      signalHeld = resolve;
    });
    let holder: Promise<unknown> | undefined;
    try {
      holder = drizzle(holderClient)
        .transaction(async (transaction) => {
          const connection = transaction as unknown as DB;
          await acquireEvidenceArtifactKeyLocks(connection, []);
          expect(batches).toEqual([]);
          await acquireEvidenceArtifactKeyLocks(connection, [
            ...[...keys].reverse(),
            keys[0],
            { ...keys[2], sha256: keys[2].sha256.toLowerCase() },
          ]);
          expect(batches).toEqual([64, 2]);
          const [backend] = await transaction.execute(
            drizzleSql`SELECT pg_backend_pid() AS pid`,
          );
          signalHeld(Number(backend.pid));
          await hold;
        })
        .catch((error: unknown) => error);
      const backendPid = await Promise.race([held, holder]);
      if (typeof backendPid !== "number") throw backendPid;
      const [count] =
        await inspector`SELECT count(*)::integer AS count FROM pg_locks
        WHERE pid=${backendPid} AND locktype='advisory' AND objsubid=1 AND granted`;
      expect(count.count).toBe(65);
      await inspector.begin(async (transaction) => {
        const [probe] =
          await transaction`SELECT bool_and(NOT pg_try_advisory_xact_lock(hashtextextended(identity.value, 0))) AS blocked
          FROM jsonb_array_elements_text(${JSON.stringify(identities)}::jsonb) identity(value)`;
        expect(probe.blocked).toBe(true);
      });
      release();
      expect(await holder).toBeUndefined();
      await inspector.begin(async (transaction) => {
        const [probe] =
          await transaction`SELECT bool_and(pg_try_advisory_xact_lock(hashtextextended(identity.value, 0))) AS released
          FROM jsonb_array_elements_text(${JSON.stringify(identities)}::jsonb) identity(value)`;
        expect(probe.released).toBe(true);
      });
    } finally {
      release();
      await Promise.allSettled([holder]);
      await holderClient.end();
    }
  }, 15_000);
});

it("prepares 0222 online and preserves explicit owners across cancellation, retry and migration", async () => {
  const name = dbName + "_owners";
  const url = new URL(targetUrl);
  url.pathname = "/" + name;
  const prior = makeMigrationFolder(221);
  const current = makeMigrationFolder(222);
  await admin!.unsafe(`CREATE DATABASE "${name}"`);
  const db = postgres(url.toString(), { max: 5, connection: { application_name: "evidence-owner-index-test" } });
  const job = randomUUID(), otherJob = randomUUID(), engine = randomUUID(), otherEngine = randomUUID();
  const simIndex = "solver_evidence_artifacts_sim_job_idx", engineIndex = "solver_evidence_artifacts_engine_job_idx";
  const owners = () => db`SELECT storage_key FROM solver_evidence_artifacts
    WHERE sim_job_id=${job}::uuid OR engine_job_id=${engine} ORDER BY storage_key`;
  const journal = () => db`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
  try {
    await migrate(drizzle(db), { migrationsFolder: prior });
    await db`INSERT INTO categories (id,slug,name,path) VALUES (${IDS.category},'owner-index','Owner index','owner-index')`;
    await db`INSERT INTO airfoils (id,slug,name,category_id,source,points)
      VALUES (${IDS.airfoil},'owner-index','Owner index',${IDS.category},'test-coordinates','[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]')`;
    await db`INSERT INTO sim_jobs (id,engine_job_id,airfoil_id,bc_ids,job_kind,reference_chord_m,wave,status,total_cases,completed_cases,request_payload)
      VALUES (${job},${engine},${IDS.airfoil},'[]','targeted',1,1,'done',0,0,'{}'),
             (${otherJob},${otherEngine},${IDS.airfoil},'[]','targeted',1,1,'done',0,0,'{}')`;
    await db`INSERT INTO solver_evidence_artifacts
      (sim_job_id,engine_job_id,airfoil_id,kind,storage_key,mime_type,sha256,byte_size)
      SELECT owner, native, ${IDS.airfoil}::uuid, 'log', key, 'text/plain', repeat('a',64), 1
      FROM (VALUES (${job}::uuid,NULL::text,'sim'), (NULL,${engine},'native'),
        (${job}::uuid,${engine},'both'), (${otherJob}::uuid,${engine},'other-sim'),
        (${otherJob}::uuid,${otherEngine},'unrelated')) AS a(owner,native,key)`;
    await db`INSERT INTO mediums (id,slug,name,phase,density,viscosity_model,
      constant_dynamic_viscosity,dynamic_viscosity,kinematic_viscosity)
      VALUES (${IDS.medium},'owner-index-air','Owner index air','gas',1.225,'constant',0.00001789,0.00001789,0.000014604)`;
    await db`INSERT INTO boundary_conditions(id,slug,name,medium_id,reynolds)
      VALUES (${IDS.bc},'owner-index-bc','Owner index BC',${IDS.medium},100000)`;
    await db`INSERT INTO results(id,airfoil_id,bc_id,sim_job_id,engine_job_id,aoa_deg,status,source)
      VALUES (${IDS.resultB},${IDS.airfoil},${IDS.bc},${otherJob},${otherEngine},0,'done','solved')`;
    await db`INSERT INTO solver_evidence_artifacts
      (result_id,sim_job_id,engine_job_id,airfoil_id,kind,storage_key,mime_type,sha256,byte_size)
      VALUES (${IDS.resultB},${otherJob},${engine},${IDS.airfoil},'log','other-result','text/plain',repeat('b',64),1)`;
    const baseline = await owners();
    expect(baseline.map(r => r.storage_key)).toEqual(["both", "native", "other-result", "other-sim", "sim"]);
    expect(await db`SELECT a.id FROM solver_evidence_artifacts a JOIN results r ON r.id=a.result_id
      WHERE r.sim_job_id=${job} OR r.engine_job_id=${engine}`).toHaveLength(0);
    const beforeJournal = await journal();
    const migration = readFileSync(join(migrations,"0222_solver_evidence_artifact_owner_indexes.sql"), "utf8");
    await expect(db.unsafe(migration)).rejects.toThrow(/Prepare populated evidence tables/);

    // A same-named object with the wrong key must survive operator retries.
    await db.unsafe(`CREATE INDEX ${simIndex} ON solver_evidence_artifacts(airfoil_id)`);
    await expect(prepareSolverEvidenceOwnerIndexes(db)).rejects.toThrow(/differs/);
    await expect(db.unsafe(migration)).rejects.toThrow(/Catalog identity/);
    expect((await db`SELECT pg_get_indexdef(${simIndex}::regclass) AS def`)[0].def).toContain("(airfoil_id)");
    await db.unsafe("DROP INDEX " + simIndex);

    const writer = await db.reserve();
    await writer.unsafe("BEGIN");
    let build: Promise<unknown> | undefined;
    try {
      await writer`UPDATE solver_evidence_artifacts SET role=role WHERE storage_key='both'`;
      build = prepareSolverEvidenceOwnerIndexes(db).catch(error => error);
      let builder: number | undefined;
      for (let i = 0; i < 200 && builder === undefined; i++) {
        const [entry] = await db`SELECT p.pid FROM pg_stat_progress_create_index p JOIN pg_stat_activity a ON a.pid=p.pid
          JOIN pg_index i ON i.indexrelid=p.index_relid WHERE p.datname=current_database()
          AND a.application_name='evidence-owner-index-test' AND p.relid='public.solver_evidence_artifacts'::regclass
          AND p.index_relid=to_regclass(${"public." + simIndex}) AND NOT i.indisvalid`;
        builder = entry?.pid;
        if (builder === undefined) await delay(25);
      }
      expect(builder).toBeDefined();
      await db.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout='1s'");
        expect(await tx`UPDATE solver_evidence_artifacts SET role=role WHERE storage_key='native' RETURNING id`).toHaveLength(1);
      });
      expect((await db`SELECT pg_cancel_backend(${builder!}) AS cancelled`)[0].cancelled).toBe(true);
    } finally {
      await writer.unsafe("ROLLBACK");
      writer.release();
    }
    expect(await build).toMatchObject({ code: "57014" });
    expect((await db`SELECT indisvalid FROM pg_index WHERE indexrelid=${simIndex}::regclass`)[0].indisvalid).toBe(false);
    expect((await prepareSolverEvidenceOwnerIndexes(db)).indexes).toEqual([
      { name: simIndex, action: "rebuilt" }, { name: engineIndex, action: "created" },
    ]);
    expect((await prepareSolverEvidenceOwnerIndexes(db)).indexes.map(i => i.action)).toEqual(["existing","existing"]);
    expect(await journal()).toEqual(beforeJournal);
    const migrator = postgres(url.toString(), { max: 1, connection: { lock_timeout: "1s" } });
    try {
      await db.begin(async tx => {
        await tx`UPDATE solver_evidence_artifacts SET role=role WHERE storage_key='native'`;
        await migrate(drizzle(migrator), { migrationsFolder: current });
      });
    } finally {
      await migrator.end();
    }
    expect((await journal()).length).toBe(beforeJournal.length + 1);
    expect(await owners()).toEqual(baseline);
  } finally {
    await db.end();
    await admin!.unsafe(`DROP DATABASE "${name}"`);
    rmSync(prior, { recursive: true, force: true });
    rmSync(current, { recursive: true, force: true });
  }
}, 120_000);

describe("0067 solver evidence object storage migration", () => {
  it("leaves every legacy artifact row unchanged and creates no invented archive", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const artifactsAfter = await client`
      SELECT id::text, result_id::text, result_attempt_id::text, kind::text,
             field, role, storage_key, mime_type, sha256, byte_size::text,
             metadata, method_key, solver_implementation_id::text,
             "createdAt"::text
      FROM solver_evidence_artifacts
      ORDER BY id
    `;
    expect(artifactsAfter).toEqual(legacyArtifactsBefore);
    const [counts] = await client<
      Array<{ blobs: number; archives: number; members: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM solver_evidence_blobs) AS blobs,
        (SELECT count(*)::int FROM solver_evidence_archives) AS archives,
        (SELECT count(*)::int FROM solver_evidence_artifact_members) AS members
    `;
    expect(counts).toEqual({ blobs: 0, archives: 0, members: 0 });
  });

  it("stores one verified GCS zstd blob and rejects malformed or duplicate physical identity", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await insertBlob(
      IDS.blobA,
      `sha256/${STORED_SHA_A}/evidence.tar.zst`,
      "1780000000000001",
      STORED_SHA_A,
    );
    const [blob] = await client<
      Array<{
        backend: string;
        compression: string;
        crc32c: string;
        tarSha: string;
        metadata: Record<string, unknown>;
      }>
    >`
      SELECT backend::text, compression::text, crc32c,
             uncompressed_tar_sha256 AS "tarSha", metadata
      FROM solver_evidence_blobs WHERE id = ${IDS.blobA}
    `;
    expect(blob).toEqual({
      backend: "gcs",
      compression: "zstd",
      crc32c: "ImIEBA==",
      tarSha: TAR_SHA,
      metadata: { verifiedBy: "test" },
    });

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_blobs
          (backend, bucket, object_key, generation, compression, mime_type,
           sha256, byte_size, crc32c, uncompressed_tar_sha256,
           uncompressed_tar_byte_size, "verifiedAt")
        VALUES ('volume', 'not-valid-for-volume', 'bad.tar.zst', '1', 'zstd',
                'application/zstd', '${STORED_SHA_B}', 1, 'ImIEBA==',
                '${TAR_SHA}', 1, now())
      `),
    ).rejects.toThrow(/backend_shape/);

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_blobs
          (backend, bucket, object_key, generation, compression, mime_type,
           sha256, byte_size, crc32c, uncompressed_tar_sha256,
           uncompressed_tar_byte_size, "verifiedAt")
        VALUES ('gcs', 'airfoils-pro-storage-bucket', 'bad-sha.tar.zst', '2',
                'zstd', 'application/zstd', 'ABC', 1, 'ImIEBA==',
                '${TAR_SHA}', 1, now())
      `),
    ).rejects.toThrow(/sha256_check/);

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_blobs
          (backend, bucket, object_key, generation, compression, mime_type,
           sha256, byte_size, crc32c, uncompressed_tar_sha256,
           uncompressed_tar_byte_size, "verifiedAt")
        SELECT backend, bucket, object_key, generation, compression, mime_type,
               '${STORED_SHA_B}', byte_size, crc32c, uncompressed_tar_sha256,
               uncompressed_tar_byte_size, "verifiedAt"
        FROM solver_evidence_blobs WHERE id = '${IDS.blobA}'
      `),
    ).rejects.toThrow(/gcs_identity/);

    await expect(
      client.unsafe(`
        UPDATE solver_evidence_blobs SET metadata = '{"changed":true}'::jsonb
        WHERE id = '${IDS.blobA}'
      `),
    ).rejects.toThrow(/immutable/);
  });

  it("enforces exact attempt/source ownership and only one current archive", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await insertBlob(
      IDS.blobB,
      `sha256/${STORED_SHA_B}/evidence.tar.zst`,
      "1780000000000002",
      STORED_SHA_B,
    );
    await client.unsafe(`
      INSERT INTO solver_evidence_archives
        (id, result_id, result_attempt_id, source_artifact_id, blob_id)
      VALUES
        ('${IDS.archiveA}', '${IDS.resultA}', '${IDS.attemptA}',
         '${IDS.bundleA}', '${IDS.blobA}')
    `);

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_archives
          (result_id, result_attempt_id, source_artifact_id, blob_id)
        VALUES ('${IDS.resultA}', '${IDS.attemptA}', '${IDS.bundleA}',
                '${IDS.blobB}')
      `),
    ).rejects.toThrow(/current_attempt/);

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_archives
          (result_id, result_attempt_id, source_artifact_id, blob_id,
           state, "supersededAt")
        VALUES ('${IDS.resultA}', '${IDS.attemptA}', '${IDS.bundleB}',
                '${IDS.blobB}', 'superseded', now())
      `),
    ).rejects.toThrow(/exact owned bundle artifact/);

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_archives
          (result_id, result_attempt_id, source_artifact_id, blob_id,
           state, "supersededAt")
        VALUES ('${IDS.resultA}', '${IDS.attemptB}', '${IDS.bundleB}',
                '${IDS.blobB}', 'superseded', now())
      `),
    ).rejects.toThrow(/exact owned bundle artifact/);

    await client.unsafe(`
      UPDATE solver_evidence_archives
      SET state = 'superseded', "supersededAt" = now()
      WHERE id = '${IDS.archiveA}';
      INSERT INTO solver_evidence_archives
        (id, result_id, result_attempt_id, source_artifact_id, blob_id)
      VALUES
        ('${IDS.archiveB}', '${IDS.resultA}', '${IDS.attemptA}',
         '${IDS.bundleA}', '${IDS.blobB}');
      UPDATE solver_evidence_archives
      SET superseded_by_archive_id = '${IDS.archiveB}'
      WHERE id = '${IDS.archiveA}';
    `);
    const archives = await client<
      Array<{ id: string; state: string; successor: string | null }>
    >`
      SELECT id::text, state::text,
             superseded_by_archive_id::text AS successor
      FROM solver_evidence_archives ORDER BY id
    `;
    expect(archives).toEqual([
      { id: IDS.archiveA, state: "superseded", successor: IDS.archiveB },
      { id: IDS.archiveB, state: "current", successor: null },
    ]);
    await expect(
      client.unsafe(`
        UPDATE solver_evidence_archives
        SET state = 'current', "supersededAt" = NULL,
            superseded_by_archive_id = NULL
        WHERE id = '${IDS.archiveA}'
      `),
    ).rejects.toThrow(/cannot become current|immutable/);
  });

  it("maps logical artifacts to safe archive members without cross-attempt leakage", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await client.unsafe(`
      INSERT INTO solver_evidence_artifact_members
        (archive_id, artifact_id, member_path)
      VALUES
        ('${IDS.archiveB}', '${IDS.memberA}', 'evidence/VTK/0/U.vtu')
    `);
    const [member] = await client<
      Array<{
        memberPath: string;
        artifactStorageKey: string;
        archiveObjectKey: string;
        solverImplementationId: string;
      }>
    >`
      SELECT member.member_path AS "memberPath",
             artifact.storage_key AS "artifactStorageKey",
             blob.object_key AS "archiveObjectKey",
             source.solver_implementation_id::text AS "solverImplementationId"
      FROM solver_evidence_artifact_members member
      JOIN solver_evidence_archives archive ON archive.id = member.archive_id
      JOIN solver_evidence_blobs blob ON blob.id = archive.blob_id
      JOIN solver_evidence_artifacts artifact ON artifact.id = member.artifact_id
      JOIN solver_evidence_artifacts source ON source.id = archive.source_artifact_id
      WHERE member.archive_id = ${IDS.archiveB}
    `;
    expect(member).toEqual({
      memberPath: "evidence/VTK/0/U.vtu",
      artifactStorageKey: "legacy/a/VTK/0/U.vtu",
      archiveObjectKey: `sha256/${STORED_SHA_B}/evidence.tar.zst`,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    });

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_artifact_members
          (archive_id, artifact_id, member_path)
        VALUES ('${IDS.archiveB}', '${IDS.bundleB}', 'foreign/bundle.tar.gz')
      `),
    ).rejects.toThrow(/same exact result attempt/);
    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_artifact_members
          (archive_id, artifact_id, member_path)
        VALUES ('${IDS.archiveB}', '${IDS.memberA2}', '../solver.log')
      `),
    ).rejects.toThrow(/path_check/);

    await expect(
      client.unsafe(`
        UPDATE solver_evidence_artifacts
        SET sha256 = '${"2".repeat(64)}'
        WHERE id = '${IDS.memberA}'
      `),
    ).rejects.toThrow(/linked solver evidence artifacts are immutable/);
    await expect(
      client.unsafe(`
        UPDATE solver_evidence_artifacts
        SET storage_key = 'rewritten/source.tar.zst'
        WHERE id = '${IDS.bundleA}'
      `),
    ).rejects.toThrow(/linked solver evidence artifacts are immutable/);
  });
});

it("normal migrate prepares 0223 online, recovers an interrupted build and preserves real FK protection", async () => {
  const name = dbName + "_payloads",
    url = new URL(targetUrl);
  url.pathname = "/" + name;
  const prior = makeMigrationFolder(222),
    job = randomUUID();
  await admin!.unsafe(`CREATE DATABASE "${name}"`);
  const db = postgres(url.toString(), {
    max: 5,
    connection: { application_name: "payload-index-fixture" },
  });
  const worker = "progressive_worker_reports_result_payload_hash_idx",
    remote = "progressive_remote_reports_result_payload_hash_idx";
  const normal = () =>
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", resolve(here, "../src/migrate.ts")],
      {
        cwd: resolve(here, "../../.."),
        env: { ...process.env, DATABASE_URL: url.toString() },
        timeout: 90_000,
      },
    );
  const countJournal = async () =>
    Number(
      (await db`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)[0].n,
    );
  try {
    await migrate(drizzle(db), { migrationsFolder: prior });
    const n = await countJournal();
    await db`INSERT INTO categories(id,slug,name,path) VALUES(${IDS.category},'payload-fk-test','Payload FK','payload-fk-test')`;
    await db`INSERT INTO airfoils(id,slug,name,category_id,source,points) VALUES(${IDS.airfoil},'payload-fk-test','Payload FK',${IDS.category},'test-coordinates','[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]')`;
    await db`INSERT INTO sim_jobs(id,engine_job_id,airfoil_id,bc_ids,job_kind,reference_chord_m,wave,status,total_cases,completed_cases,request_payload)
      VALUES(${job}::uuid,${job},${IDS.airfoil},'[]','targeted',1,1,'done',0,0,'{}')`;
    const [{ hash }] =
      await db`SELECT store_progressive_report_result('{"state":"failed","polars":[]}'::jsonb) AS hash`;
    await db`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,result_payload_hash)
      SELECT ${job}::uuid,i,encode(sha256(convert_to(i::text,'UTF8')),'hex'),
      jsonb_build_object('version',1,'executionId',${job}::text,'sequence',i,'result',CASE WHEN i=1 THEN '{"state":"failed"}'::jsonb ELSE 'null'::jsonb END),
      CASE WHEN i=1 THEN ${hash}::text END FROM generate_series(1,4096) i`;
    await db.unsafe("ANALYZE progressive_worker_reports");
    const identity = async () =>
      (
        await db`SELECT content_signature,resolve_progressive_report(report,result_payload_hash)::text AS original
      FROM progressive_worker_reports WHERE sim_job_id=${job} AND sequence=1`
      )[0];
    const before = await identity();
    await expect(
      db.unsafe(
        readFileSync(
          join(migrations, "0223_report_payload_reference_indexes.sql"),
          "utf8",
        ),
      ),
    ).rejects.toThrow(/prepare/i);
    await db.unsafe(
      `CREATE INDEX ${worker} ON progressive_worker_reports(sequence)`,
    );
    await expect(prepareReportPayloadReferenceIndexes(db)).rejects.toThrow(
      /differs/,
    );
    await db.unsafe("DROP INDEX " + worker);
    const writer = await db.reserve();
    let building: Promise<unknown> | undefined;
    try {
      await writer.unsafe("BEGIN");
      await writer`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp() WHERE sim_job_id=${job} AND sequence=2`;
      building = db
        .unsafe(
          `CREATE INDEX CONCURRENTLY ${worker} ON public.progressive_worker_reports USING btree(result_payload_hash) WHERE result_payload_hash IS NOT NULL`,
        )
        .execute()
        .catch((e) => e);
      let pid: number | undefined;
      for (let i = 0; i < 250 && !pid; i++) {
        const [r] =
          await db`SELECT p.pid FROM pg_stat_progress_create_index p JOIN pg_index i ON i.indexrelid=p.index_relid
          WHERE p.datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND p.index_relid=to_regclass(${"public." + worker}) AND NOT i.indisvalid`;
        pid = r?.pid;
        if (!pid) await delay(20);
      }
      expect(pid).toBeDefined();
      await expect(prepareReportPayloadReferenceIndexes(db)).rejects.toThrow(
        /still active/,
      );
      await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL lock_timeout='1s'");
        expect(
          await tx`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp()
        WHERE sim_job_id=${job} AND sequence=3 RETURNING sequence`,
        ).toHaveLength(1);
      });
      expect((await db`SELECT pg_cancel_backend(${pid!}) AS ok`)[0].ok).toBe(
        true,
      );
    } finally {
      await writer.unsafe("ROLLBACK");
      writer.release();
    }
    expect(await building).toMatchObject({ code: "57014" });
    expect(
      (
        await db`SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass(${"public." + worker})`
      )[0].indisvalid,
    ).toBe(false);
    expect(await countJournal()).toBe(n);
    await normal();
    const journalAfter = await countJournal();
    expect(journalAfter).toBeGreaterThan(n);
    expect(
      await db`SELECT FROM drizzle.__drizzle_migrations WHERE created_at=1795363913054`,
    ).toHaveLength(1);
    expect((await prepareReportPayloadReferenceIndexes(db)).indexes).toEqual([
      { name: worker, action: "existing" },
      { name: remote, action: "existing" },
    ]);
    const plan = await db.unsafe(
      `EXPLAIN(FORMAT JSON) SELECT 1 FROM ONLY public.progressive_worker_reports AS x WHERE $1 OPERATOR(pg_catalog.=) x.result_payload_hash FOR KEY SHARE OF x`,
      [hash],
    );
    expect(JSON.stringify(plan)).toContain(worker);
    expect(await identity()).toEqual(before);
    await expect(
      db`DELETE FROM progressive_report_result_payloads WHERE content_hash=${hash}`,
    ).rejects.toThrow(/referenced|foreign key/i);
    expect(await identity()).toEqual(before);
    await normal();
    expect(await countJournal()).toBe(journalAfter);
  } finally {
    await db.end();
    await admin!.unsafe(`DROP DATABASE "${name}"`);
    rmSync(prior, { recursive: true, force: true });
  }
}, 120_000);
