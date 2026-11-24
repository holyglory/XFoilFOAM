import { sealProgressiveRemoteExecution, type DB } from "@aerodb/db";
import {
  canonicalReportJson,
  parseReportJson,
  reportTextIdentity,
} from "@aerodb/db/progressive-report-archive";
import { OPENCFD_2606_ENGINE } from "@aerodb/engine-client";
import { Storage } from "@google-cloud/storage";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import {
  readStoredWorkerArchiveText,
  readWorkerReportArchiveText,
  WorkerReportFetchDisabled,
} from "../src/report-archive-broker-client";
import type { ProgressiveReportArchiveIdentity } from "../src/progressive-report-archive-store";
import {
  readWorkerReportVolume,
  releaseVerifiedWorkerVolume,
  retainWorkerReportVolume,
  storeWorkerReportVolume,
} from "../src/worker-report-volume";
import * as workerVolume from "../src/worker-report-volume";
import {
  releaseUpstreamReadableVolume,
  runWorkerVolumeCleanup,
} from "../src/worker-report-volume-cleanup";

const directories: string[] = [];
const cli = fileURLToPath(
  new URL("../src/worker-report-volume-cli.ts", import.meta.url),
);
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("unlinks only an exact local copy after the upstream proof succeeds", async () => {
  const f = await fixture();
  await retainWorkerReportVolume(f.sourcePath, f.archive);
  const proof = vi.fn(async () => {
    expect(await readFile(f.target)).toEqual(f.bytes);
    return true;
  });
  expect(await releaseVerifiedWorkerVolume(f.archive, proof, f.root)).toBe(
    true,
  );
  expect(proof).toHaveBeenCalledTimes(1);
  await expect(readFile(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.sourcePath)).toEqual(f.bytes);
});

it.each(["denied", "failed"])(
  "keeps the local file after a %s upstream proof",
  async (mode) => {
    const f = await fixture();
    await retainWorkerReportVolume(f.sourcePath, f.archive);
    const before = await stat(f.target, { bigint: true });
    const proof = vi.fn(async () => {
      if (mode === "failed") throw new WorkerReportFetchDisabled();
      return false;
    });
    if (mode === "failed")
      await expect(
        releaseVerifiedWorkerVolume(f.archive, proof, f.root),
      ).rejects.toBeInstanceOf(WorkerReportFetchDisabled);
    else
      expect(await releaseVerifiedWorkerVolume(f.archive, proof, f.root)).toBe(
        false,
      );
    expect(proof).toHaveBeenCalledTimes(1);
    expect(await stat(f.target, { bigint: true })).toEqual(before);
    expect(await readFile(f.target)).toEqual(f.bytes);
  },
);

it.each(["truncated", "wrong-hash"])(
  "refuses removal of a %s local file despite an upstream grant",
  async (mode) => {
    const f = await fixture();
    await retainWorkerReportVolume(f.sourcePath, f.archive);
    const damaged = Buffer.from(f.bytes);
    damaged[damaged.length - 1]! ^= 1;
    const retained = mode === "truncated" ? damaged.subarray(0, -1) : damaged;
    await writeFile(f.target, retained);
    const proof = vi.fn(async () => true);
    if (mode === "wrong-hash")
      await expect(
        releaseVerifiedWorkerVolume(f.archive, proof, f.root),
      ).rejects.toThrow("differs from verified cloud content");
    else
      expect(await releaseVerifiedWorkerVolume(f.archive, proof, f.root)).toBe(
        false,
      );
    expect(proof).toHaveBeenCalledTimes(mode === "wrong-hash" ? 1 : 0);
    expect(await readFile(f.target)).toEqual(retained);
  },
);

it("keeps a same-content replacement when the local file changes during the upstream proof", async () => {
  const f = await fixture();
  await retainWorkerReportVolume(f.sourcePath, f.archive);
  const before = await stat(f.target, { bigint: true });
  const proof = vi.fn(async () => {
    const replacement = join(f.root, "replacement.jsonl.gz");
    await writeFile(replacement, f.bytes);
    await rename(replacement, f.target);
    return true;
  });
  expect(await releaseVerifiedWorkerVolume(f.archive, proof, f.root)).toBe(
    false,
  );
  expect((await stat(f.target, { bigint: true })).ino).not.toBe(before.ino);
  expect(await readFile(f.target)).toEqual(f.bytes);
});

