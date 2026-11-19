import type { DB } from "@aerodb/db/client";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CRC32C } from "@google-cloud/storage";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { encodeLegacyPage, type LegacyBackupPage } from "@aerodb/db/legacy-report-storage-codec";
import {
  readLegacyWorkerProductPage, parseLegacyWorkerProductReadRequest, legacyWorkerProductReaderIdentity,
  type LegacyWorkerProductReadRequest,
} from "../src/legacy-worker-report-product-read";
import { legacyWorkerReportProductReadCli } from "../src/legacy-worker-report-product-read-cli";
import { readLegacyWorkerReportArchivePage } from "../src/legacy-worker-report-read";
import type { LegacyReportPageReadIdentity } from "@aerodb/db/legacy-report-custody";

const calls = vi.hoisted(() => ({ read: vi.fn(), decode: vi.fn(), connect: vi.fn(), query: vi.fn(), sql: vi.fn(), end: vi.fn(), network: vi.fn() }));
vi.mock("@aerodb/db/client", () => ({ createClient: calls.connect }));
vi.mock("../src/worker-report-volume", async (original) => ({
  ...(await original<typeof import("../src/worker-report-volume")>()), readWorkerReportVolume: calls.read,
}));
vi.mock("@aerodb/db/legacy-report-storage-codec", async (original) => ({
  ...(await original<typeof import("@aerodb/db/legacy-report-storage-codec")>()), readLegacyPageMembers: calls.decode,
}));
const roots: string[] = [];
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
beforeEach(async (): Promise<void> => {
  const volume = await vi.importActual<typeof import("../src/worker-report-volume")>("../src/worker-report-volume");
  const codec = await vi.importActual<typeof import("@aerodb/db/legacy-report-storage-codec")>("@aerodb/db/legacy-report-storage-codec");
  calls.read.mockReset().mockImplementation(volume.readWorkerReportVolume);
  calls.decode.mockReset().mockImplementation(codec.readLegacyPageMembers);
  calls.query.mockReset(); calls.sql.mockReset().mockResolvedValue([]); calls.end.mockReset().mockResolvedValue(undefined);
  calls.connect.mockReset().mockReturnValue({ db: { execute: calls.query }, sql: Object.assign(calls.sql, { end: calls.end }) });
  calls.network.mockReset().mockRejectedValue(new Error("Product page proof must not use the network"));
  vi.stubGlobal("fetch", calls.network);
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
  vi.stubEnv("AIRFOILFOAM_BUILD_ID", "page-reader-fixture-build");
  vi.stubEnv("DATABASE_URL", "postgres://unused-fixture.invalid/never-connected");
});
afterEach(async (): Promise<void> => {
  try { expect(calls.network).not.toHaveBeenCalled(); }
  finally {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }
});

