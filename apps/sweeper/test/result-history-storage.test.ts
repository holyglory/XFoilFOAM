import { CRC32C } from "@google-cloud/storage";
import type {
  GcsGenerationInterceptor,
  GcsGenerationRequest,
} from "@aerodb/core/gcs-exact-generation";
import {
  ResultHistoryGcsStore,
  encodeResultHistory,
  decodeResultHistory,
  type ResultHistoryGcsClient,
  type ResultHistorySource,
  type ResultHistoryArchiveStore,
} from "@aerodb/core/result-history-storage";
import { createClient, type DB } from "@aerodb/db/client";
import {
  getResultHistoryArchive,
  hydrateResultHistories,
  loadResultHistorySource,
  resultHistoriesMatch,
  resultHistoryOffloadCandidates,
} from "@aerodb/db/result-history-storage";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archiveResultHistory } from "../src/result-history-archive";
import { runResultHistoryOffloadPass } from "../src/result-history-service";

class MemoryGcs implements ResultHistoryGcsClient {
  objects = new Map<string, { bytes: Buffer; metadata: Record<string, any> }>();
  saveCount = 0;
  readError = false;
  corruptReads = false;
  pinnedReads: string[] = [];
  nextGeneration: string | null = null;
  requests: Array<{ kind: "metadata" | "media"; qs: Record<string, unknown> }> =
    [];
  bucket(bucket: string) {
    return {
      file: (key: string, options?: { generation: string }) => {
        const name = `${bucket}/${key}`;
        const interceptors: GcsGenerationInterceptor[] = [];
        const requestGeneration = (kind: "metadata" | "media") => {
          // Match Storage 7.16: even a string constructor option is converted
          // to Number before the final request interceptors run.
          let request: GcsGenerationRequest = {
            uri: `https://storage.fixture.invalid/${name}`,
            qs: {
              ...(options ? { generation: Number(options.generation) } : {}),
              ...(kind === "media"
                ? { alt: "media" }
                : { fields: "generation,size,crc32c" }),
            },
          };
          for (const interceptor of interceptors)
            request = interceptor.request(request);
          const qs = request.qs ?? {};
          this.requests.push({ kind, qs: { ...qs } });
          return qs.generation;
        };
        const object = (requestedGeneration: unknown) => {
          const stored = this.objects.get(name);
          if (
            !stored ||
            (requestedGeneration !== undefined &&
              String(requestedGeneration) !== stored.metadata.generation)
          )
            throw new Error("Exact result history generation is missing");
          return stored;
        };
        return {
          interceptors,
          save: async (bytes: Buffer, settings: any) => {
            expect(settings.preconditionOpts).toEqual({ ifGenerationMatch: 0 });
            if (this.objects.has(name))
              throw Object.assign(new Error("exists"), { code: 412 });
            const crc = new CRC32C();
            crc.update(bytes);
            this.saveCount++;
            this.objects.set(name, {
              bytes: Buffer.from(bytes),
              metadata: {
                ...settings.metadata,
                generation: this.nextGeneration ?? String(this.saveCount),
                size: String(bytes.length),
                crc32c: crc.toString(),
              },
            });
          },
          getMetadata: async () =>
            [object(requestGeneration("metadata")).metadata] as [
              Record<string, any>,
            ],
          createReadStream: (settings: {
            validation: "crc32c";
            decompress: false;
          }) => {
            expect(settings).toEqual({
              validation: "crc32c",
              decompress: false,
            });
            expect(options?.generation).toBeTruthy();
            const requestedGeneration = requestGeneration("media");
            expect(typeof requestedGeneration).toBe("string");
            this.pinnedReads.push(requestedGeneration as string);
            const bytes = this.corruptReads
              ? Buffer.from("corrupt")
              : object(requestedGeneration).bytes;
            return Readable.from(
              (async function* (lateError: boolean) {
                yield bytes;
                if (lateError) throw new Error("late history stream failure");
              })(this.readError),
            );
          },
        };
      },
    };
  }
}