it("leaves an unowned volume file untouched when the catalog scope is empty", async () => {
  const f = await fixture();
  await retainWorkerReportVolume(f.sourcePath, f.archive);
  const before = await stat(f.target, { bigint: true });
  const execute = vi.fn(async (statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement);
    expect(query.sql.trim()).toMatch(/^SELECT/);
    expect(query.sql).not.toMatch(/INSERT|UPDATE|DELETE|GRANT/i);
    expect(query.params).toEqual([
      f.archive.storedSha256,
      f.archive.storedByteSize,
    ]);
    return [];
  });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(
    await releaseUpstreamReadableVolume(
      { execute } as unknown as DB,
      f.archive,
      new AbortController().signal,
    ),
  ).toBe(false);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await stat(f.target, { bigint: true })).toEqual(before);
  expect(await readFile(f.target)).toEqual(f.bytes);
});

it("finishes an empty cleanup scan without creating a volume, querying the database or fetching upstream", async () => {
  const f = await fixture();
  const emptyRoot = join(f.root, "absent-volume");
  vi.stubEnv("AIRFOILFOAM_REPORT_VOLUME_DIR", emptyRoot);
  const controller = new AbortController();
  const walk = workerVolume.workerReportVolumeFiles;
  let completedScan = false;
  const scan = vi
    .spyOn(workerVolume, "workerReportVolumeFiles")
    .mockImplementation(async function* (root) {
      yield* walk(root);
      completedScan = true;
      controller.abort(); // stop only after the real empty iterator completes
    });
  const execute = vi.fn(),
    fetcher = vi.fn();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetcher);
  const deadline = setTimeout(() => controller.abort(), 15_000);
  try {
    await runWorkerVolumeCleanup(
      { execute } as unknown as DB,
      controller.signal,
    );
  } finally {
    clearTimeout(deadline);
  }
  expect(completedScan).toBe(true);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  await expect(stat(emptyRoot)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.sourcePath)).toEqual(f.bytes);
}, 30_000);

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "worker-report-volume-regression-"),
  );
  directories.push(root);
  vi.stubEnv("AIRFOILFOAM_REPORT_VOLUME_DIR", root);
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
  const executionId = randomUUID(),
    token = randomUUID();
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
      expected_execution_pool: "volume-regression",
      expected_solver_budget_version: 2,
      expected_mesh_recovery_version: 1,
      airfoil: { name: "archive-volume-fixture" },
      chord_lengths: [1],
      speeds: [30],
      aoa: { angles: [0] },
      solver: { warm_start: true },
      resources: { case_concurrency: 1, case_solver_budget_seconds: 900 },
    },
  });
  const texts = [1, 2].map((sequence) =>
    JSON.stringify({
      version: 1,
      executionId,
      solverId: envelope.solverId,
      promiseId: envelope.promiseId,
      assignmentSignature: envelope.contentSignature,
      sequence,
      status: {
        job_id: executionId,
        state: "failed",
        large: "__EXACT_INTEGER__",
        nullable: null,
      },
      result: null,
      stopProof: null,
    }).replace('"__EXACT_INTEGER__"', "9007199254740993123456789"),
  );
  const signatures = texts.map((text) =>
    hash(canonicalReportJson(parseReportJson(text))),
  );
  const lines = texts.map((text, index) => {
    const proof = reportTextIdentity(text);
    const metadata = {
      kind: "report",
      sourceKind: "worker",
      executionId,
      sequence: index + 1,
      contentSignature: signatures[index],
      reportSha256: proof.sha256,
      reportByteSize: proof.byteSize,
    };
    return index
      ? JSON.stringify({
          ...metadata,
          reportDelta: { prefix: 0, suffix: 0, middle: text },
        })
      : JSON.stringify(metadata).slice(0, -1) + ',"report":' + text + "}";
  });
  const bytes = gzipSync(lines.join("\n") + "\n");
  const crc = new Storage({
    projectId: "disposable-worker-volume",
  }).crc32cGenerator();
  crc.update(bytes);
  const archive: ProgressiveReportArchiveIdentity = {
    bucket: "disposable-worker-volume",
    objectKey: `progressive-reports/v1/worker/${executionId}/${hash(bytes)}.jsonl.gz`,
    generation: "18446744073709551615",
    mimeType: "application/gzip",
    compression: "gzip",
    archiveFormat: "jsonl",
    storedSha256: hash(bytes),
    storedByteSize: bytes.length,
    crc32c: crc.toString(),
    verifiedAt: new Date(),
  };
  const baseUrl = "https://trusted-hub.example/api/sync/v1";
  const row = {
    worker_instance: randomUUID(),
    solver_id: envelope.solverId,
    promise_id: envelope.promiseId,
    auth_token: "synthetic-worker-token",
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
  const execute = vi.fn(async (statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement);
    expect(query.sql.trim()).toMatch(/^SELECT/);
    expect(query.sql).toContain(
      "promise.registered_solver_id = settings.remote_solver_registered_id",
    );
    expect(query.sql).not.toMatch(/INSERT|UPDATE|DELETE|GRANT/i);
    return query.params[0] === executionId ? [row] : [];
  });
  const db = { execute } as unknown as DB;
  const identity = {
    ...archive,
    sourceKind: "worker" as const,
    memberKind: "report" as const,
    executionId,
    sequence: 2,
    signature: signatures[1]!,
    reportSha256: reportTextIdentity(texts[1]!).sha256,
    reportByteSize: Buffer.byteLength(texts[1]!),
    memberCount: 2,
    firstSequence: 1,
    lastSequence: 2,
  };
  const sourcePath = join(root, "original.jsonl.gz");
  await writeFile(sourcePath, bytes);
  const target = join(
    root,
    archive.storedSha256.slice(0, 2),
    archive.storedSha256 + ".jsonl.gz",
  );
  const headers = {
    "content-type": archive.mimeType,
    "content-length": String(bytes.length),
    "x-content-sha256": archive.storedSha256,
    "x-content-crc32c": archive.crc32c,
    "x-gcs-generation": archive.generation,
    "x-report-archive-bucket": archive.bucket,
    "x-report-archive-object-key": archive.objectKey,
  };
  return {
    root,
    bytes,
    archive,
    identity,
    texts,
    db,
    execute,
    sourcePath,
    target,
    headers,
  };
}

