import { CRC32C } from "@google-cloud/storage";
import {
  analysisContentHash,
  sealProgressiveRemoteExecution,
  type DB,
} from "@aerodb/db";
import {
  canonicalReportJson,
  parseReportJson,
  reportTextIdentity,
} from "@aerodb/db/progressive-report-archive";
import { OPENCFD_2606_ENGINE } from "@aerodb/engine-client";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import {
  putWorkerReportBundle,
  readWorkerArchivedReport,
  readWorkerReportArchive,
  readWorkerReportArchiveText,
  type ProgressiveReportArchiveIdentity,
} from "../src/report-archive-broker-client";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function checksum(bytes: Buffer) {
  const crc = new CRC32C();
  crc.update(bytes);
  return crc.toString();
}

async function fixture() {
  const executionId = randomUUID();
  const token = randomUUID();
  const envelope = sealProgressiveRemoteExecution({
    solverId: randomUUID(),
    promiseId: randomUUID(),
    scope: {
      executionContract: "progressive-cfd-v1",
      executionId,
      epochId: randomUUID(),
      generationId: randomUUID(),
      targetId: "a".repeat(64),
      recipeId: "b".repeat(64),
      stage: 2,
      tokens: [token],
      units: [
        { unitId: randomUUID(), token, alpha: 0, activeBudgetSeconds: 900 },
      ],
    },
    request: {
      execution_id: executionId,
      expected_engine: { ...OPENCFD_2606_ENGINE },
      expected_execution_pool: "isolated-report-broker",
      expected_solver_budget_version: 2,
      expected_mesh_recovery_version: 1,
      airfoil: { name: "isolated-report-broker" },
      chord_lengths: [1],
      speeds: [30],
      aoa: { angles: [0] },
      solver: { warm_start: true, flow_solver_family: "rhoSimpleFoam" },
      resources: { case_concurrency: 1, case_solver_budget_seconds: 900 },
    },
  });
  const baseUrl = "https://trusted-hub.example/api/sync/v1";
  const authToken = "isolated-registered-worker-secret";
  const row = {
    solver_id: envelope.solverId,
    promise_id: envelope.promiseId,
    auth_token: authToken,
    upstream_base_url: baseUrl,
    source_base_url: baseUrl,
    request_payload: {
      remoteSolver: true,
      syncPromiseId: envelope.promiseId,
      upstreamBaseUrl: baseUrl,
      remoteProgressiveExecution: envelope,
      engineRequest: envelope.request,
    },
  };
  const dialect = new PgDialect();
  const execute = vi.fn(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    expect(query.sql.trim().startsWith("SELECT")).toBe(true);
    expect(query.sql).toContain(
      "promise.registered_solver_id = settings.remote_solver_registered_id",
    );
    expect(query.sql).not.toMatch(
      /lease|expires|paused|enabled|UPDATE|INSERT/i,
    );
    return query.params[0] === executionId ? [row] : [];
  });
  const db = { execute } as unknown as DB;
  const reports = [10, 11].map((sequence) => ({
    version: 1,
    executionId,
    solverId: envelope.solverId,
    promiseId: envelope.promiseId,
    assignmentSignature: envelope.contentSignature,
    sequence,
    status: { job_id: executionId, state: "failed" },
    result: null,
    stopProof: null,
  }));
  const texts = reports.map((report) =>
    JSON.stringify(report, null, 1).replace(/\n\s*/g, ""),
  );
  const lines = reports.map((report, index) => {
    const proof = reportTextIdentity(texts[index]!);
    const metadata = {
      sourceKind: "worker",
      kind: "report",
      executionId,
      sequence: report.sequence,
      contentSignature: analysisContentHash(report),
      reportSha256: proof.sha256,
      reportByteSize: proof.byteSize,
    };
    return index
      ? JSON.stringify({
          ...metadata,
          reportDelta: { prefix: 0, suffix: 0, middle: texts[index] },
        })
      : `${JSON.stringify(metadata).slice(0, -1)},"report":${texts[index]}}`;
  });
  const bytes = gzipSync(`${lines.join("\n")}\n`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const archive: ProgressiveReportArchiveIdentity = {
    bucket: "report-bucket",
    objectKey: `progressive-reports/v1/worker/${executionId}/${sha256}.jsonl.gz`,
    generation: "18446744073709551615",
    mimeType: "application/gzip",
    compression: "gzip",
    archiveFormat: "jsonl",
    storedSha256: sha256,
    storedByteSize: bytes.length,
    crc32c: checksum(bytes),
    verifiedAt: new Date("2026-11-19T10:00:00Z"),
  };
  const proof = reportTextIdentity(texts[1]!);
  const member = {
    sourceKind: "worker" as const,
    memberKind: "report" as const,
    executionId,
    sequence: 11,
    contentSignature: analysisContentHash(reports[1]),
    reportSha256: proof.sha256,
    reportByteSize: proof.byteSize,
  };
  const identity = {
    ...archive,
    ...member,
    signature: member.contentSignature,
  };
  const headers = {
    "content-type": archive.mimeType,
    "content-length": String(bytes.length),
    "x-content-sha256": sha256,
    "x-content-crc32c": archive.crc32c,
    "x-gcs-generation": archive.generation,
    "x-report-archive-bucket": archive.bucket,
    "x-report-archive-object-key": archive.objectKey,
  };
  const directory = await mkdtemp(join(tmpdir(), "report-broker-client-test-"));
  directories.push(directory);
  const path = join(directory, "page.jsonl.gz");
  await writeFile(path, bytes);
  return {
    db,
    execute,
    row,
    baseUrl,
    authToken,
    executionId,
    reports,
    texts,
    bytes,
    sha256,
    archive,
    member,
    identity,
    headers,
    path,
  };
}

