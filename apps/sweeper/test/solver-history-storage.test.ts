import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createClient, type DB } from "@aerodb/db/client";
import {
  forceHistoryArchiveForRow, getSolverHistoryArchive, hydrateForceHistory,
  loadSolverHistorySource, offloadForceHistoryArrays, solverHistoryInventory,
  type StoredForceHistory,
} from "@aerodb/db/solver-history-storage";
import {
  compareSolverHistoryRaw, decodeSolverHistory, encodeSolverHistory,
  type SolverHistorySource, type SolverHistoryArchiveIdentity,
} from "@aerodb/core/solver-history-storage";
import { SolverHistoryGcsStore, type SolverHistoryGcsClient } from "@aerodb/core/solver-history-gcs";
import { archiveSolverHistory } from "../src/solver-history-archive";
import { runForceHistoryOffloadPass, runSolverHistoryStorageService } from "../src/solver-history-service";

type MemoryObject = { bytes: Buffer; metadata: Record<string, unknown> };
class MemoryGcs implements SolverHistoryGcsClient {
  readonly objects = new Map<string, MemoryObject>();
  readonly pinnedReads: string[] = [];
  corruptReads = false;
  saveCount = 0;
  beforeRead: (() => Promise<void>) | null = null;
  bucket(bucket: string) {
    return { file: (key: string, options?: { generation: string }) => {
      const name = `${bucket}/${key}`;
      type Interceptor = { request(options: { uri?: unknown; qs?: Record<string, unknown> }): { uri: string; qs: Record<string, unknown>; timeout: number } };
      const interceptors: Interceptor[] = [];
      const generation = () => {
        let request: { uri: string; qs: Record<string, unknown> } = { uri: "fixture-object", qs: { generation: options ? Number(options.generation) : undefined } };
        for (const interceptor of interceptors) request = interceptor.request(request);
        return request.qs.generation == null ? undefined : String(request.qs.generation);
      };
      const object = () => {
        const value = this.objects.get(name);
        if (!value || (options && generation() !== value.metadata.generation))
          throw Object.assign(new Error("generation missing"), { code: 404 });
        return value;
      };
      return {
        interceptors,
        save: async (bytes: Buffer, settings: Parameters<ReturnType<ReturnType<SolverHistoryGcsClient["bucket"]>["file"]>["save"]>[1]) => {
          expect(settings.preconditionOpts.ifGenerationMatch).toBe(0);
          expect(settings.validation).toBe("crc32c");
          if (this.objects.has(name)) throw Object.assign(new Error("exists"), { code: 412 });
          this.saveCount += 1;
          this.objects.set(name, { bytes: Buffer.from(bytes), metadata: {
            ...settings.metadata, generation: String(this.saveCount), size: String(bytes.length), crc32c: "AAAAAA==",
          } });
        },
        getMetadata: async () => [object().metadata] as [{ generation?: string; size?: string; crc32c?: string; contentType?: string; metadata?: Record<string, unknown> }],
        createReadStream: (settings: { validation: "crc32c"; decompress: false }) => {
          expect(settings).toEqual({ validation: "crc32c", decompress: false });
          expect(options?.generation).toBeTruthy();
          this.pinnedReads.push(generation()!);
          const value = object();
          const bytes = this.corruptReads ? Buffer.from("corrupt") : value.bytes;
          const before = this.beforeRead;
          this.beforeRead = null;
          return Readable.from((async function* () { if (before) await before(); yield bytes; })());
        },
      };
    } };
  }
}

const resultId = randomUUID();
const attemptId = randomUUID();
const source: SolverHistorySource = {
  sourceKind: "force_history", sourceId: randomUUID(), resultId, resultAttemptId: attemptId,
  // The exact source deliberately includes precision JS cannot reserialize.
  payloadText: '{"t": [0, 0.100000000000000000001], "cd": [0.02, 0.03], "cl": [0.1, 0.2], "cm": null}',
};