async function compressedBytes(stream: Readable | null) {
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function runCli(
  root: string,
  args: string[],
  bytes: Buffer,
  role = "remote-solver",
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
        env: {
          ...process.env,
          AIRFOILFOAM_DEPLOYMENT_ROLE: role,
          AIRFOILFOAM_REPORT_VOLUME_DIR: root,
        },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      child.stdout.on("data", (bytes) => stdout.push(Buffer.from(bytes)));
      child.stderr.on("data", (bytes) => stderr.push(Buffer.from(bytes)));
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        }),
      );
      // Refused CLI arguments can close stdin before the producer finishes.
      child.stdin.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error);
      });
      child.stdin.end(bytes);
    },
  );
}

it("persists one exact compressed file and reuses a verified same-content copy without replacing it", async () => {
  const f = await fixture();
  await retainWorkerReportVolume(f.sourcePath, f.archive);
  const original = await stat(f.target);
  await Promise.all([
    storeWorkerReportVolume(Readable.from([f.bytes]), f.archive),
    retainWorkerReportVolume(f.sourcePath, f.archive),
  ]);
  expect((await stat(f.target)).ino).toBe(original.ino);
  expect(await readFile(f.target)).toEqual(f.bytes);
  expect(await readFile(f.sourcePath)).toEqual(f.bytes);
  expect(
    await compressedBytes(await readWorkerReportVolume(f.archive)),
  ).toEqual(f.bytes);
  const files = await readdir(f.root, { recursive: true });
  expect(
    files.filter(
      (file) => file.endsWith(".jsonl.gz") && file !== "original.jsonl.gz",
    ),
  ).toEqual([
    join(
      f.archive.storedSha256.slice(0, 2),
      f.archive.storedSha256 + ".jsonl.gz",
    ),
  ]);
  expect(files.some((file) => file.includes(".pending-"))).toBe(false);
});

it.each(["truncated", "wrong-hash", "extra-bytes", "late-stream-error"])(
  "refuses %s input without installing a false copy or deleting the original",
  async (kind) => {
    const f = await fixture();
    const identity =
      kind === "wrong-hash"
        ? { ...f.archive, storedSha256: "0".repeat(64) }
        : f.archive;
    const stream =
      kind === "late-stream-error"
        ? Readable.from(
            (async function* () {
              yield f.bytes;
              throw new Error("late source read failure");
            })(),
          )
        : Readable.from([
            kind === "truncated"
              ? f.bytes.subarray(0, -1)
              : kind === "extra-bytes"
                ? Buffer.concat([f.bytes, Buffer.from([1])])
                : f.bytes,
          ]);
    await expect(storeWorkerReportVolume(stream, identity)).rejects.toThrow();
    expect(await readWorkerReportVolume(identity)).toBeNull();
    expect(await readFile(f.sourcePath)).toEqual(f.bytes);
    expect(
      (await readdir(f.root, { recursive: true })).some((file) =>
        file.includes(".pending-"),
      ),
    ).toBe(false);
  },
);

