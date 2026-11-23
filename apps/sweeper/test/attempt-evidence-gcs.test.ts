import { CRC32C, type File, type Storage } from "@google-cloud/storage";
import { createClient, type DB } from "@aerodb/db/client";
import {
  auditAttemptEvidenceUsePage,
  getAttemptEvidenceArchive,
  registerAttemptEvidenceArchive,
} from "@aerodb/db/attempt-evidence-catalog";
import {
  ATTEMPT_EVIDENCE_INLINE_REQUIRED,
  auditAttemptEvidencePage,
  loadSettledAttemptEvidenceCopy,
  prepareAttemptEvidenceCopy,
} from "@aerodb/db/attempt-evidence-storage";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  archiveAttemptEvidence,
  runAttemptEvidenceArchivePass,
  runAttemptEvidenceStorageService,
} from "../src/attempt-evidence-service";
import { AttemptEvidenceStore } from "../src/attempt-evidence-store";

class MemoryGcs {
  objects = new Map<string, { bytes: Buffer; metadata: Record<string, any> }>();
  requests: Array<{ kind: string; generation: unknown }> = [];
  uploads = 0;
  failRead = false;
  lateError = false;
  afterUpload: (() => Promise<void>) | undefined;
  bucket(bucket: string) {
    return {
      upload: async (path: string, options: Record<string, any>) => {
        expect(options.preconditionOpts).toEqual({ ifGenerationMatch: 0 });
        expect(options.validation).toBe("crc32c");
        const key = `${bucket}/${options.destination}`;
        if (this.objects.has(key))
          throw Object.assign(new Error("exists"), { code: 412 });
        const bytes = await readFile(path),
          crc = new CRC32C();
        crc.update(bytes);
        this.uploads++;
        this.objects.set(key, {
          bytes,
          metadata: {
            ...options.metadata,
            generation: "18446744073709551615",
            size: String(bytes.length),
            crc32c: crc.toString(),
          },
        });
        if (this.afterUpload) await this.afterUpload();
      },
      file: (key: string, options?: { generation: string }) => {
        const interceptors: File["interceptors"] = [];
        const object = (kind: string) => {
          let request: Parameters<File["interceptors"][number]["request"]>[0] =
            {
              uri: "https://fixture.invalid/object",
              qs: options ? { generation: Number(options.generation) } : {},
            };
          for (const interceptor of interceptors)
            request = interceptor.request(request);
          this.requests.push({ kind, generation: request.qs.generation });
          const object = this.objects.get(`${bucket}/${key}`);
          if (
            !object ||
            (options && request.qs.generation !== "18446744073709551615")
          )
            throw Object.assign(new Error("generation missing"), { code: 404 });
          if (options)
            expect(request.qs.generation).toBe("18446744073709551615");
          return object;
        };
        return {
          interceptors,
          getMetadata: async () => [object("metadata").metadata],
          createReadStream: (settings: unknown) => {
            expect(settings).toEqual({
              validation: "crc32c",
              decompress: false,
            });
            const value = object("media"),
              fail = this.failRead,
              late = this.lateError;
            return Readable.from(
              (async function* () {
                yield fail ? Buffer.from("corrupt") : value.bytes;
                if (late) throw new Error("late GCS failure");
              })(),
            );
          },
        };
      },
    };
  }
}

function memoryStore(memory: MemoryGcs) {
  return new AttemptEvidenceStore(memory as unknown as Storage);
}

it("keeps bucketless/disabled/remote deployments idle before any DB or GCS call", async () => {
  const previous = { ...process.env };
  const unused = {
    execute() {
      throw new Error("idle archive service accessed DB");
    },
  } as unknown as DB;
  try {
    delete process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
    await runAttemptEvidenceStorageService(
      unused,
      new AbortController().signal,
    );
    process.env.AIRFOILFOAM_EVIDENCE_BUCKET = "fixture";
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
    await runAttemptEvidenceStorageService(
      unused,
      new AbortController().signal,
    );
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
    process.env.AIRFOILFOAM_ATTEMPT_EVIDENCE_ARCHIVE = "false";
    await runAttemptEvidenceStorageService(
      unused,
      new AbortController().signal,
    );
  } finally {
    process.env = previous;
  }
});

