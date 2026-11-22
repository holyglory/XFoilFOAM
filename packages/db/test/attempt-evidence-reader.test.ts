import { randomUUID } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { DB } from "../src/client";
import {
  attemptEvidenceMetadataMatches,
  hydrateAttemptEvidence,
  hydrateAttemptEvidenceBatch,
  readAttemptEvidenceText,
  type AttemptEvidenceReadRow,
} from "../src/attempt-evidence-reader";
import { prepareAttemptEvidenceCopy } from "../src/attempt-evidence-storage";
import type { AttemptEvidenceProjection } from "../src/attempt-evidence-projection";
import { projectAttemptEvidenceForConsumers } from "../src/attempt-evidence-consumers";
import { reportTextIdentity } from "../src/progressive-report-archive";

function fixture() {
  const attemptId = randomUUID(),
    resultId = randomUUID(),
    simJobId = randomUUID(),
    archiveId = randomUUID();
  const source = {
    attemptId,
    resultId,
    simJobId,
    payloadText:
      '{ "mesh_recovery_version": 1, "fidelity": "rans", "cl": 0.63, "cd": 0.014, "error": null, "wide": 900719925474099312345, "unknown": [7, 8], "force_history": { "t": [0, 1, 2], "cl": [0.1, 0.2, 0.3], "cd": [0.01, 0.02, 0.03], "cm": null, "window_start": 0 }, "steady_history": { "iterations": [1, 2, 3], "cl": [0.1, 0.2, 0.3], "mean_stable": true }, "evidence_artifacts": [{ "kind": "manifest", "metadata": { "retained": true } }] }',
  };
  const plan = prepareAttemptEvidenceCopy(source),
    compact = projectAttemptEvidenceForConsumers(
      source.payloadText,
    ).projectionText;
  const row: AttemptEvidenceReadRow & {
    cl: number;
    cd: number;
    validForPolar: boolean;
  } = {
    id: attemptId,
    resultId,
    simJobId,
    evidencePayload: JSON.parse(compact),
    evidenceArchiveId: archiveId,
    cl: 0.63,
    cd: 0.014,
    validForPolar: true,
  };
  const current = {
    id: attemptId,
    resultId,
    simJobId,
    archiveId: archiveId as string | null,
    payloadText: compact,
    payloadBytes: Buffer.byteLength(compact),
  };
  const projection: AttemptEvidenceProjection = {
    version: 1,
    attemptId,
    archiveId,
    sourceSha256: plan.sourceSha256,
    sourceByteSize: plan.sourceByteSize,
    sourceSemanticSha256: "a".repeat(64),
    compactSha256: reportTextIdentity(compact).sha256,
    compactSemanticSha256: "b".repeat(64),
    removedPaths: plan.historySeries.map((s) => s.path),
    removedLogicalBytes: plan.historySeries.reduce((n, s) => n + s.byteSize, 0),
    values: {},
  };
  const catalog = {
    id: archiveId,
    source_instance: "reader-fixture",
    result_attempt_id: attemptId,
    result_id: resultId,
    sim_job_id: simJobId,
    source_sha256: plan.sourceSha256,
    source_byte_size: String(plan.sourceByteSize),
    history_series: plan.historySeries,
    history_byte_size: String(projection.removedLogicalBytes),
    envelope_sha256: "b".repeat(64),
    envelope_byte_size: "2000",
    stored_sha256: "c".repeat(64),
    stored_byte_size: "1000",
    crc32c: "AAAAAA==",
    bucket: "fixture-evidence",
    object_key: `attempt-evidence/v1/reader-fixture/${attemptId}/${plan.sourceSha256}/${"c".repeat(64)}.json.gz`,
    generation: "18446744073709551615",
    verified_at: new Date(),
  };
  return { source, plan, row, current, projection, catalog };
}
function storage(fixtures: ReturnType<typeof fixture>[]) {
  const execute = vi.fn(async (statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement);
    expect(query.sql.trim()).toMatch(/^SELECT/);
    expect(query.sql).not.toMatch(/UPDATE|INSERT|DELETE|GRANT/i);
    if (
      query.sql.includes("to_regclass('attempt_evidence_history_projections')")
    )
      return [{ ready: true }];
    if (query.sql.includes("FROM result_attempts a"))
      return fixtures
        .filter((f) => query.params.includes(f.row.id))
        .map((f) => ({ ...f.current }));
    if (query.sql.includes("FROM attempt_evidence_history_projections"))
      return fixtures
        .filter((f) => query.params.includes(f.row.id))
        .map((f) => ({
          result_attempt_id: f.row.id,
          archive_id: f.catalog.id,
          projection: f.projection,
        }));
    if (query.sql.includes("FROM attempt_evidence_archives"))
      return fixtures
        .filter((f) => query.params.includes(f.catalog.id))
        .map((f) => ({ ...f.catalog }));
    throw new Error("Unexpected attempt reader query");
  });
  const read = vi.fn(async (identity: { attemptId: string }) => {
    const f = fixtures.find((f) => f.source.attemptId === identity.attemptId);
    if (!f) throw new Error("missing archive");
    return { ...f.source };
  });
  return { db: { execute } as unknown as DB, execute, reader: { read }, read };
}