it("streams the exact page only to the authenticated trusted hub and validates its receipt", async () => {
  const f = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(
        `${f.baseUrl}/progressive-executions/${f.executionId}/report-archives/${f.sha256}?byteSize=${f.bytes.length}`,
      );
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      expect(headers.get("x-xfoilfoam-solver-token")).toBe(f.authToken);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("content-length")).toBe(String(f.bytes.length));
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as unknown as AsyncIterable<Buffer>)
        chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(f.bytes);
      return new Response(JSON.stringify(f.archive));
    }),
  );
  await expect(
    putWorkerReportBundle(
      f.db,
      f.path,
      { sha256: f.sha256, byteSize: f.bytes.length },
      f.executionId,
    ),
  ).resolves.toEqual(f.archive);
});

it("rejects wrong local hashes and foreign or unsafe upstream scope before sending bytes", async () => {
  const f = await fixture();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    putWorkerReportBundle(
      f.db,
      f.path,
      { sha256: "0".repeat(64), byteSize: f.bytes.length },
      f.executionId,
    ),
  ).rejects.toThrow(/SHA-256/);
  await expect(
    putWorkerReportBundle(
      f.db,
      f.path,
      { sha256: f.sha256, byteSize: f.bytes.length + 1 },
      f.executionId,
    ),
  ).rejects.toThrow(/size/);
  await expect(
    putWorkerReportBundle(
      f.db,
      f.path,
      { sha256: f.sha256, byteSize: f.bytes.length },
      randomUUID(),
    ),
  ).rejects.toThrow(/does not own/);
  f.row.source_base_url = "https://foreign.example/api/sync/v1";
  await expect(
    putWorkerReportBundle(
      f.db,
      f.path,
      { sha256: f.sha256, byteSize: f.bytes.length },
      f.executionId,
    ),
  ).rejects.toThrow(/upstream/);
  f.row.upstream_base_url =
    "https://trusted-hub.example/api/sync/v1/../unexpected";
  await expect(
    putWorkerReportBundle(
      f.db,
      f.path,
      { sha256: f.sha256, byteSize: f.bytes.length },
      f.executionId,
    ),
  ).rejects.toThrow(/exact|canonical/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects changed receipts and bounds an oversized receipt response", async () => {
  const f = await fixture();
  for (const changed of [
    { storedSha256: "0".repeat(64) },
    { generation: "18446744073709551616" },
    { crc32c: "AAAAAA==" },
    { objectKey: `../worker/${f.executionId}/${f.sha256}.jsonl.gz` },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        for await (const _chunk of init.body as unknown as AsyncIterable<Buffer>) {
          /* consume request */
        }
        return new Response(JSON.stringify({ ...f.archive, ...changed }));
      }),
    );
    await expect(
      putWorkerReportBundle(
        f.db,
        f.path,
        { sha256: f.sha256, byteSize: f.bytes.length },
        f.executionId,
      ),
    ).rejects.toThrow();
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      for await (const _chunk of init.body as unknown as AsyncIterable<Buffer>) {
        /* consume request */
      }
      return new Response("x".repeat(16 * 1024 + 1));
    }),
  );
  await expect(
    putWorkerReportBundle(
      f.db,
      f.path,
      { sha256: f.sha256, byteSize: f.bytes.length },
      f.executionId,
    ),
  ).rejects.toThrow(/receipt exceeds/);
});