describe("independent result history object boundary", () => {
  it("pins metadata and media request queries above 2^53 despite SDK constructor coercion", async () => {
    const generation = "18446744073709551615";
    expect(String(Number(generation))).not.toBe(generation);
    const memory = new MemoryGcs();
    memory.nextGeneration = generation;
    const store = new ResultHistoryGcsStore(memory);
    const source: ResultHistorySource = {
      sourceKind: "steady_history",
      resultId: randomUUID(),
      resultAttemptId: randomUUID(),
      payloadText: '{"iterations": [1, 2], "cl": [0.1, 0.2]}',
    };
    const identity = await store.put("history-bucket", "hub-fixture", source);
    expect(identity.generation).toBe(generation);
    const readbackRequests = memory.requests.filter(
      ({ qs }) => qs.generation !== undefined,
    );
    expect(readbackRequests.map(({ kind }) => kind)).toEqual([
      "metadata",
      "media",
    ]);
    memory.requests.length = 0;
    expect((await store.read(identity)).payloadText).toBe(source.payloadText);
    expect(memory.requests.map(({ kind }) => kind)).toEqual([
      "metadata",
      "media",
    ]);
    for (const request of [...readbackRequests, ...memory.requests]) {
      expect(request.qs.generation).toBe(generation);
      expect(typeof request.qs.generation).toBe("string");
      if (request.kind === "metadata")
        expect(request.qs.fields).toBe("generation,size,crc32c");
      else expect(request.qs.alt).toBe("media");
    }
  });

  it.each(["steady_history", "frame_track"] as const)(
    "preserves exact PG numeric text for %s and replays one immutable object",
    async (sourceKind) => {
      const memory = new MemoryGcs(),
        store = new ResultHistoryGcsStore(memory);
      const source: ResultHistorySource = {
        sourceKind,
        resultId: randomUUID(),
        resultAttemptId: randomUUID(),
        payloadText:
          '{"nested": {"history": [0.100000000000000000001, 9007199254740993]}, "stationary": true}',
      };
      const identity = await store.put("history-bucket", "hub-fixture", source);
      expect((await store.read(identity)).payloadText).toBe(source.payloadText);
      expect(
        (await store.put("history-bucket", "hub-fixture", source)).storedSha256,
      ).toBe(identity.storedSha256);
      expect(memory.saveCount).toBe(1);
      expect(
        memory.pinnedReads.every(
          (generation) => generation === identity.generation,
        ),
      ).toBe(true);
      expect(() =>
        decodeResultHistory(encodeResultHistory("hub-fixture", source).stored, {
          ...identity,
          resultId: randomUUID(),
        }),
      ).toThrow();
      memory.readError = true;
      await expect(store.read(identity)).rejects.toThrow(/late history stream/);
      memory.readError = false;
      memory.corruptReads = true;
      await expect(store.read(identity)).rejects.toThrow(/verification|limit/);
      memory.corruptReads = false;
      await expect(
        store.read({ ...identity, generation: "999" }),
      ).rejects.toThrow(/generation/);
    },
  );
});

