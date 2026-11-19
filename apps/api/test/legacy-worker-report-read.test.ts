import { CRC32C, type File } from "@google-cloud/storage";
import { reportTextIdentity } from "@aerodb/db/progressive-report-archive";
import { encodeLegacyPage, type LegacyBackupPage } from "@aerodb/db/legacy-report-storage-codec";
import { legacySha256 } from "../../sweeper/src/legacy-report-storage-gcs";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { readLegacyWorkerReportMember, registerLegacyWorkerReportReadRoutes } from "../src/legacy-worker-report-read";

const cloud = vi.hoisted(() => ({ bucket: vi.fn() }));
vi.mock("@google-cloud/storage", async (original) => ({
  ...(await original<typeof import("@google-cloud/storage")>()),
  Storage: class { bucket = cloud.bucket; },
}));
vi.mock("../src/env", () => ({ env: { evidenceBucket: "operator-backups" } }));
afterEach(() => vi.clearAllMocks());

async function fixture(change?: (page: LegacyBackupPage) => void) {
  const worker = { id: randomUUID(), instanceId: randomUUID() };
  const executionId = randomUUID(), generation = "18446744073709551615", scope = "a".repeat(64);
  const texts = ['{ "wide": 900719925474099312345, "array": [0.10000000000000000001], "x": "é" }', '{"historicalConflict": true, "unknown": [1, null]}'];
  const page: LegacyBackupPage = {
    version: 1, scopeSha256: scope, sourceInstance: worker.instanceId, solverId: worker.id,
    start: { execution: 0, kind: "report", after: 0, copied: 0 },
    next: { execution: 1, kind: "report", after: 0, copied: 0 },
    members: texts.map((text, index) => ({
      kind: index ? "conflict" : "report", executionId, sequence: index + 11,
      solverId: index ? null : worker.id, contentSignature: String(index + 1).repeat(64),
      rowText: `{"sim_job_id":"${executionId}","opaqueOriginal":${index}}`,
      rowSha256: legacySha256(`{"sim_job_id":"${executionId}","opaqueOriginal":${index}}`),
      reportText: text, reportSha256: reportTextIdentity(text).sha256, reportByteSize: Buffer.byteLength(text),
    })),
  };
  change?.(page);
  let bytes = encodeLegacyPage(page).bytes;
  let corrupt = false, lateFailure = false, revoked = false;
  const permission = { canFetch: true, canPush: true };
  let onRead: (() => void) | undefined;
  const streams: Readable[] = [], requests: Array<{ kind: string; generation: unknown }> = [];
  const crc = new CRC32C(); crc.update(bytes);
  const sha = legacySha256(bytes), crc32c = crc.toString();
  const objectKey = `legacy-worker-reports/v1/${worker.instanceId}/${worker.id}/${scope}/${sha}.jsonl.gz`;
  const file = vi.fn((key: string, options: { generation: string }) => {
    expect(key).toBe(objectKey);
    const interceptors: File["interceptors"] = [];
    const request = (kind: string) => {
      let options_: Parameters<File["interceptors"][number]["request"]>[0] = {
        uri: "https://storage.fixture.invalid/object", qs: { generation: Number(options.generation) },
      };
      for (const interceptor of interceptors) options_ = interceptor.request(options_);
      requests.push({ kind, generation: options_.qs.generation });
      if (options_.qs.generation !== generation) throw new Error("missing exact generation");
    };
    return {
      interceptors,
      getMetadata: vi.fn(async () => {
        request("metadata");
        return [{ generation, size: String(bytes.length), crc32c, contentType: "application/gzip" }];
      }),
      createReadStream: vi.fn((settings) => {
        expect(settings).toEqual({ validation: "crc32c", decompress: false });
        request("media");
        const stream = Readable.from((async function* () {
          onRead?.();
          yield corrupt ? Buffer.from("corrupt") : bytes;
          if (lateFailure) throw new Error("late archive failure");
        })());
        streams.push(stream);
        return stream;
      }),
    };
  });
  cloud.bucket.mockImplementation((name) => { expect(name).toBe("operator-backups"); return { file }; });
  const token = "registered-worker-private-token";
  const authenticate = vi.fn(async (req, reply) => {
    if (req.headers["x-xfoilfoam-solver-token"] !== token || revoked) {
      reply.code(401).send({ error: "invalid or revoked credential" }); return null;
    }
    return { ...worker };
  });
  const permit = vi.fn(async () => permission.canFetch);
  const app = Fastify();
  await registerLegacyWorkerReportReadRoutes(app, { authenticate, permit });
  const query = (index = 0) => ({ bucket: "operator-backups", generation, byteSize: bytes.length, crc32c,
    executionId, kind: page.members[index].kind, sequence: page.members[index].sequence,
    signature: page.members[index].contentSignature, reportSha256: page.members[index].reportSha256,
    reportByteSize: page.members[index].reportByteSize });
  const url = (patch: Record<string, unknown> = {}, index = 0) =>
    `/api/sync/v1/legacy-worker-report-archives/${scope}/${sha}/member?${new URLSearchParams(Object.entries({ ...query(index), ...patch }).map(([k,v]): [string, string] => [k,String(v)]))}`;
  const headers = { "x-xfoilfoam-solver-token": token };
  return { app, worker, page, texts, sha, scope, generation, objectKey, streams, requests, file, headers, url, query, authenticate, permit,
    corrupt: () => { corrupt = true; }, failLate: () => { lateFailure = true; },
    permission,
    onRead: (fn: () => void) => { onRead = fn; }, revoke: () => { revoked = true; }, deny: () => { permission.canFetch = false; },
    replaceBytes: (replacement: Buffer) => { bytes = replacement; },
  };
}