describe("force history immutable object boundary", () => {
  it("leaves bucketless hub/HZ data inline without querying the database or constructing a GCS client", async () => {
    const previous = process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
    delete process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
    try {
      const unused = { execute() { throw new Error("bucketless service queried the DB"); } } as unknown as DB;
      await expect(runSolverHistoryStorageService(unused, new AbortController().signal)).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
      else process.env.AIRFOILFOAM_EVIDENCE_BUCKET = previous;
    }
  });
  it("preserves exact SQL text and requires a complete generation-pinned read", async () => {
    const memory = new MemoryGcs();
    const store = new SolverHistoryGcsStore(memory);
    const pointer = await store.put("evidence", "hub-fixture", source);
    expect((await store.read(pointer)).payloadText).toBe(source.payloadText);
    expect(await store.put("evidence", "hub-fixture", source)).toEqual(pointer);
    expect(memory.saveCount).toBe(1);
    expect(memory.pinnedReads.every((g) => g === pointer.generation)).toBe(true);
    const largeGeneration = "9007199254740993123";
    memory.objects.get(`${pointer.bucket}/${pointer.objectKey}`)!.metadata.generation = largeGeneration;
    expect((await store.read({ ...pointer, generation: largeGeneration })).payloadText).toBe(source.payloadText);
    expect(memory.pinnedReads.at(-1)).toBe(largeGeneration);
    expect(compareSolverHistoryRaw(source, Buffer.from(source.payloadText)).byteIdentical).toBe(true);
    expect(compareSolverHistoryRaw(source, Buffer.from(JSON.stringify(JSON.parse(source.payloadText)))).byteIdentical).toBe(false);
  });
  it("rejects changed bytes, wrong ownership, missing generations and sizes", async () => {
    const memory = new MemoryGcs();
    const store = new SolverHistoryGcsStore(memory);
    const pointer = await store.put("evidence", "hub-fixture", source);
    memory.corruptReads = true;
    await expect(store.read(pointer)).rejects.toThrow(/verification/);
    memory.corruptReads = false;
    await expect(store.read({ ...pointer, generation: "999" })).rejects.toThrow(/generation missing/);
    await expect(store.read({ ...pointer, sourceId: randomUUID() })).rejects.toThrow(/different source/);
    const bytes = encodeSolverHistory("hub-fixture", source).stored;
    expect(() => decodeSolverHistory(bytes, { ...pointer, storedByteSize: pointer.storedByteSize + 1 })).toThrow(/verification/);
  });
});