describe("settled attempt GCS retention and immutable SQL receipts", () => {
  const client = createClient({ max: 1 });
  const namespace = `attempt_gcs_${randomUUID().replaceAll("-", "")}`;
  let schemaCreated = false;
  let db: DB;
  beforeAll(async () => {
    db = client.db;
    await db.execute(sql.raw(`CREATE SCHEMA ${namespace}`));
    schemaCreated = true;
    await db.execute(sql.raw(`SET search_path TO ${namespace},public`));
    for (const statement of [
      "CREATE TABLE results(id uuid PRIMARY KEY,current_result_attempt_id uuid,cl float8,cd float8)",
      'CREATE TABLE sim_jobs(id uuid PRIMARY KEY,status text,"ingestedAt" timestamptz,ingest_lease_token uuid,ingest_lease_expires_at timestamptz)',
      "CREATE TABLE result_attempts(id uuid PRIMARY KEY,result_id uuid REFERENCES results(id) ON DELETE CASCADE,sim_job_id uuid REFERENCES sim_jobs(id),status text,evidence_payload jsonb,UNIQUE(id,result_id))",
      "CREATE TABLE progressive_cfd_evidence(result_attempt_id uuid)",
      "CREATE TABLE progressive_polar_model_evidence(result_attempt_id uuid)",
      "CREATE TABLE sim_campaign_points(result_attempt_id uuid)",
      "CREATE TABLE sim_precalc_obligations(source_result_attempt_id uuid)",
      "CREATE TABLE sim_precalc_obligation_attempts(result_attempt_id uuid)",
    ])
      await db.execute(sql.raw(statement));
    const migration = await readFile(
      new URL(
        "../../../packages/db/migrations/0207_attempt_evidence_archives.sql",
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
      if (schemaCreated)
        await client.db.execute(sql.raw(`DROP SCHEMA ${namespace} CASCADE`));
    } finally {
      await client.sql.end();
    }
  });
  async function seed(
    options: {
      active?: boolean;
      canonical?: boolean;
      model?: boolean;
      sampleCount?: number;
    } = {},
  ) {
    const attemptId = randomUUID(),
      resultId = randomUUID(),
      simJobId = randomUUID();
    const values = Array.from(
      { length: options.sampleCount ?? 600 },
      (_, i) => i / 10,
    );
    const payload = `{"cl":0.25,"cd":0.03,"metadata":{"n":9007199254740993123456789,"decimal":0.123456789012345678901},"force_history":${JSON.stringify({ t: values, cl: values, cd: values, cm: null, samples: values.length })},"evidence_artifacts":[]}`;
    await db.execute(
      sql`INSERT INTO results(id,cl,cd) VALUES(${resultId}::uuid,0.25,0.03)`,
    );
    await db.execute(
      sql`INSERT INTO sim_jobs(id,status,"ingestedAt") VALUES(${simJobId}::uuid,${options.active ? "running" : "done"},${options.active ? null : new Date().toISOString()}::timestamptz)`,
    );
    await db.execute(
      sql`INSERT INTO result_attempts VALUES(${attemptId}::uuid,${resultId}::uuid,${simJobId}::uuid,'done',${payload}::jsonb)`,
    );
    if (options.canonical)
      await db.execute(
        sql`UPDATE results SET current_result_attempt_id=${attemptId}::uuid WHERE id=${resultId}::uuid`,
      );
    if (options.model) {
      await db.execute(
        sql`INSERT INTO progressive_cfd_evidence VALUES(${attemptId}::uuid)`,
      );
      await db.execute(
        sql`INSERT INTO progressive_polar_model_evidence VALUES(${attemptId}::uuid)`,
      );
    }
    return { attemptId, resultId, simJobId };
  }
  const remaining = (
    page: Awaited<ReturnType<typeof auditAttemptEvidenceUsePage>>,
  ) =>
    page.groups.reduce(
      (sum, g) => sum + BigInt(g.remainingGcsSourceBytes as string),
      0n,
    );
  const retainedBytes = (
    page: Awaited<ReturnType<typeof auditAttemptEvidenceUsePage>>,
    metric: "onlineStoredPayloadBytes" | "historyBytes",
  ) =>
    page.groups.reduce(
      (sum, group) => sum + BigInt(group[metric] as string),
      0n,
    );
  async function onlinePoint(attemptId: string) {
    const [point] =
      await db.execute(sql`SELECT a.evidence_payload::text AS text,
      pg_column_size(a.evidence_payload) AS stored_bytes,
      octet_length(a.evidence_payload::text) AS logical_bytes,r.cl,r.cd,
      jsonb_typeof(a.evidence_payload#>'{force_history,t}')='array' AND jsonb_array_length(a.evidence_payload#>'{force_history,t}')>0 AS real_samples
      FROM result_attempts a JOIN results r ON r.current_result_attempt_id=a.id WHERE a.id=${attemptId}::uuid`);
    return point;
  }
  it("uploads actual PG text, restores the exact uint64 generation and records a replay-safe receipt without changing classification inputs", async () => {
    const ids = await seed({ canonical: true, model: true }),
      memory = new MemoryGcs(),
      store = memoryStore(memory);
    const audit = await auditAttemptEvidencePage(db, { limit: 1 });
    expect(audit.inlineRequired).toBe(ATTEMPT_EVIDENCE_INLINE_REQUIRED);
    expect(audit.inspectedRows).toBe("1");
    const source = await loadSettledAttemptEvidenceCopy(db, ids.attemptId);
    const before = await auditAttemptEvidenceUsePage(db, {
      catalogReady: true,
    });
    const liveBefore = await onlinePoint(ids.attemptId);
    const result = await archiveAttemptEvidence(db, store, {
      ...ids,
      bucket: "fixture",
      sourceInstance: "hub",
    });
    expect(result.created).toBe(true);
    expect(result.onlineBytesRemoved).toBe(0);
    expect(memory.uploads).toBe(1);
    expect(
      await store.read(await getAttemptEvidenceArchive(db, result.archive.id)),
    ).toEqual(source);
    expect(source.payloadText).toContain("9007199254740993123456789");
    const replay = await archiveAttemptEvidence(db, store, {
      ...ids,
      bucket: "fixture",
      sourceInstance: "hub",
    });
    expect(replay.archive).toEqual(result.archive);
    expect(replay.created).toBe(false);
    expect(memory.uploads).toBe(1);
    expect(
      memory.requests
        .filter((r) => r.generation !== undefined)
        .every((r) => r.generation === "18446744073709551615"),
    ).toBe(true);
    const point = await onlinePoint(ids.attemptId);
    expect(point).toEqual(liveBefore);
    expect(point).toMatchObject({
      text: source.payloadText,
      logical_bytes: Buffer.byteLength(source.payloadText),
      cl: 0.25,
      cd: 0.03,
      real_samples: true,
    });
    expect(Number(point.stored_bytes)).toBeGreaterThan(0);
    const after = await auditAttemptEvidenceUsePage(db, { catalogReady: true });
    expect(retainedBytes(after, "onlineStoredPayloadBytes")).toBe(
      retainedBytes(before, "onlineStoredPayloadBytes"),
    );
    expect(retainedBytes(after, "historyBytes")).toBe(
      retainedBytes(before, "historyBytes"),
    );
    expect(remaining(before) - remaining(after)).toBe(
      BigInt(Buffer.byteLength(source.payloadText)),
    );
    expect(
      after.groups.some(
        (g) =>
          g.canonical === true &&
          g.fit_model === true &&
          BigInt(g.cataloguedRows as string) > 0n,
      ),
    ).toBe(true);
  });
  it("refuses corrupt/late GCS reads and changed generation metadata without creating a receipt", async () => {
    const ids = await seed(),
      memory = new MemoryGcs(),
      store = memoryStore(memory);
    memory.lateError = true;
    await expect(
      archiveAttemptEvidence(db, store, {
        ...ids,
        bucket: "fixture",
        sourceInstance: "hub",
      }),
    ).rejects.toThrow("late GCS failure");
    const [count] = await db.execute(
      sql`SELECT count(*)::int AS n FROM attempt_evidence_archives WHERE result_attempt_id=${ids.attemptId}::uuid`,
    );
    expect(count.n).toBe(0);
    memory.lateError = false;
    const result = await archiveAttemptEvidence(db, store, {
      ...ids,
      bucket: "fixture",
      sourceInstance: "hub",
    });
    memory.failRead = true;
    await expect(store.read(result.archive)).rejects.toThrow();
    memory.failRead = false;
    await expect(
      store.read({ ...result.archive, generation: "42" }),
    ).rejects.toThrow("generation missing");
    const object = memory.objects.values().next().value!;
    object.metadata.generation = Number("18446744073709551615");
    await expect(store.read(result.archive)).rejects.toThrow(
      "exact decimal value",
    );
    object.metadata.generation = "18446744073709551615";
    object.metadata.metadata.sourceSha256 = "0".repeat(64);
    await expect(store.read(result.archive)).rejects.toThrow(
      "metadata changed",
    );
  });
  it("rechecks a settled writer at SQL registration and preserves the original source on a race", async () => {
    const ids = await seed(),
      memory = new MemoryGcs(),
      store = memoryStore(memory);
    const source = await loadSettledAttemptEvidenceCopy(db, ids.attemptId);
    memory.afterUpload = async () => {
      await db.execute(
        sql`UPDATE sim_jobs SET status='running' WHERE id=${ids.simJobId}::uuid`,
      );
    };
    await expect(
      archiveAttemptEvidence(db, store, {
        ...ids,
        bucket: "fixture",
        sourceInstance: "hub",
      }),
    ).rejects.toThrow("active writer");
    const [row] = await db.execute(
      sql`SELECT evidence_payload::text AS text FROM result_attempts WHERE id=${ids.attemptId}::uuid`,
    );
    expect(row.text).toBe(source.payloadText);
    const [count] = await db.execute(
      sql`SELECT count(*)::int AS n FROM attempt_evidence_archives WHERE result_attempt_id=${ids.attemptId}::uuid`,
    );
    expect(count.n).toBe(0);
  });
  it("enforces independent SQL source/series ownership and immutable receipt checks", async () => {
    const ids = await seed(),
      memory = new MemoryGcs(),
      store = memoryStore(memory);
    const source = await loadSettledAttemptEvidenceCopy(db, ids.attemptId),
      plan = prepareAttemptEvidenceCopy(source);
    const result = await archiveAttemptEvidence(db, store, {
      ...ids,
      bucket: "fixture",
      sourceInstance: "hub",
    });
    await expect(
      db.execute(
        sql`UPDATE attempt_evidence_archives SET generation='42' WHERE id=${result.archive.id}::uuid`,
      ),
    ).rejects.toThrow("immutable");
    await expect(
      registerAttemptEvidenceArchive(
        db,
        { ...result.archive, sourceSha256: "0".repeat(64) },
        { ...plan, sourceSha256: "0".repeat(64) },
      ),
    ).rejects.toThrow("exact PG source");
    const altered = {
      ...plan,
      historySeries: plan.historySeries.map((field, index) =>
        index ? field : { ...field, sha256: "0".repeat(64) },
      ),
    };
    await expect(
      registerAttemptEvidenceArchive(db, result.archive, altered),
    ).rejects.toThrow("history inventory");
    const foreignResult = randomUUID();
    await expect(
      registerAttemptEvidenceArchive(
        db,
        { ...result.archive, resultId: foreignResult },
        { ...plan, source: { ...source, resultId: foreignResult } },
      ),
    ).rejects.toThrow("exact terminal source owner");
    await db.execute(
      sql`UPDATE sim_jobs SET ingest_lease_token=${randomUUID()}::uuid,ingest_lease_expires_at=NULL WHERE id=${ids.simJobId}::uuid`,
    );
    await expect(
      registerAttemptEvidenceArchive(db, result.archive, plan),
    ).rejects.toThrow("active writer");
  });
  it("backs up short nonempty histories through the bounded scan and leaves active or empty sources alone", async () => {
    const small = await seed({ sampleCount: 2, canonical: true });
    const empty = await seed({ sampleCount: 0 });
    const active = await seed({ active: true });
    const before = await onlinePoint(small.attemptId);
    for (let i = 0; i < 3; i++) await seed();
    const memory = new MemoryGcs(),
      result = await runAttemptEvidenceArchivePass(db, memoryStore(memory), {
        bucket: "fixture",
        sourceInstance: "hub",
        maxRows: 1,
        maxBytes: 1,
      });
    expect(result.processed).toBe(1);
    expect(result.copied).toBe(1);
    expect(result.onlineBytesRemoved).toBe(0);
    expect(result.next).not.toBeNull();
    expect(memory.uploads).toBe(1);
    let after = result.next;
    while (after !== null) {
      const page = await runAttemptEvidenceArchivePass(db, memoryStore(memory), {
        bucket: "fixture", sourceInstance: "hub", after, maxRows: 2,
      });
      expect(page.failures).toEqual([]);
      after = page.next;
    }
    const records = await db.execute(sql`SELECT id,result_attempt_id FROM attempt_evidence_archives
      WHERE result_attempt_id IN (${small.attemptId}::uuid,${empty.attemptId}::uuid,${active.attemptId}::uuid)`);
    expect(records.map(row => row.result_attempt_id)).toEqual([small.attemptId]);
    const restored = await memoryStore(memory).read(await getAttemptEvidenceArchive(db, String(records[0]!.id)));
    expect(restored.payloadText).toBe(before.text);
    expect(await onlinePoint(small.attemptId)).toEqual(before);
  });
});
