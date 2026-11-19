import type { DB } from "@aerodb/db/client";
import { reportTextIdentity, type ProgressiveReportArchiveReadIdentity } from "@aerodb/db/progressive-report-archive";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRC32C } from "@google-cloud/storage";
import { Readable } from "node:stream";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readLegacyWorkerReportArchiveText, readLegacyWorkerReportFromHub } from "../src/legacy-worker-report-read";
import { encodeLegacyPage, type LegacyBackupPage } from "@aerodb/db/legacy-report-storage-codec";
import { legacySha256 } from "../src/legacy-report-storage-gcs";

const volume = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/worker-report-volume", () => ({ readWorkerReportVolume: volume.read }));
beforeEach((): void => {
  // Returning the mock would register it as a teardown and call it without an identity.
  volume.read.mockReset().mockResolvedValue(null);
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function fixture() {
  const settings = { source_instance: randomUUID(), solver_id: randomUUID(), auth_token: "private-worker-token", upstream_base_url: "https://trusted-hub.example/api/sync/v1" };
  const text = '{ "number": 90071992547409931234567890, "small": 0.10000000000000000001, "text": "é" }';
  const proof = reportTextIdentity(text), hash = "a".repeat(64), scope = "b".repeat(64);
  const identity: ProgressiveReportArchiveReadIdentity = {
    bucket: "operator-backups", objectKey: `legacy-worker-reports/v1/${settings.source_instance}/${settings.solver_id}/${scope}/${hash}.jsonl.gz`,
    generation: "18446744073709551615", mimeType: "application/gzip", compression: "gzip", archiveFormat: "legacy-jsonl",
    storedSha256: hash, storedByteSize: 1234, crc32c: "AAAAAA==", sourceKind: "worker", memberKind: "report",
    executionId: randomUUID(), sequence: 42, signature: "c".repeat(64), reportSha256: proof.sha256, reportByteSize: proof.byteSize,
  };
  const execute = vi.fn(async (statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement);
    expect(query.sql.trim()).toMatch(/^SELECT/);
    expect(query.sql).toContain("FROM sync_api_settings");
    expect(query.sql).not.toMatch(/dispatch|sim_jobs|promise|INSERT|UPDATE|DELETE|GRANT/i);
    return [settings];
  });
  const db = { execute } as unknown as DB;
  const headers = () => ({
    "content-type": "application/json; charset=utf-8", "content-length": String(identity.reportByteSize),
    "x-content-sha256": identity.reportSha256, "x-report-signature": identity.signature,
    "x-report-execution-id": identity.executionId, "x-report-kind": identity.memberKind, "x-report-sequence": String(identity.sequence),
    "x-report-archive-bucket": identity.bucket, "x-report-archive-object-key": identity.objectKey,
    "x-gcs-generation": identity.generation, "x-archive-sha256": identity.storedSha256,
    "x-archive-byte-size": String(identity.storedByteSize), "x-archive-crc32c": identity.crc32c,
  });
  const request = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://trusted-hub.example");
    expect(parsed.pathname).toBe(`/api/sync/v1/legacy-worker-report-archives/${scope}/${hash}/member`);
    expect(parsed.searchParams.get("generation")).toBe(identity.generation);
    expect(parsed.searchParams.get("executionId")).toBe(identity.executionId);
    expect(parsed.searchParams.get("signature")).toBe(identity.signature);
    expect(parsed.searchParams.has("objectKey")).toBe(false);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("x-xfoilfoam-solver-token")).toBe(settings.auth_token);
    return new Response(Buffer.from(text), { headers: headers() });
  });
  vi.stubGlobal("fetch", request);
  return { settings, identity, text, db, execute, headers, request };
}

function localPage(f: ReturnType<typeof fixture>, change?: (page: LegacyBackupPage) => void) {
  const scope = "b".repeat(64), proof = reportTextIdentity(f.text);
  const page: LegacyBackupPage = {
    version: 1, sourceInstance: f.settings.source_instance, solverId: f.settings.solver_id, scopeSha256: scope,
    start: { execution: 0, kind: "report", after: 0, copied: 0 }, next: { execution: 1, kind: "report", after: 0, copied: 0 },
    members: [{ kind: f.identity.memberKind, executionId: f.identity.executionId, sequence: f.identity.sequence,
      solverId: f.identity.memberKind === "conflict" ? null : f.settings.solver_id, contentSignature: f.identity.signature,
      rowText: "{}", rowSha256: legacySha256("{}"), reportText: f.text, reportSha256: proof.sha256, reportByteSize: proof.byteSize }],
  };
  change?.(page);
  const bytes = encodeLegacyPage(page).bytes, crc = new CRC32C(); crc.update(bytes);
  f.identity.storedSha256 = legacySha256(bytes); f.identity.storedByteSize = bytes.length; f.identity.crc32c = crc.toString();
  f.identity.objectKey = `legacy-worker-reports/v1/${f.settings.source_instance}/${f.settings.solver_id}/${scope}/${f.identity.storedSha256}.jsonl.gz`;
  volume.read.mockResolvedValue(Readable.from([bytes]));
  return bytes;
}

