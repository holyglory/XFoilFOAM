import { CRC32C, type File, type Storage } from "@google-cloud/storage";
import {
  canonicalReportJson,
  parseReportJson,
  readProgressiveReportArchiveText,
  reportTextIdentity,
  visitProgressiveReportArchive,
  type ProgressiveReportArchiveReadIdentity,
} from "@aerodb/db/progressive-report-archive";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import {
  ProgressiveReportArchiveStore,
  writeProgressiveReportBundle,
} from "../src/progressive-report-archive-store";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const executionId = randomUUID();
const first =
  '{"n": 9007199254740993123456789, "decimal": 0.123456789012345678901, "text": "🌊 report: \\"}\\", punctuation", "nested": {"report": [null, true]}}';
const second = first.replace("789,", "790,");

function metadata(
  text: string,
  sequence = 1,
  sourceKind: "remote" | "worker" = "remote",
  kind: "report" | "conflict" = "report",
) {
  const proof = reportTextIdentity(text);
  return {
    kind,
    sourceKind,
    executionId,
    sequence,
    contentSignature: proof.sha256,
    reportSha256: proof.sha256,
    reportByteSize: proof.byteSize,
  };
}

function inline(
  text: string,
  sequence = 1,
  sourceKind: "remote" | "worker" = "remote",
  kind: "report" | "conflict" = "report",
) {
  return `${JSON.stringify(metadata(text, sequence, sourceKind, kind)).slice(0, -1)},"report":${text}}`;
}

function delta(previous: string, next: string) {
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < next.length &&
    previous[prefix] === next[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  return { prefix, suffix, middle: next.slice(prefix, next.length - suffix) };
}

async function* lines(...items: string[]) {
  yield* items;
}

function storedIdentity(
  bytes: Buffer,
  text = first,
  extra: Partial<ProgressiveReportArchiveReadIdentity> = {},
): ProgressiveReportArchiveReadIdentity {
  const crc = new CRC32C();
  crc.update(bytes);
  const proof = reportTextIdentity(text);
  return {
    bucket: "fixture-bucket",
    objectKey: "reports/object.jsonl.gz",
    generation: "90071992547409931",
    mimeType: "application/gzip",
    compression: "gzip",
    archiveFormat: "jsonl",
    storedSha256: createHash("sha256").update(bytes).digest("hex"),
    storedByteSize: bytes.length,
    crc32c: crc.toString(),
    sourceKind: "remote",
    memberKind: "report",
    executionId,
    sequence: 1,
    signature: proof.sha256,
    reportSha256: proof.sha256,
    reportByteSize: proof.byteSize,
    ...extra,
  };
}

it("writes without a Storage client and restores exact text from both source kinds, including a same-sequence worker conflict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "report-roundtrip-"));
  temporaryDirectories.push(directory);
  for (const sourceKind of ["remote", "worker"] as const) {
    const path = join(directory, `${sourceKind}.gz`);
    const third = second.replace("790,", "791,");
    // Replace a UTF-16 surrogate's second code unit to prove offsets are JS slice
    // positions, not Unicode code points or UTF-8 byte offsets.
    const fourth = third.replace("🌊", "🌋");
    const rows = [
      inline(first, 1, sourceKind),
      JSON.stringify({
        ...metadata(second, 2, sourceKind),
        reportDelta: delta(first, second),
      }),
      JSON.stringify({
        ...metadata(third, 3, sourceKind),
        reportDelta: { prefix: 0, suffix: 0, middle: third },
      }),
      JSON.stringify({
        ...metadata(fourth, 4, sourceKind),
        reportDelta: delta(third, fourth),
      }),
    ];
    if (sourceKind === "worker")
      rows.push(
        inline('{"conflicting": 9007199254740993}', 4, sourceKind, "conflict"),
      );
    const written = await writeProgressiveReportBundle(path, lines(...rows));
    const bytes = await readFile(path);
    expect(written).toEqual({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
    });
    expect(gunzipSync(bytes).toString("utf8")).toBe(`${rows.join("\n")}\n`);
    for (const [sequence, text] of [first, second, third, fourth].map(
      (text, index) => [index + 1, text] as const,
    )) {
      const reference = storedIdentity(bytes, text, {
        sourceKind,
        sequence,
        memberCount: rows.length,
        firstSequence: 1,
        lastSequence: 4,
      });
      const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
      expect(
        await readProgressiveReportArchiveText(
          Readable.from(chunks),
          reference,
        ),
      ).toBe(text);
    }
    if (sourceKind === "worker") {
      const text = '{"conflicting": 9007199254740993}';
      expect(
        await readProgressiveReportArchiveText(
          Readable.from([bytes]),
          storedIdentity(bytes, text, {
            sourceKind,
            memberKind: "conflict",
            sequence: 4,
          }),
        ),
      ).toBe(text);
    }
  }
});