async function fixture(count = 128, change?: (page: LegacyBackupPage) => void) {
  const sourceInstance = randomUUID(), solverId = randomUUID(), executionId = randomUUID(), scopeSha256 = "b".repeat(64);
  const page: LegacyBackupPage = {
    version: 1, sourceInstance, solverId, scopeSha256,
    start: { execution: 0, kind: "report", after: 0, copied: 0 }, next: { execution: 1, kind: "report", after: 0, copied: 0 },
    members: Array.from({ length: count }, (_, i) => {
      const sequence = i + 1, signature = sha(`signature-${sequence}`);
      const reportText = `{ "sequence": ${sequence}, "wide": 9007199254740993123456789, "small": 0.10000000000000000001, "private": "fixture-${sequence}" }`;
      const rowText = `{"sim_job_id":"${executionId}","sequence":${sequence},"report":${reportText}}`;
      return { kind: i % 16 === 0 ? "conflict" as const : "report" as const, executionId, sequence,
        solverId, contentSignature: signature, rowText, rowSha256: sha(rowText), reportText,
        reportSha256: sha(reportText), reportByteSize: Buffer.byteLength(reportText) };
    }),
  };
  const members = page.members.map((m) => ({ executionId: m.executionId, sequence: m.sequence, kind: m.kind,
    contentSignature: m.contentSignature, reportSha256: m.reportSha256, reportByteSize: m.reportByteSize,
    rowSha256: m.rowSha256, rowByteSize: Buffer.byteLength(m.rowText) }));
  change?.(page);
  const bytes = encodeLegacyPage(page).bytes, crc = new CRC32C(); crc.update(bytes);
  const request: LegacyWorkerProductReadRequest = {
    version: 1, sourceInstance, solverId, scopeSha256,
    object: { bucket: "operator-fixture", objectKey: `legacy-worker-reports/v1/${sourceInstance}/${solverId}/${scopeSha256}/${sha(bytes)}.jsonl.gz`,
      generation: "18446744073709551615", sha256: sha(bytes), byteSize: bytes.length, crc32c: crc.toString(), verifiedAt: "2026-11-19T00:00:00.000Z" },
    members,
  };
  const root = await mkdtemp(join(tmpdir(), "legacy-product-page-")); roots.push(root);
  vi.stubEnv("AIRFOILFOAM_REPORT_VOLUME_DIR", join(root, "volume"));
  const packedPath = join(root, "packed.jsonl.gz"); await writeFile(packedPath, bytes, { mode: 0o600 });
  const actual = await vi.importActual<typeof import("../src/worker-report-volume")>("../src/worker-report-volume");
  await actual.retainWorkerReportVolume(packedPath, { storedSha256: request.object.sha256, storedByteSize: request.object.byteSize });
  const owner = { source_instance: sourceInstance, solver_id: solverId };
  calls.query.mockImplementation(async (statement: SQL) => {
    const sql = new PgDialect().sqlToQuery(statement);
    expect(sql.sql.trim()).toMatch(/^SELECT/); expect(sql.sql).toContain("FROM sync_api_settings");
    expect(sql.sql).not.toMatch(/dispatch|promise|INSERT|UPDATE|DELETE|GRANT/i);
    return [{ ...owner }];
  });
  return { request, page, bytes, owner, db: { execute: calls.query } as unknown as DB };
}

it("reads one actual retained object and decodes once for all128 member proofs", async () => {
  const f = await fixture();
  const proof = await readLegacyWorkerProductPage(f.db, f.request);
  expect(calls.read).toHaveBeenCalledTimes(1); expect(calls.decode).toHaveBeenCalledTimes(1);
  expect(calls.query).toHaveBeenCalledTimes(2);
  expect(proof).toMatchObject({ verified: true, readSource: "worker-report-volume", volumeObjectReads: 1, decoderPasses: 1,
    memberCount: 128, storedBytesRead: f.bytes.length, object: { generation: "18446744073709551615" } });
  expect(proof.members).toEqual(f.request.members);
  expect(proof.memberProofSha256).toBe(sha(JSON.stringify(proof.members)));
  expect(proof.storageKey).toBe(`report-archives/v1/${f.request.object.sha256.slice(0, 2)}/${f.request.object.sha256}.jsonl.gz`);
  expect(proof.readMode).toBe("hub-local-reader"); expect(proof.durableAt).toBe(proof.checkedAt);
  expect(proof.readerSha256).toMatch(/^[a-f0-9]{64}$/); expect(proof.codecSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(proof)).not.toContain("9007199254740993123456789");
  expect(JSON.stringify(proof)).not.toContain("private");
});

it("implements the custody worker's installed page-reader interface with one real volume reopen", async () => {
  const f = await fixture();
  const identity: LegacyReportPageReadIdentity = {
    sourceKind: "worker", archiveFormat: "legacy-jsonl", mimeType: "application/gzip", compression: "gzip",
    bucket: f.request.object.bucket, objectKey: f.request.object.objectKey, generation: f.request.object.generation,
    storedSha256: f.request.object.sha256, storedByteSize: f.request.object.byteSize, crc32c: f.request.object.crc32c,
    legacyInstanceId: f.request.sourceInstance, legacySolverId: f.request.solverId, legacyScopeSha256: f.request.scopeSha256,
    legacyPageMemberCount: f.request.members.length, legacyReadMode: "hub-local-reader",
    members: f.request.members as Required<(typeof f.request.members)[number]>[], signal: new AbortController().signal,
  };
  const local = await readLegacyWorkerReportArchivePage(f.db, identity);
  expect(local.storedBytes).toEqual(f.bytes);
  expect(local.storageKey).toBe(`report-archives/v1/${identity.storedSha256.slice(0, 2)}/${identity.storedSha256}.jsonl.gz`);
  expect(Date.parse(local.durableAt)).toBeGreaterThan(0);
  expect(local.proof.memberCount).toBe(128);
  expect(calls.read).toHaveBeenCalledTimes(1); expect(calls.decode).toHaveBeenCalledTimes(1);
  await expect(readLegacyWorkerReportArchivePage(f.db, { ...identity, legacyReadMode: "registered-get" })).rejects.toThrow(/local legacy/);
  expect(calls.read).toHaveBeenCalledTimes(1);
});

