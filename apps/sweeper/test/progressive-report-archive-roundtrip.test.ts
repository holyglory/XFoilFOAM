import { CRC32C, type File, type Storage } from "@google-cloud/storage";
import {
  canonicalReportJson,
  parseReportJson,
  readProgressiveReportArchiveText,
  reportTextIdentity,
  validatedProgressiveReportArchiveLines,
  verifyProgressiveReportArchive,
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

it("restores exact PG results across shared pages including unknown, wide and null values", async () => {
  const { memoryReportObjects } = await import("./shared-report-object-fixture");
  const { readSharedReport, writeSharedReportPage, SHARED_REPORT_FORMAT } = await import("../src/shared-report-archive");
  const { splitProgressiveReportText, reportJsonObject } = await import("@aerodb/db/progressive-report-archive");
  const { retainedReportInventory } = await import("@aerodb/db/retained-solver-reports");
  const { files, store } = memoryReportObjects();
  const owner = { executionId:randomUUID(), promiseId:randomUUID(), solverId:randomUUID(), assignmentSignature:"4".repeat(64) };
  const rawResult = '{"job_id":'+JSON.stringify(owner.executionId)+',"polars":[], "unknown":9007199254740993123456789, "decimal":1.2300, "nested":{"result":"終😀"}}';
  const full = (seq:number, r:string) => '{"unknown":{"result":{"earlier":true}}, "sequence":'+seq+', "result":'+r+
    ', "status":{"extra":"\\\"result\\\":null β"}, "stopProof":null, "promiseId":"'+owner.promiseId+'", "solverId":"'+owner.solverId+
    '", "executionId":"'+owner.executionId+'", "assignmentSignature":"'+owner.assignmentSignature+'"}';
  const source = (text:string,seq:number) => {
    const cut=splitProgressiveReportText(text),sig=reportTextIdentity(canonicalReportJson(cut.report)).sha256;
    const inv=retainedReportInventory(cut.report,sig),p=reportTextIdentity(text);
    return {sequence:seq,signature:sig,reportSha256:p.sha256,reportByteSize:p.byteSize,prefix:cut.prefix,suffix:cut.suffix,
      resultHash:cut.result?reportTextIdentity(cut.result).sha256:null,
      resultSize:cut.result?Buffer.byteLength(cut.result):undefined,loadResult:async()=>cut.result!,
      sourceCount:inv.sourceCount,inventorySignature:inv.signature,sourceListSha256:reportTextIdentity(canonicalReportJson(inv.sources)).sha256};
  };
  const raws=[full(1,rawResult),full(2,rawResult),full(3,rawResult.replace("1.2300","1.23")),full(4,"null")];
  const members=raws.map((s,i)=>source(s,i+1));
  const copies=[];
  for(const m of members) copies.push(await writeSharedReportPage(store,owner,[m]));
  expect([...files.keys()].filter(k=>k.includes("/results/"))).toHaveLength(2);
  expect(copies[1].resultBytesSubmitted).toBe(0);
  expect(copies[0].manifest.results).toEqual(copies[1].manifest.results);
  for(const [i,copy] of copies.entries()){
    const m=members[i],p=copy.pin;
    const ref={bucket:store.bucket,objectKey:p.key,generation:p.generation,crc32c:p.crc32c,storedSha256:p.sha256,storedByteSize:p.size,
      mimeType:"application/gzip",compression:"gzip",archiveFormat:SHARED_REPORT_FORMAT,sourceKind:"remote" as const,memberKind:"report" as const,
      executionId:owner.executionId,sequence:m.sequence,signature:m.signature,reportSha256:m.reportSha256,reportByteSize:m.reportByteSize};
    expect(await readSharedReport(store,ref)).toBe(raws[i]);
    const {verifySharedReportGeneration}=await import("../src/shared-report-archive");
    await expect(verifySharedReportGeneration(store,ref,AbortSignal.timeout(1000))).resolves.toBeUndefined();
    if(m.resultHash){
      const changed={...store,read:async(pin:Parameters<typeof store.read>[0],limit:number)=>pin.key.includes("/results/")?gzipSync("altered receipt"):store.read(pin,limit)};
      await expect(verifySharedReportGeneration(changed,ref,AbortSignal.timeout(1000))).rejects.toThrow();
    }

    if (i === 0) {
      const stalled = { ...store, read: () => new Promise<Buffer>(() => {}) };
      await expect(readSharedReport(stalled, ref, AbortSignal.timeout(10))).rejects.toThrow();
      await expect(verifySharedReportGeneration(stalled, ref, AbortSignal.timeout(10))).rejects.toThrow();
      const { withSharedReportPageReads } = await import("../src/shared-report-archive");
      await withSharedReportPageReads(async () => {
        await readSharedReport(store, ref);
        const unavailable = { ...store, read: async (pin: typeof copy.pin, limit: number) => {
          if (pin.key === copy.pin.key) throw new Error("missing prior manifest");
          return store.read(pin, limit);
        } };
        await expect(verifySharedReportGeneration(unavailable, ref)).rejects.toThrow("missing prior manifest");
      });
    }

    await expect(readSharedReport(store,{...ref,executionId:randomUUID()})).rejects.toThrow();
  }
  const replay=await writeSharedReportPage(store,owner,[members[0]]);
  expect(replay.pin).toEqual(copies[0].pin);
  const hash=members[0].resultHash!;
  const result=copies[0].manifest.results[hash].pin;
  const bytes=files.get(result.key)!;
  files.set(result.key,{...bytes,bytes:Buffer.from("corrupt shared result")});
  await expect(writeSharedReportPage(store,owner,[members[1]])).rejects.toThrow();
  expect(reportJsonObject(parseReportJson(raws[0])).unknown).toBeDefined();
});

const temporaryDirectories: string[] = [];

it("checks each cancelled report's signature and point inventory even when the PG result repeats", async () => {
  const { cancelledReportSourceVerifier } = await import("../src/report-archive-source-proof");
  const { stoppedReportPageText } = await import("../src/shared-stopped-report-custody");
  const { retainedReportInventory } = await import("@aerodb/db/retained-solver-reports");
  const { reportJsonObject } = await import("@aerodb/db/progressive-report-archive");
  const job = randomUUID();
  const science = `{"job_id":"${job}","polars":[{"speed":20,"reynolds":100000,"mach":0,"points":[],"attempts":[{"case_slug":"failed","aoa_deg":5,"converged":false,"wide":90071992547409931235}]}]}`;
  const make = (sequence: number, result: string, extra = "") =>
    `{"nested":{"result":"unrelated"},"result":${result},"sequence":${sequence},"executionId":"${job}"${extra}}`;
  const documents = [make(1, science), make(2, science, ',"status":{"unknown":"result"}'),
    make(3, science.replace("31235", "31236")), make(4, "null")];
  const expected = documents.map(raw => {
    const report = reportJsonObject(parseReportJson(raw));
    const signature = reportTextIdentity(canonicalReportJson(report)).sha256;
    const inv = retainedReportInventory(report, signature);
    return { signature, inventory: inv.signature, sources: canonicalReportJson(inv.sources) };
  });
  const verify = cancelledReportSourceVerifier(job);
  const split = stoppedReportPageText();
  for (const [i, raw] of documents.entries()) {
    const e = expected[i];
    expect(verify(raw, i+1, e.signature, e.inventory)).toBe(e.sources);
    const member = split(raw, null, 0);
    expect(member.prefix + (member.result ?? "") + member.suffix).toBe(raw);
    if (member.result) expect(member.hash).toBe(reportTextIdentity(member.result).sha256);
  }
  const scienceHash = reportTextIdentity(science).sha256;
  const protectedMember = split(make(5, "{}"), scienceHash, Buffer.byteLength(science));
  expect(protectedMember.result).toBeNull();
  expect(protectedMember.prefix + science + protectedMember.suffix).toBe(make(5, science));
  expect(() => split(make(6, "null"), scienceHash, Buffer.byteLength(science))).toThrow("Protected SQL result");
  expect(expected[0].sources).toBe(expected[1].sources);
  expect(expected[2].sources).not.toBe(expected[1].sources);
  expect(expected[3].sources).toBe("[]");
  for (const [raw, signature, inventory] of [
    [documents[1], expected[0].signature, expected[1].inventory],
    [documents[1], expected[1].signature, expected[0].inventory],
    [documents[1].replace('"unknown":"result"', '"unknown":"changed"'), expected[1].signature, expected[1].inventory],
    [make(2, science.replace("31235", "31236")), expected[1].signature, expected[1].inventory],
    [make(2, science, ',"result":null'), expected[1].signature, expected[1].inventory],
  ]) {
    verify(documents[0], 1, expected[0].signature, expected[0].inventory);
    expect(() => verify(raw, 2, signature, inventory)).toThrow();
  }
});
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

it("scans decompressed chunks once for a large exact member and rejects a damaged tail", async () => {
  const text = JSON.stringify({ manifest: "λ🌊".repeat(180_000), history: [1, 2, 3] });
  const row = inline(text);
  const good = gzipSync(row + "\r\n" + inline(second, 2) + "\n");
  const ref = storedIdentity(good, text, { sequence: 1, memberCount: 2, firstSequence: 1, lastSequence: 2 });
  const indexOf = String.prototype.indexOf;
  let missedScanUnits = 0;
  const scanned = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, search, at) {
    const found = indexOf.call(this, search, at);
    if (search === "\n" && found < 0) missedScanUnits += this.length - (at ?? 0);
    return found;
  });
  try {
    const restored = await readProgressiveReportArchiveText(Readable.from([good]), ref);
    expect(restored).toBe(text);
  } finally { scanned.mockRestore(); }
  expect(missedScanUnits).toBeLessThan(2 * row.length);
  const truncated = gzipSync(row + "\n" + inline(second, 2));
  await expect(readProgressiveReportArchiveText(Readable.from([truncated]),
    storedIdentity(truncated, text, { sequence: 1, memberCount: 2, firstSequence: 1, lastSequence: 2 })))
    .rejects.toThrow(/Truncated/);
});