it("reads legacy inline rows with report before later metadata and without inline member hashes", async () => {
  const meta = metadata(first);
  const row = `{"kind":"report","report":${first},"sourceKind":"remote","executionId":"${executionId}","sequence":1,"contentSignature":"${meta.contentSignature}"}`;
  const bytes = gzipSync(`${row}\n`);
  expect(
    await readProgressiveReportArchiveText(
      Readable.from([bytes]),
      storedIdentity(bytes),
    ),
  ).toBe(first);
});

it("rejects duplicated members, broken JSONL, changed member proofs and inventory, including damage after the requested row", async () => {
  for (const text of [
    `${inline(first)}\n${inline(first)}\n`,
    inline(first), // Complete gzip, truncated JSONL framing.
    `${inline(first)}\n{"kind":`,
    `${inline(first)}\n${inline(second, 2).replace(/"reportSha256":"[a-f0-9]+"/, `"reportSha256":"${"0".repeat(64)}"`)}\n`,
    `${inline(first)}\n${inline(second, 2).replace('"reportByteSize":', '"reportByteSize":0,"reportByteSize":')}\n`,
    `${inline(first)}\n${inline(second, 2).replace('"report":', '"report":{},"report":')}\n`,
  ]) {
    const bytes = gzipSync(text);
    await expect(
      readProgressiveReportArchiveText(
        Readable.from([bytes]),
        storedIdentity(bytes),
      ),
    ).rejects.toThrow();
  }
  const bytes = gzipSync(`${inline(first)}\n`);
  for (const changed of [
    { storedSha256: "0".repeat(64) },
    { crc32c: "AAAAAA==" },
    { storedByteSize: bytes.length + 1 },
    { storedByteSize: bytes.length - 1 },
    { reportSha256: "0".repeat(64) },
    { reportByteSize: first.length },
    { memberCount: 2 },
    { firstSequence: 2 },
    { lastSequence: 2 },
    { sequence: 2 },
    { sourceKind: "worker" as const },
    { memberKind: "conflict" as const },
  ])
    await expect(
      readProgressiveReportArchiveText(
        Readable.from([bytes]),
        storedIdentity(bytes, first, changed),
      ),
    ).rejects.toThrow();
});

it("rejects missing delta bases, overlapping/out-of-bounds spans and ambiguous inline/delta entries", async () => {
  for (const reportDelta of [
    { prefix: -1, suffix: 0, middle: second },
    { prefix: first.length + 1, suffix: 0, middle: "" },
    { prefix: 1, suffix: first.length, middle: "" },
    { prefix: 0, suffix: first.length + 1, middle: "" },
    { prefix: 0.5, suffix: 0, middle: second },
    { prefix: 0, suffix: 0, middle: 3 },
    { prefix: 0, suffix: 0, middle: second, extra: true },
  ]) {
    const bytes = gzipSync(
      `${inline(first)}\n${JSON.stringify({ ...metadata(second, 2), reportDelta })}\n`,
    );
    await expect(
      readProgressiveReportArchiveText(
        Readable.from([bytes]),
        storedIdentity(bytes),
      ),
    ).rejects.toThrow();
  }
  for (const row of [
    JSON.stringify({
      ...metadata(second),
      reportDelta: { prefix: 0, suffix: 0, middle: second },
    }),
    `${JSON.stringify({ ...metadata(first), reportDelta: { prefix: 0, suffix: 0, middle: first } }).slice(0, -1)},"report":${first}}`,
    // This prefix would round to 1 in JSON.parse, but is not an integer.
    `${inline(first)}\n${JSON.stringify({ ...metadata(second, 2), reportDelta: { prefix: 1, suffix: 0, middle: "" } }).replace('"prefix":1', '"prefix":1.0000000000000000001')}`,
    `${inline(first)}\n${JSON.stringify({ ...metadata(second, 2), reportDelta: { prefix: 0, suffix: 0, middle: "{}" } })}`,
  ]) {
    const bytes = gzipSync(`${row}\n`);
    await expect(
      readProgressiveReportArchiveText(
        Readable.from([bytes]),
        storedIdentity(bytes),
      ),
    ).rejects.toThrow();
  }
});