it.each(["truncated", "same-size-corruption"])(
  "refuses reuse and broker reads of an existing %s file without replacing or masking it",
  async (kind) => {
    const f = await fixture();
    await retainWorkerReportVolume(f.sourcePath, f.archive);
    const damaged = Buffer.from(f.bytes);
    damaged[damaged.length - 1]! ^= 1;
    const retained = kind === "truncated" ? damaged.subarray(0, -1) : damaged;
    await writeFile(f.target, retained);
    const fetcher = vi.fn(
      async () => new Response(f.bytes, { headers: f.headers }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      retainWorkerReportVolume(f.sourcePath, f.archive),
    ).rejects.toThrow();
    expect(await readFile(f.target)).toEqual(retained);
    expect(await readFile(f.sourcePath)).toEqual(f.bytes);
    await expect(
      readStoredWorkerArchiveText(f.db, f.identity),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("reads HZ's actual persisted bytes without a fetch grant and retains them through denied and authorised upstream reads", async () => {
  const f = await fixture();
  await retainWorkerReportVolume(f.sourcePath, f.archive);
  await rm(f.sourcePath);
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ error: "fetch disabled for evidence_artifacts" }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await readStoredWorkerArchiveText(f.db, f.identity)).toBe(f.texts[1]);
  expect(await readWorkerReportArchiveText(f.db, f.identity)).toBe(f.texts[1]);
  expect(fetcher).not.toHaveBeenCalled();
  // A local hit must never masquerade as the current upstream fetch permission.
  await expect(
    readWorkerReportArchiveText(f.db, f.identity, { upstreamOnly: true }),
  ).rejects.toBeInstanceOf(WorkerReportFetchDisabled);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await readFile(f.target)).toEqual(f.bytes);
  fetcher.mockImplementation(
    async () => new Response(f.bytes, { headers: f.headers }),
  );
  expect(
    await readWorkerReportArchiveText(f.db, f.identity, { upstreamOnly: true }),
  ).toBe(f.texts[1]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await readFile(f.target)).toEqual(f.bytes);
});

it("does not treat an unrelated 403 as a fetch-disabled receipt", async () => {
  const f = await fixture();
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ error: "solver does not own this archive" }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    readWorkerReportArchiveText(f.db, f.identity, { upstreamOnly: true }),
  ).rejects.toThrow("no access");
  expect(await readWorkerReportVolume(f.archive)).toBeNull();
  expect(await readFile(f.sourcePath)).toEqual(f.bytes);
});

it("stores and reuses exact stdin bytes through the worker CLI", async () => {
  const f = await fixture();
  const args = ["store", f.archive.storedSha256, String(f.bytes.length)];
  const first = await runCli(f.root, args, f.bytes);
  expect(first.code, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toEqual({
    storedSha256: f.archive.storedSha256,
    storedByteSize: f.bytes.length,
    verified: true,
  });
  const installed = await stat(f.target);
  const replay = await runCli(f.root, args, f.bytes);
  expect(replay.code, replay.stderr).toBe(0);
  expect((await stat(f.target)).ino).toBe(installed.ino);
  expect(await readFile(f.target)).toEqual(f.bytes);
}, 30_000);

it.each(["truncated", "wrong-hash", "hub-role"])(
  "the CLI rejects %s before reporting verified custody",
  async (kind) => {
    const f = await fixture();
    const result = await runCli(
      f.root,
      [
        "store",
        kind === "wrong-hash" ? "0".repeat(64) : f.archive.storedSha256,
        String(f.bytes.length),
      ],
      kind === "truncated" ? f.bytes.subarray(0, -1) : f.bytes,
      kind === "hub-role" ? "hub" : "remote-solver",
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /Expected store|differs from the verified GCS bytes/,
    );
    expect(await readWorkerReportVolume(f.archive)).toBeNull();
    expect(await readFile(f.sourcePath)).toEqual(f.bytes);
  },
  30_000,
);
