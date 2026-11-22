import { CRC32C, type File } from "@google-cloud/storage";
import {
  reportTextIdentity,
  type ProgressiveReportArchiveReadIdentity,
} from "@aerodb/db/progressive-report-archive";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { beforeEach, expect, it, vi } from "vitest";
import { readProgressiveReportArchive } from "../src/progressive-report-archive-reader";

const gcs = vi.hoisted(() => ({
  bucket: vi.fn(),
  file: vi.fn(),
  getMetadata: vi.fn(),
  read: vi.fn(),
}));
vi.mock("../src/env", () => ({ env: { evidenceBucket: "fixture-bucket" } }));
vi.mock("@google-cloud/storage", async (original) => ({
  ...(await original<typeof import("@google-cloud/storage")>()),
  Storage: class {
    bucket = gcs.bucket;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  gcs.bucket.mockReturnValue({ file: gcs.file });
  gcs.file.mockImplementation(
    (_key: string, options: { generation: string }) => {
      const interceptors: File["interceptors"] = [];
      const checkGeneration = () => {
        let request: Parameters<File["interceptors"][number]["request"]>[0] = {
          uri: "",
          qs: { generation: Number(options.generation) },
        };
        for (const interceptor of interceptors)
          request = interceptor.request(request);
        expect(request.qs.generation).toBe(options.generation);
      };
      return {
        interceptors,
        getMetadata: () => {
          checkGeneration();
          return gcs.getMetadata();
        },
        createReadStream: (streamOptions: unknown) => {
          checkGeneration();
          return gcs.read(streamOptions);
        },
      };
    },
  );
});

function fixture(
  sourceKind: "remote" | "worker",
  memberKind: "report" | "conflict" = "report",
) {
  const text =
    '{"count": 9007199254740993123456789, "precise": 0.123456789012345678901, "text": "🌊"}';
  const member = reportTextIdentity(text);
  const executionId = randomUUID();
  const row = `${JSON.stringify({
    kind: memberKind,
    sourceKind,
    executionId,
    sequence: 2,
    contentSignature: member.sha256,
    reportSha256: member.sha256,
    reportByteSize: member.byteSize,
  }).slice(0, -1)},"report":${text}}`;
  const bytes = gzipSync(`${row}\n`);
  const crc = new CRC32C();
  crc.update(bytes);
  const identity: ProgressiveReportArchiveReadIdentity = {
    bucket: "fixture-bucket",
    objectKey: "reports/fixture.gz",
    generation: "90071992547409931",
    mimeType: "application/gzip",
    compression: "gzip",
    archiveFormat: "jsonl",
    storedSha256: createHash("sha256").update(bytes).digest("hex"),
    storedByteSize: bytes.length,
    crc32c: crc.toString(),
    sourceKind,
    memberKind,
    executionId,
    sequence: 2,
    signature: member.sha256,
    reportSha256: member.sha256,
    reportByteSize: member.byteSize,
    memberCount: 1,
    firstSequence: 2,
    lastSequence: 2,
  };
  const metadata = {
    generation: identity.generation,
    size: String(bytes.length),
    crc32c: identity.crc32c,
    contentType: identity.mimeType,
    contentEncoding: "gzip",
    metadata: { sha256: identity.storedSha256, byteSize: String(bytes.length) },
  };
  gcs.getMetadata.mockResolvedValue([metadata]);
  gcs.read.mockImplementation(() => Readable.from([bytes]));
  return { identity, text, metadata };
}

it.each([
  ["remote", "report"],
  ["worker", "report"],
  ["worker", "conflict"],
] as const)(
  "returns exact %s %s JSONB text after a pinned compressed read",
  async (source, kind) => {
    const { identity, text } = fixture(source, kind);
    expect(await readProgressiveReportArchive(identity)).toBe(text);
    expect(gcs.file).toHaveBeenCalledWith(identity.objectKey, {
      generation: identity.generation,
    });
    expect(gcs.read).toHaveBeenCalledWith({
      validation: "crc32c",
      decompress: false,
    });
  },
);

it("rejects stale metadata and unconfigured buckets before reading bytes", async () => {
  const { identity, metadata } = fixture("remote");
  for (const changed of [
    { ...metadata, generation: "42" },
    { ...metadata, crc32c: "AAAAAA==" },
    { ...metadata, size: String(identity.storedByteSize + 1) },
    { ...metadata, contentType: "application/json" },
    { ...metadata, metadata: { ...metadata.metadata, sha256: "0".repeat(64) } },
    { ...metadata, metadata: { ...metadata.metadata, byteSize: "1" } },
  ]) {
    gcs.getMetadata.mockResolvedValueOnce([changed]);
    await expect(readProgressiveReportArchive(identity)).rejects.toThrow(
      "metadata changed",
    );
  }
  expect(gcs.read).not.toHaveBeenCalled();
  await expect(
    readProgressiveReportArchive({ ...identity, bucket: "other-bucket" }),
  ).rejects.toThrow("bucket is not configured");
  expect(gcs.read).not.toHaveBeenCalled();
});

it("propagates a late GCS stream failure instead of returning parsed data", async () => {
  const { identity } = fixture("worker");
  gcs.read.mockImplementationOnce(() =>
    Readable.from(
      (async function* () {
        throw new Error("fixture GCS read failed");
      })(),
    ),
  );
  await expect(readProgressiveReportArchive(identity)).rejects.toThrow(
    "fixture GCS read failed",
  );
});


it("stops a pinned object stream at the report deadline and never opens media after a cancelled metadata lookup", async () => {
  const { identity } = fixture("remote");
  const controller = new AbortController();
  const stream = new PassThrough();
  let opened!: () => void;
  const started = new Promise<void>((resolve) => { opened = resolve; });
  gcs.read.mockImplementationOnce(() => { opened(); return stream; });
  const pending = readProgressiveReportArchive({ ...identity, signal: controller.signal });
  await started;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(stream.destroyed).toBe(true);

  const later = new AbortController();
  const { metadata } = fixture("remote");
  gcs.getMetadata.mockImplementationOnce(async () => { later.abort(); return [metadata]; });
  await expect(readProgressiveReportArchive({ ...identity, signal: later.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(gcs.read).toHaveBeenCalledTimes(1);
});