it("propagates source, filesystem, gzip trailer and UTF-8 errors instead of returning an earlier match", async () => {
  const bytes = gzipSync(`${inline(first)}\n`);
  const failure = new Error("fixture source failed");
  const broken = Readable.from(
    (async function* () {
      yield bytes;
      throw failure;
    })(),
  );
  await expect(
    readProgressiveReportArchiveText(broken, storedIdentity(bytes)),
  ).rejects.toThrow("fixture source failed");
  const missingTrailer = bytes.subarray(0, -4);
  await expect(
    readProgressiveReportArchiveText(
      Readable.from([missingTrailer]),
      storedIdentity(missingTrailer),
    ),
  ).rejects.toThrow();
  const badTrailer = Buffer.from(bytes);
  badTrailer[badTrailer.length - 8] ^= 1;
  await expect(
    readProgressiveReportArchiveText(
      Readable.from([badTrailer]),
      storedIdentity(badTrailer),
    ),
  ).rejects.toThrow();
  const invalidUtf8 = gzipSync(
    Buffer.concat([Buffer.from(`${inline(first)}\n`), Buffer.from([0xff])]),
  );
  await expect(
    readProgressiveReportArchiveText(
      Readable.from([invalidUtf8]),
      storedIdentity(invalidUtf8),
    ),
  ).rejects.toThrow();
  const directory = await mkdtemp(join(tmpdir(), "report-errors-"));
  temporaryDirectories.push(directory);
  await expect(
    writeProgressiveReportBundle(
      join(directory, "source.gz"),
      (async function* () {
        yield inline(first);
        throw failure;
      })(),
    ),
  ).rejects.toThrow("fixture source failed");
  await expect(
    writeProgressiveReportBundle(
      join(directory, "absent", "output.gz"),
      lines(inline(first)),
    ),
  ).rejects.toThrow();
  const existing = join(directory, "existing.gz");
  await writeProgressiveReportBundle(existing, lines(inline(first)));
  const original = await readFile(existing);
  await expect(
    writeProgressiveReportBundle(existing, lines(inline(second))),
  ).rejects.toThrow();
  expect(await readFile(existing)).toEqual(original);
  await expect(
    writeProgressiveReportBundle(join(directory, "empty.gz"), lines()),
  ).rejects.toThrow();
  const {
    reportSha256: _hash,
    reportByteSize: _size,
    ...legacy
  } = metadata(first);
  await expect(
    writeProgressiveReportBundle(
      join(directory, "unproved.gz"),
      lines(`${JSON.stringify(legacy).slice(0, -1)},"report":${first}}`),
    ),
  ).rejects.toThrow();
});