it("uses an actual private compressed working copy with no network grant or fetch", async () => {
  const f = fixture(), bytes = localPage(f);
  const root = await mkdtemp(join(tmpdir(), "legacy-worker-local-")), sourcePath = join(root, "source.jsonl.gz");
  vi.stubEnv("AIRFOILFOAM_REPORT_VOLUME_DIR", join(root, "volume"));
  const actual = await vi.importActual<typeof import("../src/worker-report-volume")>("../src/worker-report-volume");
  try {
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    await actual.retainWorkerReportVolume(sourcePath, f.identity);
    volume.read.mockImplementation((identity) => actual.readWorkerReportVolume(identity));
    f.request.mockImplementation(async () => new Response("fetch disabled", { status: 403 }));
    expect(await readLegacyWorkerReportArchiveText(f.db, f.identity)).toBe(f.text);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(2); // Current local ownership rechecked after decode.
    await expect(readLegacyWorkerReportFromHub(f.db, f.identity)).rejects.toThrow(/403/);
    expect(f.request).toHaveBeenCalledTimes(1); // Network-only export never substitutes the local copy.
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("can read the worker's original local bytes without a usable upstream token", async () => {
  const f = fixture(); localPage(f);
  f.settings.auth_token = "";
  expect(await readLegacyWorkerReportArchiveText(f.db, f.identity)).toBe(f.text);
  await expect(readLegacyWorkerReportFromHub(f.db, f.identity)).rejects.toThrow(/authenticated upstream/);
  expect(f.request).not.toHaveBeenCalled();
});

it("reads an exact local conflict as forensic bytes without turning it into a result", async () => {
  const f = fixture(); f.identity.memberKind = "conflict"; localPage(f);
  expect(await readLegacyWorkerReportArchiveText(f.db, f.identity)).toBe(f.text);
  expect(f.request).not.toHaveBeenCalled();
});

it.each(["sourceInstance", "solverId", "scopeSha256"] as const)("rejects a foreign local decoded %s without trying the hub", async (field) => {
  const f = fixture(); localPage(f, (page) => { page[field] = field === "scopeSha256" ? "d".repeat(64) : randomUUID(); });
  await expect(readLegacyWorkerReportArchiveText(f.db, f.identity)).rejects.toThrow(/source\/scope/);
  expect(f.request).not.toHaveBeenCalled();
});

it.each(["executionId", "memberKind", "sequence", "signature", "reportSha256", "reportByteSize"])("requires the exact local member %s without fetching another source", async (field) => {
  const f = fixture(); localPage(f);
  const patches = { executionId: randomUUID(), memberKind: "conflict", sequence: 99, signature: "d".repeat(64), reportSha256: "d".repeat(64), reportByteSize: 1 };
  await expect(readLegacyWorkerReportArchiveText(f.db, { ...f.identity, [field]: patches[field as keyof typeof patches] } as ProgressiveReportArchiveReadIdentity)).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});

it("verifies the complete local SHA/CRC/EOF, rejects damage and never masks it with a network read", async () => {
  const f = fixture(), bytes = localPage(f);
  for (const wrong of [bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from("extra")]), Buffer.from("corrupt")]) {
    volume.read.mockResolvedValue(Readable.from([wrong]));
    await expect(readLegacyWorkerReportArchiveText(f.db, f.identity)).rejects.toThrow();
  }
  volume.read.mockResolvedValue(Readable.from([bytes]));
  await expect(readLegacyWorkerReportArchiveText(f.db, { ...f.identity, crc32c: "BBBBBB==" })).rejects.toThrow(/CRC/);
  expect(f.request).not.toHaveBeenCalled();
});

it("aborts a stalled local stream and closes it", async () => {
  const f = fixture(); localPage(f);
  const controller = new AbortController();
  const source = new Readable({ read() { queueMicrotask(() => controller.abort()); } });
  volume.read.mockResolvedValue(source);
  const result = readLegacyWorkerReportArchiveText(f.db, { ...f.identity, signal: controller.signal });
  await expect(result).rejects.toThrow();
  expect(source.destroyed).toBe(true);
  expect(f.request).not.toHaveBeenCalled();
});

it("restores exact PG text with current registered credentials and no historical dispatch query", async () => {
  const f = fixture();
  expect(await readLegacyWorkerReportArchiveText(f.db, f.identity)).toBe(f.text);
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.request).toHaveBeenCalledTimes(1);
});