// Dedicated namespace because 0206 owns canonical result columns, not the
// force agent's 0204 fixture. No application table or global setting is edited.
describe("canonical result history representation", () => {
  const client = createClient({ max: 1 });
  const namespace = `result_history_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let db: DB;
  beforeAll(async () => {
    db = client.db;
    await db.execute(sql.raw(`CREATE SCHEMA ${namespace}`));
    created = true;
    await db.execute(sql.raw(`SET search_path TO ${namespace}, public`));
    for (const statement of [
      "CREATE TABLE sim_jobs(id uuid PRIMARY KEY,status text NOT NULL,ingest_lease_token uuid,ingest_lease_expires_at timestamptz)",
      "CREATE TABLE results(id uuid PRIMARY KEY, current_result_attempt_id uuid,sim_job_id uuid REFERENCES sim_jobs(id),steady_history jsonb,frame_track jsonb,cl float8,cd float8,status text)",
      "CREATE TABLE result_attempts(id uuid PRIMARY KEY,result_id uuid REFERENCES results(id),sim_job_id uuid REFERENCES sim_jobs(id),evidence_payload jsonb,UNIQUE(id,result_id))",
    ])
      await db.execute(sql.raw(statement));
    const migration = await readFile(
      new URL(
        "../../../packages/db/migrations/0206_result_history_storage.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of migration
      .split("--> statement-breakpoint")
      .filter((part) => part.trim()))
      await db.execute(sql.raw(statement));
  });
  afterAll(async () => {
    try {
      if (created)
        await client.db.execute(sql.raw(`DROP SCHEMA ${namespace} CASCADE`));
    } finally {
      await client.sql.end();
    }
  });
  async function seed(small = false, active = false) {
    const id = randomUUID(),
      attempt = randomUUID(),
      job = randomUUID();
    const history = small
      ? { mean_stable: true, window: { start_iter: 1, end_iter: 10 } }
      : {
          mean_stable: true,
          note: id,
          window: { start_iter: 1, end_iter: 1000 },
          nested: {
            coefficients: Array.from({ length: 1500 }, (_, i) => ({
              iteration: i,
              cl: i / 1000,
            })),
          },
        };
    const frames = small
      ? { stationary: true, periods_retained: 3 }
      : {
          stationary: true,
          period_s: 0.1,
          periods_retained: 3,
          drift_frac: 0.001,
          window: { t_start: 1, t_end: 1.3 },
          fields: ["pressure", "velocity_magnitude"],
          frames: Array.from({ length: 120 }, (_, i) => ({
            i,
            t: 1 + i / 400,
            cl: 0.4,
            cd: 0.02,
            cm: 0.001,
          })),
        };
    await db.execute(
      sql`INSERT INTO sim_jobs(id,status) VALUES(${job}::uuid,${active ? "running" : "done"})`,
    );
    await db.execute(sql`INSERT INTO results(id,sim_job_id,steady_history,frame_track,cl,cd,status)
      VALUES(${id}::uuid,${job}::uuid,${JSON.stringify(history)}::jsonb,${JSON.stringify(frames)}::jsonb,0.4,0.02,'done')`);
    await db.execute(sql`INSERT INTO result_attempts(id,result_id,sim_job_id,evidence_payload)
      VALUES(${attempt}::uuid,${id}::uuid,${job}::uuid,${JSON.stringify({ steady_history: history, frame_track: frames })}::jsonb)`);
    await db.execute(
      sql`UPDATE results SET current_result_attempt_id=${attempt}::uuid WHERE id=${id}::uuid`,
    );
    return { id, attempt, job, history, frames };
  }
  async function stored(id: string) {
    return (
      await db.execute(sql`SELECT id,steady_history AS "steadyHistory",frame_track AS "frameTrack",
      steady_history_archive_id AS "steadyHistoryArchiveId",frame_track_archive_id AS "frameTrackArchiveId",
      current_result_attempt_id AS "currentResultAttemptId",cl,cd,status FROM results WHERE id=${id}::uuid`)
    )[0] as unknown as {
      id: string;
      steadyHistory: unknown;
      frameTrack: unknown;
      steadyHistoryArchiveId: string | null;
      frameTrackArchiveId: string | null;
      currentResultAttemptId: string;
      cl: number;
      cd: number;
      status: string;
    };
  }

  it("offloads both arrays and nested histories, preserves metadata/equality and restores unchanged consumer values", async () => {
    const source = await seed();
    const store = new ResultHistoryGcsStore(new MemoryGcs());
    const before = await stored(source.id);
    const [attemptBefore] = await db.execute(
      sql`SELECT evidence_payload::text AS body FROM result_attempts WHERE id=${source.attempt}::uuid`,
    );
    for (const sourceKind of ["steady_history", "frame_track"] as const) {
      expect(
        (
          await archiveResultHistory(db, store, {
            bucket: "histories",
            sourceInstance: "hub-fixture",
            resultId: source.id,
            sourceKind,
          })
        ).offloaded,
      ).toBe(true);
    }
    const compact = await stored(source.id);
    expect(compact.steadyHistory).toMatchObject({
      mean_stable: true,
      window: { start_iter: 1, end_iter: 1000 },
      nested: {
        coefficients: { archivedResultHistoryArray: true, length: 1500 },
      },
    });
    expect(compact.frameTrack).toMatchObject({
      stationary: true,
      periods_retained: 3,
      frames: { archivedResultHistoryArray: true, length: 120 },
      fields: ["pressure", "velocity_magnitude"],
    });
    const restored = await hydrateResultHistories(db, store, compact);
    expect(restored.steadyHistory).toEqual(before.steadyHistory);
    expect(restored.frameTrack).toEqual(before.frameTrack);
    expect([
      restored.cl,
      restored.cd,
      restored.status,
      restored.currentResultAttemptId,
    ]).toEqual([
      before.cl,
      before.cd,
      before.status,
      before.currentResultAttemptId,
    ]);
    expect(
      await resultHistoriesMatch(db, source.id, {
        steadyHistory: source.history,
        frameTrack: source.frames,
      }),
    ).toBe(true);
    expect(
      await resultHistoriesMatch(db, source.id, {
        steadyHistory: { ...source.history, mean_stable: false },
        frameTrack: source.frames,
      }),
    ).toBe(false);
    expect(
      (
        await db.execute(
          sql`SELECT evidence_payload::text AS body FROM result_attempts WHERE id=${source.attempt}::uuid`,
        )
      )[0],
    ).toEqual(attemptBefore);
    expect(
      (
        await archiveResultHistory(db, store, {
          bucket: "histories",
          sourceInstance: "hub-fixture",
          resultId: source.id,
          sourceKind: "steady_history",
        })
      ).offloaded,
    ).toBe(false);
  });

  it("keeps small metadata and active jobs inline, and blocks compaction without exact custody", async () => {
    const small = await seed(true),
      active = await seed(false, true),
      memory = new MemoryGcs();
    const store = new ResultHistoryGcsStore(memory);
    expect(
      (
        await archiveResultHistory(db, store, {
          bucket: "histories",
          sourceInstance: "hub-fixture",
          resultId: small.id,
          sourceKind: "steady_history",
        })
      ).retainedSmall,
    ).toBe(true);
    const candidates = await resultHistoryOffloadCandidates(db);
    expect(
      candidates
        .filter((row) => row.id === active.id)
        .every((row) => row.eligible === false),
    ).toBe(true);
    await expect(
      db.execute(
        sql`UPDATE results SET steady_history=result_history_compact(steady_history) WHERE id=${active.id}::uuid`,
      ),
    ).rejects.toThrow(/without.*archive/);
    expect(memory.saveCount).toBe(0);
    expect((await stored(small.id)).steadyHistory).toEqual(small.history);
  });

  it("keeps original bytes on late verification failure or a concurrent ingestion update", async () => {
    const failed = await seed(),
      memory = new MemoryGcs(),
      base = new ResultHistoryGcsStore(memory);
    memory.readError = true;
    await expect(
      archiveResultHistory(db, base, {
        bucket: "histories",
        sourceInstance: "hub-fixture",
        resultId: failed.id,
        sourceKind: "steady_history",
      }),
    ).rejects.toThrow(/late/);
    expect((await stored(failed.id)).steadyHistory).toEqual(failed.history);
    memory.readError = false;
    const registered = await seed();
    let verificationReads = 0;
    const failedFreshRestore: ResultHistoryArchiveStore = {
      put: (...args) => base.put(...args),
      read: async (identity) => {
        const restored = await base.read(identity);
        if (++verificationReads === 2)
          throw new Error("fresh recorded generation restore failed");
        return restored;
      },
    };
    await expect(
      archiveResultHistory(db, failedFreshRestore, {
        bucket: "histories",
        sourceInstance: "hub-fixture",
        resultId: registered.id,
        sourceKind: "steady_history",
      }),
    ).rejects.toThrow(/fresh recorded generation/);
    expect((await stored(registered.id)).steadyHistory).toEqual(
      registered.history,
    );
    expect((await stored(registered.id)).steadyHistoryArchiveId).toBeNull();
    const race = await seed();
    let reads = 0;
    const changed = { ...race.history, note: "new exact ingestion" };
    const racing: ResultHistoryArchiveStore = {
      put: (...args) => base.put(...args),
      read: async (identity) => {
        const result = await base.read(identity);
        if (++reads === 2)
          await db.execute(
            sql`UPDATE results SET steady_history=${JSON.stringify(changed)}::jsonb WHERE id=${race.id}::uuid`,
          );
        return result;
      },
    };
    expect(
      (
        await archiveResultHistory(db, racing, {
          bucket: "histories",
          sourceInstance: "hub-fixture",
          resultId: race.id,
          sourceKind: "steady_history",
        })
      ).offloaded,
    ).toBe(false);
    expect((await stored(race.id)).steadyHistory).toEqual(changed);
    expect((await stored(race.id)).steadyHistoryArchiveId).toBeNull();
  });

  it("protects archive ownership and lets real ingestion restore inline history without altering the archive", async () => {
    const source = await seed(),
      other = await seed();
    const store = new ResultHistoryGcsStore(new MemoryGcs());
    const result = await archiveResultHistory(db, store, {
      bucket: "histories",
      sourceInstance: "hub-fixture",
      resultId: source.id,
      sourceKind: "steady_history",
    });
    const archive = await getResultHistoryArchive(db, result.archive!.id);
    await expect(
      db.execute(sql`UPDATE results SET steady_history_archive_id=${archive.id}::uuid,
      steady_history=${archive.metadataText}::jsonb WHERE id=${other.id}::uuid`),
    ).rejects.toThrow(/exact immutable archive|foreign key/);
    await expect(
      db.execute(
        sql`UPDATE results SET steady_history_archive_id=NULL WHERE id=${source.id}::uuid`,
      ),
    ).rejects.toThrow(/cannot detach/);
    await db.execute(
      sql`UPDATE results SET steady_history=${JSON.stringify(source.history)}::jsonb WHERE id=${source.id}::uuid`,
    );
    expect((await stored(source.id)).steadyHistoryArchiveId).toBeNull();
    expect(await getResultHistoryArchive(db, archive.id)).toEqual(archive);
    expect(
      (await loadResultHistorySource(db, source.id, "steady_history"))
        .payloadText,
    ).toBe((await store.read(archive)).payloadText);
  });

  it("preserves normal replay equality across PostgreSQL numeric display scales", async () => {
    const source = await seed();
    await db.execute(sql`UPDATE results SET steady_history=steady_history || '{"measurement":1.0000000000}'::jsonb
      WHERE id=${source.id}::uuid`);
    const store = new ResultHistoryGcsStore(new MemoryGcs());
    const result = await archiveResultHistory(db, store, {
      bucket: "histories",
      sourceInstance: "hub-fixture",
      resultId: source.id,
      sourceKind: "steady_history",
    });
    expect(result.offloaded).toBe(true);
    expect((await store.read(result.archive!)).payloadText).toContain(
      '"measurement": 1.0000000000',
    );
    expect(
      await resultHistoriesMatch(db, source.id, {
        steadyHistory: { ...source.history, measurement: 1 },
        frameTrack: source.frames,
      }),
    ).toBe(true);
    expect(
      await resultHistoriesMatch(db, source.id, {
        steadyHistory: { ...source.history, measurement: 1.01 },
        frameTrack: source.frames,
      }),
    ).toBe(false);
  });

  it("bounds the automatic pass and preserves both histories across its cursor", async () => {
    // This private schema belongs to this file. Only the two new jobs remain
    // eligible, so older failure fixtures do not affect the pass budget.
    await db.execute(sql`UPDATE sim_jobs SET status='running'`);
    const sources = [await seed(), await seed()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const store = new ResultHistoryGcsStore(new MemoryGcs());
    const first = await runResultHistoryOffloadPass(db, store, {
      bucket: "histories",
      sourceInstance: "hub-fixture",
      maxRows: 2,
    });
    expect(first.offloaded).toBe(2);
    expect((await stored(sources[0]!.id)).steadyHistoryArchiveId).toBeTruthy();
    expect((await stored(sources[0]!.id)).frameTrackArchiveId).toBeTruthy();
    const second = await runResultHistoryOffloadPass(db, store, {
      bucket: "histories",
      sourceInstance: "hub-fixture",
      maxRows: 2,
      after: first.next,
    });
    expect(second.offloaded).toBe(2);
    expect((await stored(sources[1]!.id)).steadyHistoryArchiveId).toBeTruthy();
    expect((await stored(sources[1]!.id)).frameTrackArchiveId).toBeTruthy();
  });
});

it("authenticates exact 0208 public fields through same-owner inline or historical 0206 sources", async () => {
  const { verifyPublicAttemptFieldSources } = await import("../test-support/public-attempt-fields");
  await verifyPublicAttemptFieldSources(new ResultHistoryGcsStore(new MemoryGcs()));
}, 90_000);