it.each(["prefix", "suffix"] as const)("reuses only the complete validated result in a %s delta while preserving exact text", async (retained) => {
  const token = '"unique result token 🌊"';
  const source = `{"marker": ${token}, "n": 90071992547409931235, "nested": [{"result": 0.0000000100}]}`;
  const report = (seq: number, result = source) => retained === "prefix"
    ? `{"result": ${result}, "sequence": ${seq}}` : `{"sequence": ${seq}, "result": ${result}}`;
  const rows = [report(1), report(200), report(3000), report(40000, source.replace("31235", "31236"))];
  const lines = (values: string[]) => values.map((v,n) => n
    ? JSON.stringify({ ...metadata(v,n+1), reportDelta: delta(values[n-1]!,v) }) : inline(v));
  const encode = (values: string[]) => gzipSync(lines(values).join("\n")+"\n");
  const validateForWrite = async (values: string[]) => {
    const output: Buffer[] = [];
    async function* input() { yield* lines(values); }
    for await (const chunk of validatedProgressiveReportArchiveLines(input())) output.push(chunk);
    return Buffer.concat(output);
  };
  const bytes = encode(rows);
  const parse = JSON.parse;
  let parsedMarkers=0;
  const observed=vi.spyOn(JSON,"parse").mockImplementation((text,reviver) => {
    if (text===token) parsedMarkers++;
    return parse(text,reviver);
  });
  try {
    expect(await readProgressiveReportArchiveText(Readable.from([bytes]),storedIdentity(bytes,rows[3]!,{sequence:4,memberCount:4,firstSequence:1,lastSequence:4}))).toBe(rows[3]);
    expect(parsedMarkers).toBe(2);
    parsedMarkers=0;
    expect(await validateForWrite(rows)).toEqual(gunzipSync(bytes));
    expect(parsedMarkers).toBe(2);
    parsedMarkers=0;
    await verifyProgressiveReportArchive(Readable.from([bytes]),storedIdentity(bytes));
    expect(parsedMarkers).toBe(2);
  } finally { observed.mockRestore(); }
  const malformedInside=report(5,source.replace('"marker":', '"marker": null, "marker":'));
  const malformedOutside=report(5).replace('"sequence":', '"sequence": 4, "sequence":');
  for (const tail of [malformedInside,malformedOutside]) {
    const corrupt=encode([...rows,tail]);
    await expect(readProgressiveReportArchiveText(Readable.from([corrupt]),storedIdentity(corrupt,rows[0]!,{sequence:1,memberCount:5,firstSequence:1,lastSequence:5}))).rejects.toThrow(/Invalid report JSON/);
    await expect(validateForWrite([...rows,tail])).rejects.toThrow(/Invalid report JSON/);
    await expect(verifyProgressiveReportArchive(Readable.from([corrupt]),storedIdentity(corrupt))).rejects.toThrow(/Invalid report JSON/);
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
