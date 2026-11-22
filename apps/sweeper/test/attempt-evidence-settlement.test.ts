import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createClient, type DB } from "@aerodb/db/client";
import { databaseUrl } from "@aerodb/db/env";
import { randomUUID } from "node:crypto";
import {
  getAttemptEvidenceStorage,
  getAttemptEvidenceStoragePolicy,
  prepareAttemptEvidenceProjection,
  restoreAttemptEvidence,
  setAttemptEvidenceStoragePolicy,
  shortenAttemptEvidence,
  type AttemptEvidenceFreshVerification,
} from "@aerodb/db/attempt-evidence-projection";
import { createAttemptServerDependencyVerifier } from "@aerodb/db/attempt-evidence-dependency-verifier";
import { analysisContentHash } from "@aerodb/db/analysis-target";
import {
  assertAttemptSourcePins,
  attemptSourceApplicationSha256,
  loadAttemptSourcePins,
  prepareAttemptSources,
} from "@aerodb/db/attempt-receipt-source";
import {
  readApiAttemptEvidenceForApp,
  apiAttemptEvidenceReader,
} from "../../api/src/attempt-evidence-reader";
import { env } from "../../api/src/env";
import {
  settleAttemptEvidenceHistory,
  runAttemptEvidenceSettlementPass,
  runConfiguredAttemptEvidenceSettlementService,
} from "../src/attempt-evidence-settlement";
import {
  createSettlementFixture,
  seedSettledHistory,
} from "../test-support/attempt-settlement-fixture";
import { attemptEvidenceStorageMain } from "../src/attempt-evidence-storage-cli";
import { AttemptEvidenceStore } from "../src/attempt-evidence-store";

