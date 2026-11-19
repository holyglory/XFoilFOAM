import { CRC32C } from "@google-cloud/storage";
import {
  ATTEMPT_EVIDENCE_INLINE_REQUIRED,
  MAX_ATTEMPT_EVIDENCE_BYTES,
  attemptEvidenceAuditSql,
  auditAttemptEvidencePage,
  loadSettledAttemptEvidenceCopy,
  prepareAttemptEvidenceCopy,
  type AttemptEvidenceCopySource,
} from "@aerodb/db/attempt-evidence-storage";
import type { DB } from "@aerodb/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import {
  readAttemptEvidenceCopy,
  writeAttemptEvidenceCopy,
} from "../src/attempt-evidence-archive";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const dialect = new PgDialect();
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const crc = (bytes: Buffer) => {
  const crc = new CRC32C();
  crc.update(bytes);
  return crc.toString();
};

function source(): AttemptEvidenceCopySource {
  return {
    attemptId: randomUUID(),
    resultId: randomUUID(),
    simJobId: randomUUID(),
    payloadText:
      '{"cl": 0.123456789012345678901, "n_cells": 9007199254740993123456789, "force_history": {"t": [0, 0.1], "cl": [9007199254740993123456789, 0.123456789012345678901], "cd": [0.1, 0.2], "cm": null, "samples": 2, "window_start": 0}, "steadyHistory": {"iterations": [1, 2], "cl": [0.1, 0.2], "window": {"start_iter": 1, "end_iter": 2}}, "frame_track": {"frames": [{"i": 1, "t": 0.1}], "fields": ["pressure"]}, "urans_cycle_certificate": {"periods": [1, 2, 3]}, "source_geometry": [[0, 0], [1, 0]], "error": null}',
  };
}

async function archived() {
  const directory = await mkdtemp(join(tmpdir(), "attempt-copy-"));
  directories.push(directory);
  const path = join(directory, "copy.json.gz");
  const original = source();
  const identity = await writeAttemptEvidenceCopy(path, original);
  return { path, original, identity, bytes: await readFile(path) };
}

it("inventories only recognized series and preserves complete per-point metadata and exact numeric tokens", () => {
  const original = source();
  const plan = prepareAttemptEvidenceCopy(original);
  expect(plan.source).toEqual(original);
  expect(plan.inlineRequired).toBe(ATTEMPT_EVIDENCE_INLINE_REQUIRED);
  expect(plan.sourceSha256).toBe(hash(original.payloadText));
  expect(plan.sourceByteSize).toBe(Buffer.byteLength(original.payloadText));
  expect(plan.historySeries.map((field) => field.path)).toEqual([
    ["force_history", "t"],
    ["force_history", "cl"],
    ["force_history", "cd"],
    ["steadyHistory", "iterations"],
    ["steadyHistory", "cl"],
    ["frame_track", "frames"],
  ]);
  expect(
    plan.historySeries.find(
      (field) => field.path.join(".") === "force_history.cl",
    ),
  ).toMatchObject({
    sha256: hash("[9007199254740993123456789, 0.123456789012345678901]"),
  });
  expect(
    plan.historySeries.some((field) =>
      /certificate|geometry|samples|fields/.test(field.path.join(".")),
    ),
  ).toBe(false);
  expect(plan.source.payloadText).not.toContain("archiveReference");
});

it("roundtrips a bounded gzip copy without changing online sample arrays or null/absent fields", async () => {
  const { original, identity, bytes } = await archived();
  const restored = await readAttemptEvidenceCopy(
    Readable.from(Array.from(bytes, (byte) => Buffer.from([byte]))),
    identity,
  );
  expect(restored).toEqual(original);
  expect(JSON.parse(gunzipSync(bytes).toString()).source.payloadText).toBe(
    original.payloadText,
  );
  expect(identity).toMatchObject({
    storedSha256: hash(bytes),
    storedByteSize: bytes.length,
    crc32c: crc(bytes),
  });
});