it("restores exact PostgreSQL text and delta members after closure through both reader interfaces", async () => {
  const f = await fixture();
  expect(f.member.reportSha256).not.toBe(f.member.contentSignature);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("generation")).toBe(f.archive.generation);
      expect(parsed.searchParams.get("crc32c")).toBe(f.archive.crc32c);
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("x-xfoilfoam-solver-token")).toBe(
        f.authToken,
      );
      return new Response(f.bytes, { headers: f.headers });
    }),
  );
  await expect(readWorkerReportArchiveText(f.db, f.identity)).resolves.toBe(
    f.texts[1],
  );
  await expect(readWorkerReportArchive(f.db, f.identity)).resolves.toEqual(
    f.reports[1],
  );
  await expect(
    readWorkerArchivedReport(f.db, f.archive, f.member),
  ).resolves.toEqual(f.reports[1]);
});

it("rejects changed restore headers and mismatched exact member identities", async () => {
  const f = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(f.bytes, {
          headers: { ...f.headers, "x-gcs-generation": "2" },
        }),
    ),
  );
  await expect(readWorkerReportArchive(f.db, f.identity)).rejects.toThrow(
    /exact identity/,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(f.bytes, { headers: f.headers })),
  );
  await expect(
    readWorkerReportArchive(f.db, {
      ...f.identity,
      reportSha256: f.member.contentSignature,
    }),
  ).rejects.toThrow(/SHA-256|size/);
  await expect(
    readWorkerReportArchive(f.db, { ...f.identity, sequence: 999 }),
  ).rejects.toThrow(/not found/);
  const fetcher = vi.mocked(fetch);
  const before = fetcher.mock.calls.length;
  await expect(
    readWorkerReportArchive(f.db, { ...f.identity, sourceKind: "remote" }),
  ).rejects.toThrow(/member/);
  expect(fetcher.mock.calls).toHaveLength(before);
});

it("fails on excess bytes, truncated gzip, or a late stream error even after finding a matching report", async () => {
  const f = await fixture();
  const firstProof = reportTextIdentity(f.texts[0]!);
  const first = {
    ...f.identity,
    sequence: 10,
    signature: analysisContentHash(f.reports[0]),
    reportSha256: firstProof.sha256,
    reportByteSize: firstProof.byteSize,
  };
  for (const bytes of [
    Buffer.concat([f.bytes, Buffer.from("extra")]),
    f.bytes.subarray(0, f.bytes.length - 2),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes, { headers: f.headers })),
    );
    await expect(readWorkerReportArchive(f.db, first)).rejects.toThrow();
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          Readable.toWeb(
            Readable.from(
              (async function* () {
                yield f.bytes;
                throw new Error("late download stream error");
              })(),
            ),
          ) as ConstructorParameters<typeof Response>[0],
          { headers: f.headers },
        ),
    ),
  );
  await expect(readWorkerReportArchive(f.db, first)).rejects.toThrow(
    /late download stream error/,
  );
});

it("honors caller cancellation before returning an archived body", async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(f.bytes, { headers: f.headers })),
  );
  await expect(
    readWorkerReportArchive(f.db, { ...f.identity, signal: abort.signal }),
  ).rejects.toThrow(/abort/i);
});