// Existing attempt suites cover copies or read projections. This integration
// installs the unchanged 0207 and the actual 0208 in a new schema and exercises
// real shortening, full app read-through, Boole's proof and restart-safe replay.
describe("verified settled attempt history transition", () => {
  let fixture: Awaited<ReturnType<typeof createSettlementFixture>>;
  const oldEnvironment = { ...process.env };
  const oldBucket = env.evidenceBucket;
  beforeAll(async () => {
    fixture = await createSettlementFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
    process.env.AIRFOILFOAM_EVIDENCE_BUCKET = "fixture";
    env.evidenceBucket = "fixture";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    try {
      if (fixture) await fixture.close();
    } finally {
      process.env = oldEnvironment;
      env.evidenceBucket = oldBucket;
    }
  });

  function dependencies(
    source: Awaited<ReturnType<typeof seedSettledHistory>>,
  ) {
    vi.spyOn(apiAttemptEvidenceReader, "read").mockImplementation(
      (identity, signal) => source.store.read(identity, signal),
    );
    return {
      store: source.store,
      readApp: vi.fn((request) =>
        readApiAttemptEvidenceForApp(fixture.db, request),
      ),
      verifyDependencies: createAttemptServerDependencyVerifier(
        fixture.db,
        source.store,
      ),
    };
  }
  async function row(id: string) {
    const [value] = await fixture.db
      .execute(sql`SELECT evidence_payload::text AS text,evidence_archive_id AS archive,
      pg_column_size(evidence_payload) AS bytes,cl,cd,cm,valid_for_polar,converged FROM result_attempts WHERE id=${id}::uuid`);
    return value;
  }
  async function eventCount(id: string) {
    const [value] = await fixture.db.execute(
      sql`SELECT count(*)::int AS n FROM attempt_evidence_storage_events WHERE result_attempt_id=${id}::uuid`,
    );
    return Number(value.n);
  }
  async function enabled() {
    await setAttemptEvidenceStoragePolicy(fixture.db, {
      enabled: true,
      consumerContractVersion: 1,
    });
  }

  it("authenticates a 0208 source on its original schema and rebinds after restore", async () => {
    const { db, namespace } = fixture;
    const source = await seedSettledHistory(db);
    const id = source.attemptId;
    await enabled();
    const full = (await row(id)).text as string;
    const digest = analysisContentHash(JSON.parse(full));
    await settleAttemptEvidenceHistory(db, dependencies(source), { attemptId: id, archiveId: source.archive.id });
    const [session] = await db.execute(sql`SELECT current_setting('search_path') AS path`);
    try {
      // Use only the actual 0208 fixture schema. The enclosing database has
      // newer migrations in public that would otherwise hide missing readers.
      await db.execute(sql`SET search_path=${sql.identifier(namespace)},pg_catalog`);
      const [schema] = await db.execute(sql`SELECT to_regprocedure('attempt_evidence_archived_application_sha256(uuid,uuid,uuid)') IS NULL AS original_schema`);
      expect(schema.original_schema).toBe(true);
      const cold = (await loadAttemptSourcePins(db, [id])).get(id)!;
      expect(cold).toMatchObject({ archiveId: source.archive.id, applicationSha256: null, cfdAttemptToken: null });
      expect(() => attemptSourceApplicationSha256(cold)).toThrow(/unavailable/);
      const prepared = (await prepareAttemptSources(db, source.store, [cold])).get(id)!;
      expect(prepared.payloadText).toBe(full);
      expect(attemptSourceApplicationSha256(prepared.pin)).toBe(digest);
      await db.transaction(tx => assertAttemptSourcePins(tx as unknown as DB, [prepared.pin]));
      await restoreAttemptEvidence(db, id, source.archive.id, full, "test original restored");
      await expect(db.transaction(tx => assertAttemptSourcePins(tx as unknown as DB, [prepared.pin]))).rejects.toThrow(/binding changed/);
      const current = (await loadAttemptSourcePins(db, [id])).get(id)!;
      expect(current.archiveId).toBeNull();
      expect(current.storageEventId).not.toBe(cold.storageEventId);
      const restored = (await prepareAttemptSources(db, source.store, [current])).get(id)!;
      expect(restored.payloadText).toBe(full);
      expect(attemptSourceApplicationSha256(restored.pin, restored.payload)).toBe(digest);
      await db.transaction(tx => assertAttemptSourcePins(tx as unknown as DB, [restored.pin]));
    } finally {
      await db.execute(sql`SELECT set_config('search_path',${String(session.path)},false)`);
    }
  });

  it("removes real online arrays with measurable savings and preserves exact app reads, scalar decisions and replay", async () => {
    const source = await seedSettledHistory(fixture.db),
      deps = dependencies(source);
    const before = await row(source.attemptId);
    expect(
      (await getAttemptEvidenceStoragePolicy(fixture.db))?.shorteningEnabled,
    ).toBe(false);
    await expect(
      settleAttemptEvidenceHistory(fixture.db, deps, {
        attemptId: source.attemptId,
        archiveId: source.archive.id,
      }),
    ).rejects.toThrow("disabled");
    await enabled();
    const result = await settleAttemptEvidenceHistory(fixture.db, deps, {
      attemptId: source.attemptId,
      archiveId: source.archive.id,
    });
    expect("alreadyShortened" in result).toBe(false);
    if ("alreadyShortened" in result)
      throw new Error("First transition incorrectly replayed");
    const after = await row(source.attemptId);
    expect(after.archive).toBe(source.archive.id);
    expect(Number(after.bytes)).toBeLessThan(Number(before.bytes));
    expect(result.payloadBytesReclaimed).toBe(
      Number(before.bytes) - Number(after.bytes),
    );
    expect(result.netValueBytesReclaimed).toBe(
      result.payloadBytesReclaimed -
        result.projectionValueBytes -
        result.verificationValueBytes,
    );
    expect(result.netValueBytesReclaimed).toBeGreaterThan(1023);
    expect(after).toMatchObject({
      cl: before.cl,
      cd: before.cd,
      cm: before.cm,
      valid_for_polar: before.valid_for_polar,
      converged: before.converged,
    });
    expect(String(after.text)).not.toContain('"iterations"');
    expect(String(after.text)).toContain("9007199254740993123456789");
    expect(
      deps.readApp.mock.calls.map(([request]) => request.forceArchive),
    ).toEqual([true, false]);
    const app = await readApiAttemptEvidenceForApp(fixture.db, {
      attemptId: source.attemptId,
      archiveId: source.archive.id,
      sourceSha256: source.archive.sourceSha256,
      sourceByteSize: source.archive.sourceByteSize,
      forceArchive: false,
    });
    expect(app.payloadText).toBe(before.text);
    expect(
      source.memory.pinned.every(
        (generation) => generation === "18446744073709551615",
      ),
    ).toBe(true);
    const replay = await settleAttemptEvidenceHistory(fixture.db, deps, {
      attemptId: source.attemptId,
      archiveId: source.archive.id,
    });
    expect(replay).toMatchObject({
      alreadyShortened: true,
      payloadBytesReclaimed: 0,
      netValueBytesReclaimed: 0,
    });
    expect(await eventCount(source.attemptId)).toBe(1);
    expect(source.memory.uploads).toBe(1);
    const [receipt] = await fixture.db.execute(
      sql`SELECT completed,result_stored_bytes,source_stored_bytes FROM attempt_evidence_storage_events WHERE result_attempt_id=${source.attemptId}::uuid`,
    );
    expect(receipt.completed).toBe(true);
    console.info(
      JSON.stringify({
        fixture: "settled-attempt",
        eligible: 1,
        shortened: 1,
        ...result,
      }),
    );
  });

  it("preserves JSONB decimal equality and exact null/type/count facts without read-time source hashing", async () => {
    const source = await seedSettledHistory(fixture.db),
      deps = dependencies(source);
    await enabled();
    const before = await row(source.attemptId);
    await settleAttemptEvidenceHistory(fixture.db, deps, {
      attemptId: source.attemptId,
      archiveId: source.archive.id,
    });
    const [facts] = await fixture.db.execute(sql`SELECT
      attempt_evidence_array_facts(a.id,a.evidence_archive_id,NULL,p.projection,ARRAY['steady_history','cl']) AS series,
      attempt_evidence_value_matches(a.id,a.evidence_archive_id,NULL,p.projection,ARRAY[]::text[],${before.text}::jsonb) AS whole,
      attempt_evidence_value_equals(a.id,a.evidence_archive_id,NULL,p.projection,ARRAY['steady_history','iterations'],'[0.0]'::jsonb) AS changed,
      attempt_evidence_value_equals(a.id,a.evidence_archive_id,NULL,p.projection,ARRAY['force_history','t'],NULL::jsonb) AS absent,
      attempt_evidence_value_matches(a.id,a.evidence_archive_id,NULL,p.projection,ARRAY['force_history','t'],NULL::jsonb) AS absent_matches
      FROM result_attempts a JOIN attempt_evidence_history_projections p ON p.result_attempt_id=a.id AND p.archive_id=a.evidence_archive_id
      WHERE a.id=${source.attemptId}::uuid`);
    expect(facts.series).toMatchObject({
      present: true,
      jsonType: "array",
      length: 1600,
    });
    expect(facts).toMatchObject({
      whole: true,
      changed: false,
      absent: null,
      absent_matches: true,
    });
    const [scales] = await fixture.db
      .execute(sql`SELECT attempt_evidence_semantic_sha256('1.000'::jsonb)=attempt_evidence_semantic_sha256('1'::jsonb) AS equal,
      attempt_evidence_semantic_sha256('9007199254740993123456789'::jsonb)=attempt_evidence_semantic_sha256('9007199254740993123456788'::jsonb) AS rounded`);
    expect(scales).toEqual({ equal: true, rounded: false });
  });

  it("restores the exact original after a post-transition app failure and permits a safe retry", async () => {
    const source = await seedSettledHistory(fixture.db),
      deps = dependencies(source);
    await enabled();
    const before = await row(source.attemptId);
    const read = deps.readApp;
    deps.readApp = vi.fn(async (request) => {
      if (!request.forceArchive)
        throw new Error("app unavailable after switch");
      return read(request);
    });
    await expect(
      settleAttemptEvidenceHistory(fixture.db, deps, {
        attemptId: source.attemptId,
        archiveId: source.archive.id,
      }),
    ).rejects.toThrow("original was restored");
    expect(await row(source.attemptId)).toEqual(before);
    expect(await eventCount(source.attemptId)).toBe(2);
    deps.readApp = read;
    await expect(
      settleAttemptEvidenceHistory(fixture.db, deps, {
        attemptId: source.attemptId,
        archiveId: source.archive.id,
      }),
    ).resolves.toMatchObject({ attemptId: source.attemptId });
    expect(await eventCount(source.attemptId)).toBe(3);
  });

  it.each(["corrupt", "late", "app", "scientific"])(
    "keeps all online bytes when %s proof fails",
    async (failure) => {
      const source = await seedSettledHistory(fixture.db),
        deps = dependencies(source);
      await enabled();
      const before = await row(source.attemptId);
      if (failure === "corrupt") source.memory.failReads = true;
      if (failure === "late") source.memory.lateError = true;
      if (failure === "app")
        deps.readApp = vi.fn(async () => {
          throw new Error("no app read-through");
        });
      if (failure === "scientific") {
        const verify = deps.verifyDependencies;
        deps.verifyDependencies = async (input) => ({
          ...(await verify(input)),
          scientificEquivalent: false,
        });
      }
      await expect(
        settleAttemptEvidenceHistory(fixture.db, deps, {
          attemptId: source.attemptId,
          archiveId: source.archive.id,
        }),
      ).rejects.toThrow();
      expect(await row(source.attemptId)).toEqual(before);
      expect(await eventCount(source.attemptId)).toBe(0);
    },
  );

  it.each(["job", "canonical", "source"])(
    "rechecks a changed %s dependency in the final SQL transaction",
    async (change) => {
      const source = await seedSettledHistory(fixture.db),
        deps = dependencies(source);
      await enabled();
      const verify = deps.verifyDependencies;
      deps.verifyDependencies = async (input) => {
        const proof = await verify(input);
        if (change === "job")
          await fixture.db.execute(
            sql`UPDATE sim_jobs SET status='running' WHERE id=${source.jobId}::uuid`,
          );
        if (change === "canonical")
          await fixture.db.execute(
            sql`UPDATE results SET current_result_attempt_id=${source.attemptId}::uuid WHERE id=${source.resultId}::uuid`,
          );
        if (change === "source")
          await fixture.db.execute(
            sql`UPDATE result_attempts SET evidence_payload=evidence_payload||'{"changed":true}'::jsonb WHERE id=${source.attemptId}::uuid`,
          );
        return proof;
      };
      await expect(
        settleAttemptEvidenceHistory(fixture.db, deps, {
          attemptId: source.attemptId,
          archiveId: source.archive.id,
        }),
      ).rejects.toThrow();
      expect((await row(source.attemptId)).archive).toBeNull();
      expect(await eventCount(source.attemptId)).toBe(0);
    },
  );

  it("rolls back shortening when projection/receipt overhead exceeds the actual stored saving", async () => {
    const source = await seedSettledHistory(fixture.db, { compressible: true }),
      deps = dependencies(source);
    await enabled();
    const before = await row(source.attemptId);
    await expect(
      settleAttemptEvidenceHistory(fixture.db, deps, {
        attemptId: source.attemptId,
        archiveId: source.archive.id,
      }),
    ).rejects.toThrow("insufficient net");
    expect(await row(source.attemptId)).toEqual(before);
    expect(await eventCount(source.attemptId)).toBe(0);
  });

  it("refuses direct marker/bulk-removal writes and stale proofs, and completes SQL receipts immutably", async () => {
    const source = await seedSettledHistory(fixture.db),
      deps = dependencies(source);
    await enabled();
    await expect(
      fixture.db.execute(
        sql`UPDATE result_attempts SET evidence_payload=attempt_evidence_compact(evidence_payload) WHERE id=${source.attemptId}::uuid`,
      ),
    ).rejects.toThrow("custody");
    await expect(
      fixture.db.execute(
        sql`UPDATE result_attempts SET evidence_archive_id=${source.archive.id}::uuid WHERE id=${source.attemptId}::uuid`,
      ),
    ).rejects.toThrow();
    await prepareAttemptEvidenceProjection(
      fixture.db,
      source.attemptId,
      source.archive.id,
    );
    const stale = {
      direct: { verifiedAt: "2000-01-01T00:00:00Z" },
    } as AttemptEvidenceFreshVerification;
    await expect(
      shortenAttemptEvidence(
        fixture.db,
        source.attemptId,
        source.archive.id,
        stale,
      ),
    ).rejects.toThrow("proofs");
    await settleAttemptEvidenceHistory(fixture.db, deps, {
      attemptId: source.attemptId,
      archiveId: source.archive.id,
    });
    await expect(
      fixture.db.execute(
        sql`UPDATE attempt_evidence_storage_events SET verification='{}'::jsonb WHERE result_attempt_id=${source.attemptId}::uuid`,
      ),
    ).rejects.toThrow("immutable");
    await expect(
      fixture.db.execute(
        sql`UPDATE result_attempts SET cl=42 WHERE id=${source.attemptId}::uuid`,
      ),
    ).rejects.toThrow("immutable");
    const stored = await getAttemptEvidenceStorage(
      fixture.db,
      source.attemptId,
    );
    expect(stored?.state).toBe("archived");
    const original = await source.store.read(source.archive);
    await restoreAttemptEvidence(
      fixture.db,
      source.attemptId,
      source.archive.id,
      original.payloadText,
      "operator recovery",
    );
    await expect(
      restoreAttemptEvidence(
        fixture.db,
        source.attemptId,
        source.archive.id,
        original.payloadText,
        "replay recovery",
      ),
    ).resolves.toMatchObject({ alreadyRestored: true });
  });

  it("shortens at most the requested rows per automatic pass and counts replay only once", async () => {
    const first = await seedSettledHistory(fixture.db, {
      id: "11111111-1111-4111-8111-111111111111",
    });
    const second = await seedSettledHistory(fixture.db, {
      id: "22222222-2222-4222-8222-222222222222",
    });
    // Share one transport for both exact original objects.
    for (const [key, value] of second.memory.objects)
      first.memory.objects.set(key, value);
    const deps = dependencies(first);
    await enabled();
    const pass = await runAttemptEvidenceSettlementPass(fixture.db, deps, {
      maxRows: 1,
    });
    expect(pass).toMatchObject({
      processed: 1,
      shortened: 1,
      next: first.attemptId,
    });
    expect(pass.netValueBytesReclaimed).toBeGreaterThan(0);
    expect((await row(second.attemptId)).archive).toBeNull();
    const next = await runAttemptEvidenceSettlementPass(fixture.db, deps, {
      after: pass.next,
      maxRows: 1,
    });
    expect(next).toMatchObject({
      processed: 1,
      shortened: 1,
      next: second.attemptId,
    });
    const exhausted = await runAttemptEvidenceSettlementPass(fixture.db, deps, {
      after: next.next,
      maxRows: 1,
    });
    expect(exhausted).toMatchObject({ processed: 0, shortened: 0, next: null });
  });

  it("the configured hub worker picks an eligible archived attempt and verifies its visible result", async () => {
    const source = await seedSettledHistory(fixture.db);
    const original = await row(source.attemptId);
    const read = source.store.read.bind(source.store);
    vi.spyOn(AttemptEvidenceStore.prototype, "read").mockImplementation(read);
    await enabled();
    const stop = new AbortController();
    let measured = false;
    vi.spyOn(console, "info").mockImplementation((component, result) => {
      if (
        component === "attempt-history-shortening" &&
        result.shortened === 1 &&
        result.netValueBytesReclaimed > 0
      ) {
        measured = true;
        stop.abort();
      }
    });
    await runConfiguredAttemptEvidenceSettlementService(
      fixture.db,
      AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]),
    );
    expect(measured).toBe(true);
    const [event] = await fixture.db.execute(
      sql`SELECT completed,app_readback_at FROM attempt_evidence_storage_events WHERE result_attempt_id=${source.attemptId}::uuid`,
    );
    expect(event.completed).toBe(true);
    expect(event.app_readback_at).toBeTruthy();
    expect((await source.store.read(source.archive)).payloadText).toBe(
      original.text,
    );
    expect((await row(source.attemptId)).archive).toBe(source.archive.id);
  }, 20_000);

  it("recovers a committed transition after a worker interruption, also while new work is disabled", async () => {
    const source = await seedSettledHistory(fixture.db),
      deps = dependencies(source);
    await enabled();
    const db = fixture.db,
      dialect = new PgDialect();
    const interrupted = new Proxy(db, {
      get(target, key) {
        if (key !== "execute") return Reflect.get(target, key, target);
        return (query: Parameters<DB["execute"]>[0]) => {
          const statement =
            typeof query === "string"
              ? query
              : dialect.sqlToQuery(query.getSQL()).sql;
          if (statement.includes("SET app_readback_at=clock_timestamp()"))
            throw new Error("process stopped before confirming visible read");
          return target.execute(query);
        };
      },
    });
    await expect(
      settleAttemptEvidenceHistory(interrupted, deps, {
        attemptId: source.attemptId,
        archiveId: source.archive.id,
      }),
    ).rejects.toThrow("before confirming");
    const [before] = await db.execute(
      sql`SELECT app_readback_at AS confirmed FROM attempt_evidence_storage_events WHERE result_attempt_id=${source.attemptId}::uuid`,
    );
    expect(before.confirmed).toBeNull();
    await setAttemptEvidenceStoragePolicy(db, { enabled: false });
    expect(await runAttemptEvidenceSettlementPass(db, deps)).toMatchObject({
      recovered: 1,
      shortened: 0,
      netValueBytesReclaimed: 0,
    });
    expect(await runAttemptEvidenceSettlementPass(db, deps)).toMatchObject({
      recovered: 0,
      shortened: 0,
    });
    expect((await row(source.attemptId)).archive).toBe(source.archive.id);
    expect(await eventCount(source.attemptId)).toBe(1);
  });

  it("runs the production CLI through a pinned single-attempt canary, replay, automatic enablement and exact rollback", async () => {
    const source = await seedSettledHistory(fixture.db);
    const original = await row(source.attemptId);
    // Restrict every new CLI connection to this suite's disposable schema.
    const url = new URL(databaseUrl());
    url.searchParams.set(
      "options",
      `-c search_path=${fixture.namespace},public`,
    );
    const prior = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();
    const read = source.store.read.bind(source.store);
    vi.spyOn(AttemptEvidenceStore.prototype, "read").mockImplementation(read);
    const invoke = async (...args: string[]) => {
      let output = "";
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((value) => {
          output += String(value);
          return true;
        });
      try {
        await attemptEvidenceStorageMain(args);
      } finally {
        stdout.mockRestore();
      }
      return JSON.parse(output);
    };
    try {
      const probe = createClient({ max: 1 });
      try {
        expect(
          (await probe.db.execute(sql`SELECT current_schema() AS schema`))[0]
            .schema,
        ).toBe(fixture.namespace);
      } finally {
        await probe.sql.end();
      }
      expect((await invoke("shortening-candidates")).eligible).toEqual([
        { attemptId: source.attemptId, archiveId: source.archive.id },
      ]);
      expect(
        await invoke(
          "enable-shortening",
          "--id",
          source.attemptId,
          "--consumer-contract",
          "1",
        ),
      ).toMatchObject({ canaryAttemptId: source.attemptId });
      expect((await invoke("shortening-status")).policy.canaryAttemptId).toBe(
        source.attemptId,
      );
      expect(
        await runAttemptEvidenceSettlementPass(
          fixture.db,
          dependencies(source),
        ),
      ).toMatchObject({ enabled: false, shortened: 0 });
      const args = [
        "shorten",
        "--id",
        source.attemptId,
        "--archive-id",
        source.archive.id,
      ];
      expect((await invoke(...args)).netValueBytesReclaimed).toBeGreaterThan(0);
      expect((await invoke("shortening-status")).current).toMatchObject({
        shortenedAttempts: "1",
        pendingAppReadbacks: "0",
      });
      expect(await invoke(...args)).toMatchObject({
        alreadyShortened: true,
        netValueBytesReclaimed: 0,
      });
      expect(
        await invoke("enable-shortening", "--consumer-contract", "1"),
      ).toMatchObject({ shorteningEnabled: true, canaryAttemptId: null });
      expect(await invoke("disable-shortening")).toMatchObject({
        shorteningEnabled: false,
      });
      await invoke(
        "restore-inline",
        "--id",
        source.attemptId,
        "--archive-id",
        source.archive.id,
      );
      expect(await row(source.attemptId)).toEqual(original);
      expect((await invoke("shortening-status")).current).toEqual({
        shortenedAttempts: "0",
        pendingAppReadbacks: "0",
        payloadBytesReclaimed: "0",
        netValueBytesReclaimed: "0",
      });
    } finally {
      if (prior === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prior;
    }
  });
});