it("pins readback to a string generation and hashes compressed bytes even when metadata claims gzip encoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "report-gcs-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "upload.gz");
  const local = await writeProgressiveReportBundle(path, lines(inline(first)));
  const bytes = await readFile(path);
  const reference = storedIdentity(bytes);
  const meta = {
    generation: reference.generation,
    crc32c: reference.crc32c,
    size: String(bytes.length),
    contentType: "application/gzip",
    contentEncoding: "gzip",
    metadata: {
      sha256: local.sha256,
      byteSize: String(local.byteSize),
      sourceKind: "remote",
      executionId,
      archiveFormat: "jsonl",
    },
  };
  const read = vi.fn(
    (_options?: { validation?: string; decompress?: boolean }) =>
      Readable.from([bytes]),
  );
  const file = vi.fn((_key: string, options?: { generation?: string }) => {
    const interceptors: File["interceptors"] = [];
    const checkGeneration = () => {
      // Emulate the installed SDK's constructor conversion, then apply the
      // public request interceptors used by both metadata and media requests.
      let request: Parameters<File["interceptors"][number]["request"]>[0] = {
        uri: "",
        qs: { generation: Number(options?.generation) },
      };
      for (const interceptor of interceptors)
        request = interceptor.request(request);
      expect(request.qs.generation).toBe(reference.generation);
    };
    return {
      interceptors,
      getMetadata: async () => {
        if (options?.generation) checkGeneration();
        return [meta];
      },
      createReadStream: (streamOptions: {
        validation?: string;
        decompress?: boolean;
      }) => {
        if (!options?.generation) throw new Error("Unpinned read");
        checkGeneration();
        return read(streamOptions);
      },
    };
  });
  const upload = vi.fn(async () => []);
  const storage = { bucket: () => ({ file, upload }) } as unknown as Storage;
  const store = new ProgressiveReportArchiveStore(
    reference.bucket,
    "fixture-prefix",
    storage,
  );
  const archived = await store.putFile(path, local, "remote", executionId);
  expect(file).toHaveBeenCalledWith(archived.objectKey, {
    generation: reference.generation,
  });
  expect(read).toHaveBeenCalledWith({
    validation: "crc32c",
    decompress: false,
  });
  expect(
    await store.read({ ...reference, objectKey: archived.objectKey }),
  ).toBe(first);
  expect(await store.readBundle(archived)).toBe(`${inline(first)}\n`);
  upload.mockRejectedValueOnce(
    Object.assign(new Error("already exists"), { code: 412 }),
  );
  await expect(
    store.putFile(path, local, "remote", executionId),
  ).resolves.toMatchObject({ generation: reference.generation });
  read.mockImplementationOnce(() =>
    Readable.from([Buffer.from(bytes).fill(0, 0, 1)]),
  );
  await expect(
    store.putFile(path, local, "remote", executionId),
  ).rejects.toThrow();
});

it("visits exact reconstructed entries in order and enforces every broker limit", async () => {
  const row = JSON.stringify({
    ...metadata(second, 2),
    reportDelta: delta(first, second),
  });
  const jsonl = `${inline(first)}\n${row}\n`;
  const bytes = gzipSync(jsonl);
  const seen: string[] = [];
  await visitProgressiveReportArchive(
    Readable.from([bytes]),
    storedIdentity(bytes),
    async (entry) => {
      await Promise.resolve();
      seen.push(entry.reportText);
    },
    {
      maxMembers: 2,
      maxDecodedBytes: Buffer.byteLength(jsonl),
      maxReportBytes: Buffer.byteLength(first),
    },
  );
  expect(seen).toEqual([first, second]);
  for (const limits of [
    { maxMembers: 1 },
    { maxDecodedBytes: Buffer.byteLength(jsonl) - 1 },
    { maxReportBytes: Buffer.byteLength(first) - 1 },
    { maxMembers: 0 },
  ])
    await expect(
      visitProgressiveReportArchive(
        Readable.from([bytes]),
        storedIdentity(bytes),
        () => {},
        limits,
      ),
    ).rejects.toThrow();
  await expect(
    visitProgressiveReportArchive(
      Readable.from([bytes]),
      storedIdentity(bytes),
      async () => {
        throw new Error("fixture visitor failed");
      },
    ),
  ).rejects.toThrow("fixture visitor failed");
});

it("canonicalizes ordinary PostgreSQL number spellings without rounding precise or enormous tokens", () => {
  expect(
    canonicalReportJson(
      parseReportJson(
        '{"z": 0.0000001, "a": 1000000000000000000000, "b": -0.00}',
      ),
    ),
  ).toBe('{"a":1e+21,"b":0,"z":1e-7}');
  expect(
    canonicalReportJson(
      parseReportJson(
        '{"n":9007199254740993123456789,"d":0.123456789012345678901,"huge":1e400}',
      ),
    ),
  ).toBe(
    '{"d":0.123456789012345678901,"huge":1e400,"n":9007199254740993123456789}',
  );
});