it("reads only exact original report/conflict bytes without a dispatch or any write capability", async () => {
  const f = await fixture();
  try {
    for (const index of [0, 1]) {
      const response = await f.app.inject({ url: f.url({}, index), headers: f.headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.rawPayload).toEqual(Buffer.from(f.texts[index]));
      expect(response.headers["x-report-archive-object-key"]).toBe(f.objectKey);
      expect(response.headers["x-gcs-generation"]).toBe(f.generation);
      expect(response.headers["x-report-kind"]).toBe(index ? "conflict" : "report");
    }
    expect(f.requests.every((r) => r.generation === f.generation && typeof r.generation === "string")).toBe(true);
    expect(f.requests.map((r) => r.kind)).toContain("metadata");
    expect(f.requests.map((r) => r.kind)).toContain("media");
    expect((await f.app.inject({ method: "POST", url: f.url(), headers: f.headers, payload: {} })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "PUT", url: f.url(), headers: f.headers, payload: {} })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "HEAD", url: f.url(), headers: f.headers })).statusCode).toBe(404);
  } finally { await f.app.close(); }
});

it("keeps current token/permission checks and rejects arbitrary paths/buckets before reading", async () => {
  const f = await fixture();
  try {
    expect((await f.app.inject({ url: f.url() })).statusCode).toBe(401);
    expect((await f.app.inject({ url: f.url({ objectKey: "foreign/object" }), headers: f.headers })).statusCode).toBe(400);
    expect((await f.app.inject({ url: f.url({ bucket: "other-worker-bucket" }), headers: f.headers })).statusCode).toBe(409);
    expect(f.file).not.toHaveBeenCalled();
    f.deny();
    expect((await f.app.inject({ url: f.url(), headers: f.headers })).statusCode).toBe(403);
    expect(f.file).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});

it("fails closed for production can_fetch=false even with can_push=true and leaves permissions unchanged", async () => {
  const f = await fixture();
  try {
    f.permission.canFetch = false;
    f.permission.canPush = true;
    const response = await f.app.inject({ url: f.url(), headers: f.headers });
    expect(response.statusCode).toBe(403);
    expect(f.permission).toEqual({ canFetch: false, canPush: true });
    expect(cloud.bucket).not.toHaveBeenCalled();
    expect(f.file).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});

it.each(["sourceInstance", "solverId", "scopeSha256"] as const)("rejects a foreign decoded page %s", async (field) => {
  const f = await fixture((page) => { page[field] = field === "scopeSha256" ? "b".repeat(64) : randomUUID(); });
  try { expect((await f.app.inject({ url: f.url(), headers: f.headers })).statusCode).toBe(409); }
  finally { await f.app.close(); }
});

it("authenticates every decoded member before releasing the requested one", async () => {
  const f = await fixture((page) => { page.members[1].reportSha256 = "d".repeat(64); });
  try { expect((await f.app.inject({ url: f.url(), headers: f.headers })).statusCode).toBe(409); }
  finally { await f.app.close(); }
});

it.each(["executionId", "kind", "sequence", "signature", "reportSha256", "reportByteSize"])("requires the exact requested member %s", async (field) => {
  const f = await fixture();
  const different = { executionId: randomUUID(), kind: "conflict", sequence: 99, signature: "b".repeat(64), reportSha256: "b".repeat(64), reportByteSize: 1 };
  try { expect((await f.app.inject({ url: f.url({ [field]: different[field as keyof typeof different] }), headers: f.headers })).statusCode).toBe(409); }
  finally { await f.app.close(); }
});

it("checks compressed CRC/SHA, EOF, uint64 range and byte limits", async () => {
  const f = await fixture();
  try {
    expect((await f.app.inject({ url: f.url({ crc32c: "AAAAAA==" }), headers: f.headers })).statusCode).toBe(409);
    for (const patch of [{ byteSize: 256 * 1024 ** 2 + 1 }, { reportByteSize: 64 * 1024 ** 2 + 1 }, { generation: "18446744073709551616" }, { generation: "NaN" }, { sequence: "9007199254740992" }])
      expect((await f.app.inject({ url: f.url(patch), headers: f.headers })).statusCode).toBe(400);
    f.failLate();
    expect((await f.app.inject({ url: f.url(), headers: f.headers })).statusCode).toBe(409);
    f.corrupt();
    expect((await f.app.inject({ url: f.url(), headers: f.headers })).statusCode).toBe(409);
  } finally { await f.app.close(); }
});

it.each(["token", "instance", "permission"])("rechecks %s after reading and never releases stale authority", async (kind) => {
  const f = await fixture();
  try {
    f.onRead(() => { if (kind === "token") f.revoke(); else if (kind === "instance") f.worker.instanceId = randomUUID(); else f.deny(); });
    const response = await f.app.inject({ url: f.url(), headers: f.headers });
    expect([401, 403, 409]).toContain(response.statusCode);
    expect(response.body).not.toContain(f.texts[0]);
  } finally { await f.app.close(); }
});

it("honors abort before GCS and cancels a media read", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    controller.abort();
    await expect(readLegacyWorkerReportMember(f.worker, f.scope, f.sha, f.query(), controller.signal)).rejects.toThrow();
    expect(f.file).not.toHaveBeenCalled();
    const during = new AbortController();
    f.onRead(() => during.abort());
    await expect(readLegacyWorkerReportMember(f.worker, f.scope, f.sha, f.query(), during.signal)).rejects.toThrow();
    expect(f.streams.every((s) => s.destroyed)).toBe(true);
  } finally { await f.app.close(); }
});