describe("exact settled attempt evidence consumer", () => {
  it("hydrates only its payload, preserving the selected scientific scalars and original text", async () => {
    const f = fixture(),
      s = storage([f]);
    const hydrated = await hydrateAttemptEvidence(s.db, s.reader, f.row);
    expect(hydrated).toEqual({
      ...f.row,
      evidencePayload: JSON.parse(f.source.payloadText),
    });
    expect(f.row.evidencePayload).toEqual(JSON.parse(f.current.payloadText));
    expect(hydrated.cl).toBe(0.63);
    expect(hydrated.cd).toBe(0.014);
    expect(hydrated.validForPolar).toBe(true);
    expect(await readAttemptEvidenceText(s.db, s.reader, f.row.id)).toBe(
      f.source.payloadText,
    );
    expect(s.read.mock.calls[0][0]).toMatchObject({
      attemptId: f.row.id,
      generation: "18446744073709551615",
    });
  });

  it("deduplicates a repeated original attempt within a batch and keeps request order", async () => {
    const f = fixture(),
      other = fixture(),
      s = storage([f, other]);
    const rows = [
      f.row,
      other.row,
      ...Array.from({ length: 130 }, () => f.row),
    ];
    const hydrated = await hydrateAttemptEvidenceBatch(s.db, s.reader, rows);
    expect(s.read).toHaveBeenCalledTimes(2);
    expect(s.execute).toHaveBeenCalledTimes(4);
    expect(hydrated.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(hydrated[0].evidencePayload).toBe(hydrated[2].evidencePayload);
  });

  it("keeps explicit inline rows fast and resolves projections without pointer fields by stable ID", async () => {
    const f = fixture(),
      s = storage([f]);
    const inline = {
      ...f.row,
      evidenceArchiveId: null,
      evidencePayload: JSON.parse(f.source.payloadText),
    };
    expect(await hydrateAttemptEvidence(s.db, s.reader, inline)).toBe(inline);
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.read).not.toHaveBeenCalled();
    const { evidenceArchiveId: _pointer, ...partial } = f.row;
    expect(
      (await hydrateAttemptEvidence(s.db, s.reader, partial)).evidencePayload,
    ).toEqual(JSON.parse(f.source.payloadText));
    expect(s.read).toHaveBeenCalledTimes(1);
  });

  it("proves GCS readiness explicitly while a full source remains inline, never inferring the newest copy", async () => {
    const f = fixture(),
      s = storage([f]);
    f.current.archiveId = null;
    f.current.payloadText = f.source.payloadText;
    expect(await readAttemptEvidenceText(s.db, s.reader, f.row.id)).toBe(
      f.source.payloadText,
    );
    expect(s.read).not.toHaveBeenCalled();
    await expect(
      readAttemptEvidenceText(s.db, s.reader, f.row.id, {
        requireArchiveRead: true,
      }),
    ).rejects.toThrow(/no authoritative/);
    await expect(
      readAttemptEvidenceText(s.db, s.reader, f.row.id, {
        archiveId: f.catalog.id,
      }),
    ).rejects.toThrow(/stored archive pointer/);
    expect(
      await readAttemptEvidenceText(s.db, s.reader, f.row.id, {
        archiveId: f.catalog.id,
        forceArchive: true,
      }),
    ).toBe(f.source.payloadText);
    expect(s.read).toHaveBeenCalledTimes(1);
  });

  it.each([
    "attempt",
    "result",
    "job",
    "pointer",
    "compact-hash",
    "source-hash",
  ])("refuses a stale %s binding before requesting a body", async (kind) => {
    const f = fixture(),
      s = storage([f]);
    if (kind === "attempt") f.catalog.result_attempt_id = randomUUID();
    if (kind === "result") f.catalog.result_id = randomUUID();
    if (kind === "job") f.catalog.sim_job_id = randomUUID();
    if (kind === "pointer") f.row.evidenceArchiveId = randomUUID();
    if (kind === "compact-hash") f.projection.compactSha256 = "e".repeat(64);
    if (kind === "source-hash") f.projection.sourceSha256 = "e".repeat(64);
    await expect(
      hydrateAttemptEvidence(s.db, s.reader, f.row),
    ).rejects.toThrow();
    expect(s.read).not.toHaveBeenCalled();
  });

  it.each([
    "scalar",
    "certificate",
    "unknown-array",
    "empty-placeholder",
    "null-placeholder",
  ])(
    "refuses altered retained %s even with a matching compact receipt hash",
    async (kind) => {
      const f = fixture(),
        s = storage([f]);
      let text = f.current.payloadText;
      if (kind === "scalar") text = text.replace('"cl":0.63', '"cl":0.64');
      if (kind === "certificate")
        text = text.replace('"mean_stable":true', '"mean_stable":false');
      if (kind === "unknown-array")
        text = text
          .replace('"unknown":[7,8],', "")
          .replace(',"unknown":[7,8]', "");
      if (kind === "empty-placeholder")
        text = text.replace('"window_start":0', '"t":[],"window_start":0');
      if (kind === "null-placeholder")
        text = text.replace('"window_start":0', '"t":null,"window_start":0');
      expect(text).not.toBe(f.current.payloadText);
      f.current.payloadText = text;
      f.projection.compactSha256 = reportTextIdentity(text).sha256;
      await expect(
        hydrateAttemptEvidence(s.db, s.reader, f.row),
      ).rejects.toThrow(/Retained attempt metadata/);
    },
  );

  it("fails unavailable/corrupt stores and mismatched inventory without returning a compact placeholder", async () => {
    const f = fixture(),
      s = storage([f]);
    s.read.mockRejectedValueOnce(new Error("generation missing"));
    await expect(hydrateAttemptEvidence(s.db, s.reader, f.row)).rejects.toThrow(
      /unavailable/,
    );
    s.read.mockResolvedValueOnce({
      ...f.source,
      payloadText: f.source.payloadText.replace("0.63", "0.64"),
    });
    await expect(hydrateAttemptEvidence(s.db, s.reader, f.row)).rejects.toThrow(
      /catalog/,
    );
    f.catalog.history_series = f.catalog.history_series.slice(1);
    await expect(hydrateAttemptEvidence(s.db, s.reader, f.row)).rejects.toThrow(
      /inventory/,
    );
  });

  it("checks every duplicate archive owner rather than reusing another attempt's decoded body", async () => {
    const f = fixture(),
      other = fixture();
    other.current.archiveId = f.catalog.id;
    other.row.evidenceArchiveId = f.catalog.id;
    other.projection.archiveId = f.catalog.id;
    const s = storage([f, other]);
    await expect(
      hydrateAttemptEvidenceBatch(s.db, s.reader, [f.row, other.row]),
    ).rejects.toThrow(/exact current owner/);
  });

  it("honors abort before database reads and after a storage read", async () => {
    const f = fixture(),
      s = storage([f]),
      pre = new AbortController();
    pre.abort();
    await expect(
      hydrateAttemptEvidence(s.db, s.reader, f.row, { signal: pre.signal }),
    ).rejects.toThrow();
    expect(s.execute).not.toHaveBeenCalled();
    const during = new AbortController();
    s.read.mockImplementationOnce(async () => {
      during.abort();
      return f.source;
    });
    await expect(
      hydrateAttemptEvidence(s.db, s.reader, f.row, { signal: during.signal }),
    ).rejects.toThrow();
  });

  it("compares metadata without rounding original numeric tokens", () => {
    expect(
      attemptEvidenceMetadataMatches(
        '{"wide":900719925474099312345}',
        '{"wide":900719925474099300000}',
        [],
      ),
    ).toBe(false);
    expect(attemptEvidenceMetadataMatches('{"n":1.00}', '{"n":1}', [])).toBe(
      true,
    );
  });
});