it("runs the installed CLI path with typed stdin, one page read, read-only session and bounded stdout", async () => {
  const f = await fixture(), output: string[] = [];
  const input = JSON.stringify({ ...f.request, expectedBuildId: "page-reader-fixture-build", ...{
    expectedReaderSha256: (await legacyWorkerProductReaderIdentity()).readerSha256,
    expectedCodecSha256: (await legacyWorkerProductReaderIdentity()).codecSha256,
  } }) + "\n";
  await legacyWorkerReportProductReadCli([], { input: Readable.from([input]), write: (text) => { output.push(text); } });
  expect(output).toHaveLength(1); expect(Buffer.byteLength(output[0])).toBeLessThan(256 * 1024);
  expect(JSON.parse(output[0])).toMatchObject({ verified: true, memberCount: 128, requestSha256: sha(input) });
  expect(calls.read).toHaveBeenCalledTimes(1); expect(calls.decode).toHaveBeenCalledTimes(1);
  expect(calls.connect).toHaveBeenCalledWith({ url: process.env.DATABASE_URL, max: 1 });
  expect(calls.sql.mock.calls.map(([strings]) => strings.join(""))).toEqual(["SET default_transaction_read_only = on", "SET statement_timeout = '10s'"]);
  expect(calls.end).toHaveBeenCalledTimes(1);
});

it("supports node-api with an unset role by proving DB ownership, without admitting an explicit hub role", async () => {
  const f = await fixture(2), output: string[] = [];
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "");
  await legacyWorkerReportProductReadCli([], { input: Readable.from([JSON.stringify(f.request)]), write: (text) => { output.push(text); } });
  expect(JSON.parse(output[0]).memberCount).toBe(2); expect(calls.query).toHaveBeenCalledTimes(2);
  calls.connect.mockClear(); calls.read.mockClear(); calls.decode.mockClear();
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
  await expect(legacyWorkerReportProductReadCli([], { input: Readable.from([JSON.stringify(f.request)]), write() {} })).rejects.toThrow(/source worker DB/);
  expect(calls.connect).not.toHaveBeenCalled(); expect(calls.read).not.toHaveBeenCalled();
});

it.each(["missing", "duplicate", "changed-hash", "changed-signature", "changed-row"])("refuses %s members instead of certifying a subset", async (kind) => {
  const f = await fixture(3);
  if (kind === "missing") f.request.members.pop();
  if (kind === "duplicate") f.request.members[1] = f.request.members[0];
  if (kind === "changed-hash") f.request.members[0].reportSha256 = "a".repeat(64);
  if (kind === "changed-signature") f.request.members[0].contentSignature = "a".repeat(64);
  if (kind === "changed-row") f.request.members[0].rowSha256 = "a".repeat(64);
  await expect(readLegacyWorkerProductPage(f.db, f.request)).rejects.toThrow();
  expect(calls.read.mock.calls.length).toBeLessThanOrEqual(1); expect(calls.decode.mock.calls.length).toBeLessThanOrEqual(1);
});

it("refuses a foreign decoded source and current local owner changes", async () => {
  const f = await fixture(2, (page) => { page.sourceInstance = randomUUID(); });
  await expect(readLegacyWorkerProductPage(f.db, f.request)).rejects.toThrow(/decoded page/);
  const owned = await fixture(2);
  owned.owner.solver_id = randomUUID();
  calls.read.mockClear(); calls.decode.mockClear();
  await expect(readLegacyWorkerProductPage(owned.db, owned.request)).rejects.toThrow(/current local worker/);
  expect(calls.read).not.toHaveBeenCalled(); expect(calls.decode).not.toHaveBeenCalled();
});