// New dedicated integration fixture: existing archive tests concern raw CFD
// tar members/report transport, not the force_history row transition. No
// canonical fixture graph or shared application table is mutated by this suite.
describe("PostgreSQL force-history online offload", () => {
  const client = createClient({ max: 1 });
  const namespace = `force_history_storage_${randomUUID().replaceAll("-", "")}`;
  let schemaCreated = false;
  let db: DB;
  beforeAll(async () => {
    db = client.db;
    await db.execute(sql.raw(`CREATE SCHEMA ${namespace}`));
    schemaCreated = true;
    await db.execute(sql.raw(`SET search_path TO ${namespace}, public`));
    for (const statement of [
      "CREATE TABLE results (id uuid PRIMARY KEY, cl float8, cd float8, steady_history jsonb, frame_track jsonb)",
      "CREATE TABLE sim_jobs (id uuid PRIMARY KEY, status text NOT NULL)",
      "CREATE TABLE result_attempts (id uuid PRIMARY KEY, result_id uuid REFERENCES results(id), status text NOT NULL DEFAULT 'done', sim_job_id uuid REFERENCES sim_jobs(id), evidence_payload jsonb, UNIQUE(id,result_id))",
      `CREATE TABLE force_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), result_id uuid NOT NULL REFERENCES results(id), result_attempt_id uuid REFERENCES result_attempts(id),
        t jsonb NOT NULL, cl jsonb NOT NULL, cd jsonb NOT NULL, cm jsonb,
        cl_mean float8, cl_rms float8, cd_mean float8, cd_rms float8, strouhal float8, shedding_freq_hz float8, sample_count int, "createdAt" timestamptz NOT NULL DEFAULT now())`,
    ]) await db.execute(sql.raw(statement));
    const migration = await readFile(new URL("../../../packages/db/migrations/0204_solver_history_storage.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").filter((part) => part.trim()))
      await db.execute(sql.raw(statement));
  });
  afterAll(async () => {
    if (schemaCreated) await client.db.execute(sql.raw(`DROP SCHEMA ${namespace} CASCADE`));
    await client.sql.end();
  });
  async function seed(options: { cm?: number[] | null; jobStatus?: string; rejected?: boolean } = {}) {
    const r = randomUUID(), a = randomUUID(), h = randomUUID(), j = randomUUID();
    const payload = { force_history: { t: [0, 1, 2, 3], cl: [0.1, 0.2, 0.3, 0.4], cd: [0.02, 0.03, 0.04, 0.05], cm: options.cm ?? null }, valid_for_polar: !options.rejected };
    await db.execute(sql`INSERT INTO results(id, cl, cd, frame_track) VALUES (${r}::uuid, 0.25, 0.035, '{"fixture":"retained"}'::jsonb)`);
    await db.execute(sql`INSERT INTO sim_jobs(id,status) VALUES (${j}::uuid, ${options.jobStatus ?? "done"})`);
    await db.execute(sql`INSERT INTO result_attempts(id,result_id,sim_job_id,evidence_payload) VALUES (${a}::uuid,${r}::uuid,${j}::uuid,${JSON.stringify(payload)}::jsonb)`);
    await db.execute(sql`INSERT INTO force_history(id,result_id,result_attempt_id,t,cl,cd,cm,cl_mean,cd_mean,sample_count)
      VALUES (${h}::uuid,${r}::uuid,${a}::uuid,'[0,1,2,3]'::jsonb,'[0.1,0.2,0.3,0.4]'::jsonb,'[0.02,0.03,0.04,0.05]'::jsonb,${options.cm == null ? null : JSON.stringify(options.cm)}::jsonb,0.25,0.035,4)`);
    return { h, r, a, payload };
  }
  async function row(h: string): Promise<StoredForceHistory> {
    const [value] = await db.execute(sql`SELECT id,result_id AS "resultId",result_attempt_id AS "resultAttemptId",history_archive_id AS "historyArchiveId",t,cl,cd,cm,
      cl_mean AS "clMean",cl_rms AS "clRms",cd_mean AS "cdMean",cd_rms AS "cdRms",strouhal,shedding_freq_hz AS "sheddingFreqHz",sample_count AS "sampleCount","createdAt"
      FROM force_history WHERE id=${h}::uuid`);
    return value as unknown as StoredForceHistory;
  }
  it("removes real inline arrays, retains metadata/attempt evidence and hydrates exact reads/replay", async () => {
    const { h, a, r, payload } = await seed({ rejected: true });
    const memory = new MemoryGcs(), store = new SolverHistoryGcsStore(memory);
    const before = await row(h);
    const original = await loadSolverHistorySource(db, "force_history", h);
    const result = await archiveSolverHistory(db, store, { bucket: "evidence", sourceInstance: "hub", sourceKind: "force_history", sourceId: h });
    expect(result.offloaded).toBe(true);
    expect(result.sourceBytes).toBe(Buffer.byteLength(original.payloadText));
    const stored = await row(h);
    expect([stored.t,stored.cl,stored.cd,stored.cm]).toEqual([null,null,null,null]);
    expect(await hydrateForceHistory(db, store, stored)).toEqual({ ...before, historyArchiveId: result.archive.id });
    expect(await hydrateForceHistory(db, store, stored)).toEqual({ ...before, historyArchiveId: result.archive.id }); // detail then sync replay
    const [attempt] = await db.execute(sql`SELECT evidence_payload FROM result_attempts WHERE id=${a}::uuid`);
    expect(attempt.evidence_payload).toEqual(payload); // includes rejection; no invented accepted polar
    const [point] = await db.execute(sql`SELECT cl,cd,frame_track FROM results WHERE id=${r}::uuid`);
    expect(point).toMatchObject({ cl: 0.25, cd: 0.035, frame_track: { fixture: "retained" } });
    expect((await archiveSolverHistory(db, store, { bucket: "evidence", sourceInstance: "hub", sourceKind: "force_history", sourceId: h })).offloaded).toBe(false);
    expect(memory.saveCount).toBe(1);
    expect((await getSolverHistoryArchive(db, result.archive.id)).id).toBe(result.archive.id);
    const counts = await solverHistoryInventory(db);
    expect(counts.inventory.find((x) => x.sourceKind === "attempt_payload")?.source_count).not.toBe("0");
  });
  it("keeps original arrays on corrupt readback and changed-source races", async () => {
    const { h } = await seed({ cm: [0,0,0,0] });
    const memory = new MemoryGcs(), store = new SolverHistoryGcsStore(memory);
    const before = await row(h);
    memory.corruptReads = true;
    await expect(archiveSolverHistory(db, store, { bucket: "evidence", sourceInstance: "hub", sourceKind: "force_history", sourceId: h })).rejects.toThrow();
    expect(await row(h)).toEqual(before);
    expect(await forceHistoryArchiveForRow(db, h)).toBeNull();
    memory.corruptReads = false;
    memory.beforeRead = async () => { await db.execute(sql`UPDATE force_history SET cl='[9,8,7,6]'::jsonb WHERE id=${h}::uuid`); };
    await expect(archiveSolverHistory(db, store, { bucket: "evidence", sourceInstance: "hub", sourceKind: "force_history", sourceId: h })).rejects.toThrow(/source changed/);
    expect((await row(h)).cl).toEqual([9,8,7,6]);
    expect(await forceHistoryArchiveForRow(db, h)).toBeNull();
  });
  it("preserves legacy result-owned histories and a real cm channel", async () => {
    const { h } = await seed({ cm: [-0.01, -0.02, -0.03, -0.04] });
    await db.execute(sql`UPDATE force_history SET result_attempt_id=NULL WHERE id=${h}::uuid`);
    const before = await row(h);
    const store = new SolverHistoryGcsStore(new MemoryGcs());
    const result = await archiveSolverHistory(db, store, { bucket: "evidence", sourceInstance: "hub", sourceKind: "force_history", sourceId: h });
    expect(result.offloaded).toBe(true);
    expect(result.archive.resultAttemptId).toBeNull();
    expect(await hydrateForceHistory(db, store, await row(h))).toEqual({ ...before, historyArchiveId: result.archive.id });
  });
  it("makes ingester replays safe and refuses wrong-owner or unverified removal", async () => {
    const { h } = await seed();
    const memory = new MemoryGcs(), store = new SolverHistoryGcsStore(memory);
    const before = await row(h);
    const archived = await archiveSolverHistory(db, store, { bucket: "evidence", sourceInstance: "hub", sourceKind: "force_history", sourceId: h });
    memory.corruptReads = true;
    await expect(hydrateForceHistory(db, store, await row(h))).rejects.toThrow();
    memory.corruptReads = false;
    await db.execute(sql`UPDATE force_history SET t=${JSON.stringify(before.t)}::jsonb,cl=${JSON.stringify(before.cl)}::jsonb,cd=${JSON.stringify(before.cd)}::jsonb,cm=NULL WHERE id=${h}::uuid`);
    expect(await forceHistoryArchiveForRow(db, h)).toBeNull();
    expect(await hydrateForceHistory(db, store, before)).toEqual(before);
    await expect(db.execute(sql`UPDATE force_history SET t=NULL,cl=NULL,cd=NULL WHERE id=${h}::uuid`)).rejects.toThrow();
    expect((await row(h)).t).toEqual(before.t);
    expect((await offloadForceHistoryArrays(db, { ...archived.archive, resultId: randomUUID() })).offloaded).toBe(false);
    expect((await archiveSolverHistory(db, store, { bucket: "evidence", sourceInstance: "hub", sourceKind: "force_history", sourceId: h })).offloaded).toBe(true);
    expect(memory.saveCount).toBe(1);
  });
  it("keeps changed arrays when an ingest wins after archive registration but before the final removal", async () => {
    const { h } = await seed();
    const realStore = new SolverHistoryGcsStore(new MemoryGcs());
    let reads = 0;
    const store = {
      put: realStore.put.bind(realStore),
      read: async (identity: SolverHistoryArchiveIdentity) => {
        const restored = await realStore.read(identity);
        if (++reads === 2) await db.execute(sql`UPDATE force_history SET cd='[0.09,0.08,0.07,0.06]'::jsonb WHERE id=${h}::uuid`);
        return restored;
      },
    };
    const result = await archiveSolverHistory(db, store, { bucket: "evidence", sourceInstance: "hub", sourceKind: "force_history", sourceId: h });
    expect(result.offloaded).toBe(false);
    expect(result.inlineRetained).toBe(true);
    expect((await row(h)).cd).toEqual([0.09,0.08,0.07,0.06]);
    expect(await forceHistoryArchiveForRow(db, h)).toBeNull();
  });
  it("bounds automatic batches and preserves running jobs", async () => {
    const active = await seed({ jobStatus: "running" });
    const one = await seed(), two = await seed();
    const store = new SolverHistoryGcsStore(new MemoryGcs());
    const pass = await runForceHistoryOffloadPass(db, store, { bucket: "evidence", sourceInstance: "hub", maxRows: 1 });
    expect(pass.processed).toBeLessThanOrEqual(1);
    expect(pass.offloaded).toBeLessThanOrEqual(1);
    expect((await row(active.h)).t).not.toBeNull();
    expect([await row(one.h),await row(two.h)].filter((r) => r.t === null).length).toBeLessThanOrEqual(1);
  });
});