it("rejects wrong owners, exact text hashes/sizes, gzip damage and stream errors even after all bytes arrive", async () => {
  const { identity, bytes } = await archived();
  for (const changed of [
    { attemptId: randomUUID() },
    { resultId: randomUUID() },
    { simJobId: randomUUID() },
    { sourceSha256: "0".repeat(64) },
    { sourceByteSize: identity.sourceByteSize + 1 },
    { envelopeSha256: "0".repeat(64) },
    { envelopeByteSize: identity.envelopeByteSize + 1 },
    { storedSha256: "0".repeat(64) },
    { storedByteSize: bytes.length + 1 },
    { crc32c: "AAAAAA==" },
  ])
    await expect(
      readAttemptEvidenceCopy(Readable.from([bytes]), {
        ...identity,
        ...changed,
      }),
    ).rejects.toThrow();
  const truncated = bytes.subarray(0, -4);
  await expect(
    readAttemptEvidenceCopy(Readable.from([truncated]), {
      ...identity,
      storedByteSize: truncated.length,
      storedSha256: hash(truncated),
      crc32c: crc(truncated),
    }),
  ).rejects.toThrow();
  await expect(
    readAttemptEvidenceCopy(
      Readable.from(
        (async function* () {
          yield bytes;
          throw new Error("late attempt copy stream failure");
        })(),
      ),
      identity,
    ),
  ).rejects.toThrow("late attempt copy stream failure");
  const envelope = JSON.parse(gunzipSync(bytes).toString());
  envelope.source.payloadText = envelope.source.payloadText.replace(
    "9007199254740993123456789",
    "9007199254740993123456788",
  );
  const decoded = Buffer.from(JSON.stringify(envelope));
  const corrupted = gzipSync(decoded);
  await expect(
    readAttemptEvidenceCopy(Readable.from([corrupted]), {
      ...identity,
      storedByteSize: corrupted.length,
      storedSha256: hash(corrupted),
      crc32c: crc(corrupted),
      envelopeSha256: hash(decoded),
      envelopeByteSize: decoded.length,
    }),
  ).rejects.toThrow();
});

it("keeps caller files intact and rejects oversized, malformed or ambiguous sources", async () => {
  const { path, original, bytes } = await archived();
  await expect(writeAttemptEvidenceCopy(path, original)).rejects.toThrow();
  expect(await readFile(path)).toEqual(bytes);
  for (const payloadText of [
    "[]",
    '{"cl":1,"cl":2}',
    '{"cl":',
    '"' + "x".repeat(MAX_ATTEMPT_EVIDENCE_BYTES) + '"',
  ])
    expect(() =>
      prepareAttemptEvidenceCopy({ ...original, payloadText }),
    ).toThrow();
  expect(() =>
    prepareAttemptEvidenceCopy({ ...original, attemptId: "" }),
  ).toThrow();
});

it("fixes the ID page before detoasting, exposes only measurements and applies read-only/time bounds", async () => {
  const query = dialect.sqlToQuery(
    attemptEvidenceAuditSql({ limit: 32, after: randomUUID() }),
  );
  expect(query.sql).toContain("WITH ids AS MATERIALIZED");
  expect(query.sql.indexOf("LIMIT")).toBeLessThan(
    query.sql.indexOf("jsonb_each"),
  );
  expect(query.sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|TRUNCATE)\b/i);
  expect(query.sql).not.toMatch(/payload::text\s+AS\s+\"?payloadText/);
  for (const options of [
    { limit: 0 },
    { limit: 129 },
    { after: "bad" },
    { maxStoredPayloadBytes: MAX_ATTEMPT_EVIDENCE_BYTES + 1 },
  ])
    expect(() => attemptEvidenceAuditSql(options)).toThrow();
  const statements: string[] = [];
  const audit = { rows: "32", next: randomUUID(), complete: false };
  const tx = {
    execute: vi.fn(async (statement: SQL) => {
      statements.push(dialect.sqlToQuery(statement).sql);
      return statements.at(-1)!.includes("WITH ids AS MATERIALIZED")
        ? [{ audit }]
        : [];
    }),
  };
  const db = {
    transaction: async (callback: (tx: unknown) => unknown) => callback(tx),
  } as unknown as DB;
  expect(await auditAttemptEvidencePage(db)).toEqual(audit);
  expect(statements.slice(0, 3)).toEqual([
    "SET TRANSACTION READ ONLY",
    "SET LOCAL statement_timeout='5s'",
    "SET LOCAL lock_timeout='500ms'",
  ]);
});

it("exports only a bounded settled attempt through a read-only source query", async () => {
  const original = source();
  const statements: string[] = [];
  const tx = {
    execute: vi.fn(async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      statements.push(query.sql);
      if (query.sql.includes('AS "payloadText"')) {
        expect(query.sql).toContain('job."ingestedAt" IS NOT NULL');
        expect(query.sql).toContain(
          "job.ingest_lease_expires_at <= clock_timestamp()",
        );
        expect(query.sql).toContain("a.status IN ('done','failed')");
        return [original];
      }
      return [];
    }),
  };
  const db = {
    transaction: async (callback: (tx: unknown) => unknown) => callback(tx),
  } as unknown as DB;
  expect(await loadSettledAttemptEvidenceCopy(db, original.attemptId)).toEqual(
    original,
  );
  expect(statements[0]).toBe("SET TRANSACTION READ ONLY");
  tx.execute.mockImplementation(async () => []);
  await expect(
    loadSettledAttemptEvidenceCopy(db, original.attemptId),
  ).rejects.toThrow("active, missing");
});