it("rechecks the current local instance after the one page read before issuing proof", async () => {
  const f = await fixture(2);
  calls.query.mockResolvedValueOnce([{ ...f.owner }])
    .mockResolvedValueOnce([{ ...f.owner, source_instance: randomUUID() }]);
  await expect(readLegacyWorkerProductPage(f.db, f.request)).rejects.toThrow(/current local worker/);
  expect(calls.read).toHaveBeenCalledTimes(1); expect(calls.decode).toHaveBeenCalledTimes(1);
});

it("checks packed SHA/CRC/size and clean EOF before decoding", async () => {
  const f = await fixture(2);
  for (const bytes of [f.bytes.subarray(0, -1), Buffer.concat([f.bytes, Buffer.from("extra")]), Buffer.alloc(f.bytes.length)]) {
    calls.read.mockResolvedValueOnce(Readable.from([bytes]));
    await expect(readLegacyWorkerProductPage(f.db, f.request)).rejects.toThrow();
  }
  const badCrc = (f.request.object.crc32c[0] === "A" ? "B" : "A") + f.request.object.crc32c.slice(1);
  await expect(readLegacyWorkerProductPage(f.db, { ...f.request, object: { ...f.request.object, crc32c: badCrc } })).rejects.toThrow(/CRC/);
  calls.read.mockResolvedValueOnce(Readable.from((async function* () { yield f.bytes; throw new Error("late EOF failure"); })()));
  await expect(readLegacyWorkerProductPage(f.db, f.request)).rejects.toThrow(/late EOF failure/);
  expect(calls.decode).not.toHaveBeenCalled();
});

it("fails missing working copies without a network fallback or a proof line", async () => {
  const f = await fixture(2), output: string[] = [];
  calls.read.mockResolvedValueOnce(null);
  await expect(legacyWorkerReportProductReadCli([], { input: Readable.from([JSON.stringify(f.request)]), write: (text) => { output.push(text); } })).rejects.toThrow(/missing/);
  expect(output).toEqual([]); expect(calls.end).toHaveBeenCalledTimes(1);
});

it("rejects malformed or rounded typed input before opening the database", async () => {
  const f = await fixture(1), original = JSON.stringify(f.request);
  for (const invalid of [
    original.replace('"version":1', '"version":1,"version":1'),
    original.replace('"sequence":1', '"sequence":0.999999999999999999'),
    JSON.stringify({ ...f.request, object: { ...f.request.object, generation: "18446744073709551616" } }),
    JSON.stringify({ ...f.request, members: Array.from({ length: 129 }, () => f.request.members[0]) }),
    JSON.stringify({ ...f.request, unexpected: "reject" }),
  ]) {
    expect(() => parseLegacyWorkerProductReadRequest(invalid)).toThrow();
    await expect(legacyWorkerReportProductReadCli([], { input: Readable.from([invalid]), write() {} })).rejects.toThrow();
  }
  expect(calls.connect).not.toHaveBeenCalled(); expect(calls.read).not.toHaveBeenCalled();
});

it("refuses a stale installed source/build and honors abort", async () => {
  const f = await fixture(1);
  await expect(readLegacyWorkerProductPage(f.db, { ...f.request, expectedReaderSha256: "0".repeat(64) })).rejects.toThrow(/Installed reader/);
  await expect(readLegacyWorkerProductPage(f.db, { ...f.request, expectedCodecSha256: "0".repeat(64) })).rejects.toThrow(/Installed reader/);
  await expect(readLegacyWorkerProductPage(f.db, { ...f.request, expectedBuildId: "different-build" })).rejects.toThrow(/Installed reader/);
  expect(calls.read).not.toHaveBeenCalled();
  const controller = new AbortController();
  const source = new Readable({ read() { queueMicrotask(() => controller.abort()); } });
  calls.read.mockResolvedValueOnce(source);
  await expect(readLegacyWorkerProductPage(f.db, f.request, controller.signal)).rejects.toThrow();
  expect(source.destroyed).toBe(true); expect(calls.decode).not.toHaveBeenCalled();
});