it("reads a conflict with the same byte proof and no publication/claim fallback", async () => {
  const f = fixture(); f.identity.memberKind = "conflict";
  expect(await readLegacyWorkerReportArchiveText(f.db, f.identity)).toBe(f.text);
  expect(f.request).toHaveBeenCalledTimes(1);
});

it.each(["instance", "solver", "namespace", "hash"])("refuses a foreign %s key before sending credentials", async (part) => {
  const f = fixture();
  const pieces = f.identity.objectKey.split("/");
  if (part === "instance") pieces[2] = randomUUID();
  if (part === "solver") pieces[3] = randomUUID();
  if (part === "namespace") pieces[0] = "progressive-reports";
  if (part === "hash") pieces[5] = `${"d".repeat(64)}.jsonl.gz`;
  f.identity.objectKey = pieces.join("/");
  await expect(readLegacyWorkerReportArchiveText(f.db, f.identity)).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});

it.each(["upstream", "token", "registration"])("requires the current %s before sending anything", async (part) => {
  const f = fixture();
  if (part === "upstream") f.settings.upstream_base_url = "https://untrusted.example/wrong/path";
  if (part === "token") f.settings.auth_token = "";
  if (part === "registration") f.settings.solver_id = randomUUID();
  await expect(readLegacyWorkerReportArchiveText(f.db, f.identity)).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});

it.each(["x-gcs-generation", "x-content-sha256", "x-report-signature", "x-report-execution-id", "x-report-kind", "x-report-sequence", "x-report-archive-bucket", "x-report-archive-object-key", "x-archive-sha256", "x-archive-byte-size", "x-archive-crc32c", "content-length"])("rejects a changed response %s", async (header) => {
  const f = fixture();
  f.request.mockImplementation(async () => new Response(f.text, { headers: { ...f.headers(), [header]: "changed" } }));
  await expect(readLegacyWorkerReportArchiveText(f.db, f.identity)).rejects.toThrow(/response differs/);
});

it("fails a denied registered GET closed without operator/upload/dispatch fallback", async () => {
  const f = fixture();
  f.request.mockImplementation(async () => new Response('{"error":"fetch disabled"}', { status: 403, headers: { "content-type": "application/json" } }));
  await expect(readLegacyWorkerReportFromHub(f.db, f.identity)).rejects.toThrow(/403/);
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(volume.read).not.toHaveBeenCalled();
});

it("rejects truncated, changed and excessive member bodies even with matching identity headers", async () => {
  const f = fixture();
  for (const text of [f.text.slice(0, -1), f.text.replace('"small"', '"SMALL"'), f.text + " "]) {
    f.request.mockImplementation(async () => new Response(text, { headers: f.headers() }));
    await expect(readLegacyWorkerReportArchiveText(f.db, f.identity)).rejects.toThrow(/verification|byte bound/);
  }
});

it("requires clean response EOF after all expected bytes arrive", async () => {
  const f = fixture(); let sent = false;
  f.request.mockImplementation(async () => new Response(new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(Buffer.from(f.text)); }
    else controller.error(new Error("late response failure"));
  } }), { headers: f.headers() }));
  await expect(readLegacyWorkerReportFromHub(f.db, f.identity)).rejects.toThrow(/late response failure/);
});

it("enforces request format/limits before reading settings or making network calls", async () => {
  const f = fixture();
  for (const patch of [
    { archiveFormat: "jsonl" }, { generation: "18446744073709551616" }, { sourceKind: "remote" },
    { storedByteSize: 256 * 1024 ** 2 + 1 }, { reportByteSize: 64 * 1024 ** 2 + 1 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
  ]) await expect(readLegacyWorkerReportArchiveText(f.db, { ...f.identity, ...patch } as ProgressiveReportArchiveReadIdentity)).rejects.toThrow();
  expect(f.execute).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});

it("cancels a stalled response on abort and refuses a pre-aborted read", async () => {
  const f = fixture(), pre = new AbortController(); pre.abort();
  await expect(readLegacyWorkerReportArchiveText(f.db, { ...f.identity, signal: pre.signal })).rejects.toThrow();
  expect(f.execute).not.toHaveBeenCalled();
  const during = new AbortController(), cancelled = vi.fn();
  f.request.mockImplementation(async () => new Response(new ReadableStream({
    start() { queueMicrotask(() => during.abort()); }, cancel: cancelled,
  }), { headers: f.headers() }));
  await expect(readLegacyWorkerReportArchiveText(f.db, { ...f.identity, signal: during.signal })).rejects.toThrow();
  expect(cancelled).toHaveBeenCalled();
});