it("preserves exact PG numeric tokens for text hashes and canonical signatures", async () => {
  const f = await fixture();
  // A JSON.parse/stringify round trip would round this stored numeric token.
  const text = f.texts[0]!.replace(/}$/, ',"measurement":9007199254740993}');
  const proof = reportTextIdentity(text);
  const signature = createHash("sha256")
    .update(canonicalReportJson(parseReportJson(text)))
    .digest("hex");
  const metadata = {
    sourceKind: "worker",
    kind: "report",
    executionId: f.executionId,
    sequence: 10,
    contentSignature: signature,
    reportSha256: proof.sha256,
    reportByteSize: proof.byteSize,
  };
  const bytes = gzipSync(
    `${JSON.stringify(metadata).slice(0, -1)},"report":${text}}\n`,
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = {
    ...f.identity,
    sequence: 10,
    signature,
    reportSha256: proof.sha256,
    reportByteSize: proof.byteSize,
    storedSha256: sha256,
    storedByteSize: bytes.length,
    crc32c: checksum(bytes),
    objectKey: f.archive.objectKey.replace(f.sha256, sha256),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(bytes, {
          headers: {
            ...f.headers,
            "content-length": String(bytes.length),
            "x-content-sha256": sha256,
            "x-content-crc32c": identity.crc32c,
            "x-report-archive-object-key": identity.objectKey,
          },
        }),
    ),
  );
  await expect(readWorkerReportArchiveText(f.db, identity)).resolves.toBe(text);
});

it.each(["prefix", "suffix"] as const)(
  "signs the actual envelope bytes when a %s delta copies the full result",
  async (position) => {
    const f = await fixture();
    const signature = (text: string) =>
      createHash("sha256")
        .update(canonicalReportJson(parseReportJson(text)))
        .digest("hex");
    const render = (sequence: number, token: string) => {
      const { result: _result, ...header } = { ...f.reports[0]!, sequence };
      const fields = JSON.stringify(header).slice(1, -1);
      const result = `"result": {"history": [${token}, -0.0000000000010], "note": "🌊"}`;
      return position === "prefix"
        ? `{${result}, ${fields}}`
        : `{${fields}, ${result}}`;
    };
    const old = "9007199254740993",
      next = "9007199254740995";
    const texts = [render(10, old), render(11, old), render(12, next)];
    async function readLastOrFirst(forgeLast: boolean) {
      const lines = texts.map((text, i) => {
        const proof = reportTextIdentity(text);
        const member = {
          sourceKind: "worker",
          kind: "report",
          executionId: f.executionId,
          sequence: 10 + i,
          contentSignature: signature(
            forgeLast && i === 2 ? render(12, old) : text,
          ),
          reportSha256: proof.sha256,
          reportByteSize: proof.byteSize,
        };
        if (!i)
          return `${JSON.stringify(member).slice(0, -1)},"report":${text}}`;
        const prior = texts[i - 1]!;
        let prefix = 0,
          suffix = 0;
        while (
          prefix < Math.min(prior.length, text.length) &&
          prior[prefix] === text[prefix]
        )
          prefix++;
        while (
          suffix < Math.min(prior.length, text.length) - prefix &&
          prior[prior.length - 1 - suffix] === text[text.length - 1 - suffix]
        )
          suffix++;
        return JSON.stringify({
          ...member,
          reportDelta: {
            prefix,
            suffix,
            middle: text.slice(prefix, text.length - suffix),
          },
        });
      });
      const bytes = gzipSync(lines.join("\n") + "\n");
      const storedSha256 = createHash("sha256").update(bytes).digest("hex");
      const i = forgeLast ? 0 : 2;
      const original = reportTextIdentity(texts[i]!);
      const identity = {
        ...f.identity,
        storedSha256,
        storedByteSize: bytes.length,
        crc32c: checksum(bytes),
        objectKey: f.archive.objectKey.replace(f.sha256, storedSha256),
        sequence: 10 + i,
        signature: signature(texts[i]!),
        reportSha256: original.sha256,
        reportByteSize: original.byteSize,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(bytes, {
              headers: {
                ...f.headers,
                "content-length": String(bytes.length),
                "x-content-sha256": storedSha256,
                "x-content-crc32c": identity.crc32c,
                "x-report-archive-object-key": identity.objectKey,
              },
            }),
        ),
      );
      return readWorkerReportArchiveText(f.db, identity);
    }
    await expect(readLastOrFirst(false)).resolves.toBe(texts[2]);
    await expect(readLastOrFirst(true)).rejects.toThrow(/content verification/);
  },
);
