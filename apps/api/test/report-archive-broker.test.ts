import { CRC32C, type File } from "@google-cloud/storage";
import { analysisContentHash, type DB } from "@aerodb/db";
import { reportTextIdentity } from "@aerodb/db/progressive-report-archive";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import Fastify from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import {
  putBrokeredWorkerReportBundle,
  registerReportArchiveBrokerRoutes,
} from "../src/report-archive-broker";

// These route tests use isolated DB/storage doubles, never the shared database.
const cloud = vi.hoisted(() => ({ bucket: vi.fn() }));
vi.mock("@google-cloud/storage", async (original) => ({
  ...(await original<typeof import("@google-cloud/storage")>()),
  Storage: class {
    bucket = cloud.bucket;
  },
}));
vi.mock("../src/env", () => ({ env: { evidenceBucket: "report-bucket" } }));

afterEach(() => vi.clearAllMocks());

function checksum(bytes: Buffer) {
  const crc = new CRC32C();
  crc.update(bytes);
  return crc.toString();
}

async function fixture() {
  const solver = { id: randomUUID(), instanceId: "isolated-worker" };
  const executionId = randomUUID();
  const promiseId = randomUUID();
  const assignmentSignature = "a".repeat(64);
  const token = "registered-worker-fixture-token";
  const generation = "18446744073709551615";
  const objects = new Map<
    string,
    { bytes: Buffer; metadata: Record<string, any> }
  >();
  const state = {
    readError: false,
    readbacks: 0,
    canPush: true,
    canFetch: true,
    revoked: false,
    requests: [] as Array<{ kind: "metadata" | "media"; generation: unknown }>,
  };
  const file = vi.fn((key: string, options?: { generation?: string }) => {
    const interceptors: File["interceptors"] = [];
    const queryGeneration = (kind: "metadata" | "media") => {
      let request: Parameters<File["interceptors"][number]["request"]>[0] = {
        uri: "https://storage.fixture.invalid/object",
        qs: options?.generation
          ? { generation: Number(options.generation) }
          : {},
      };
      for (const interceptor of interceptors)
        request = interceptor.request(request);
      const generation = request.qs.generation;
      state.requests.push({ kind, generation });
      return generation;
    };
    return {
      interceptors,
      getMetadata: vi.fn(async () => {
        const object = objects.get(key);
        const requestedGeneration = queryGeneration("metadata");
        if (
          !object ||
          (requestedGeneration !== undefined &&
            requestedGeneration !== object.metadata.generation)
        )
          throw Object.assign(new Error("storage fixture missing generation"), {
            code: 404,
          });
        return [object.metadata];
      }),
      createReadStream: vi.fn(() => {
        expect(queryGeneration("media")).toBe(generation);
        return Readable.from(
          (async function* () {
            yield objects.get(key)!.bytes;
            if (state.readError) throw new Error("late storage stream failure");
            state.readbacks++;
          })(),
        );
      }),
    };
  });
  const upload = vi.fn(async (path: string, options: Record<string, any>) => {
    expect(options.preconditionOpts).toEqual({ ifGenerationMatch: 0 });
    expect(options.validation).toBe("crc32c");
    if (objects.has(options.destination))
      throw Object.assign(new Error("already exists"), { code: 412 });
    const bytes = await readFile(path);
    objects.set(options.destination, {
      bytes,
      metadata: {
        ...options.metadata,
        generation,
        size: String(bytes.byteLength),
        crc32c: checksum(bytes),
      },
    });
  });
  cloud.bucket.mockReturnValue({ upload, file });
  const dialect = new PgDialect();
  const execute = vi.fn(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    expect(query.sql.trim().startsWith("SELECT")).toBe(true);
    expect(query.sql).toContain("solver.revoked_at IS NULL");
    expect(query.sql).not.toMatch(/lease|expires|status|UPDATE|INSERT/i);
    return query.params[0] === executionId &&
      query.params[1] === solver.id &&
      query.params[2] === solver.instanceId
      ? [{ promise_id: promiseId, content_signature: assignmentSignature }]
      : [];
  });
  const app = Fastify();
  await registerReportArchiveBrokerRoutes(app, {
    db: { execute } as unknown as DB,
    authenticate: async (req, reply) => {
      if (state.revoked || req.headers["x-xfoilfoam-solver-token"] !== token) {
        reply
          .code(401)
          .send({ error: "registered worker credential required" });
        return null;
      }
      return solver;
    },
    permit: async (direction) =>
      direction === "push" ? state.canPush : state.canFetch,
  });
  const report = (sequence: number) => ({
    version: 1,
    solverId: solver.id,
    promiseId,
    executionId,
    assignmentSignature,
    sequence,
    status: { job_id: executionId, state: "failed" },
    result: null,
    stopProof: null,
  });
  const bundle = (
    reports = [report(10), report(11)],
    change?: (entry: Record<string, any>, index: number) => void,
  ) => {
    let previous = "";
    const texts: string[] = [];
    const lines = reports.map((value, index) => {
      // PostgreSQL ::text spacing differs from canonical content signatures.
      const text = JSON.stringify(value, null, 1).replace(/\n\s*/g, "");
      texts.push(text);
      const proof = reportTextIdentity(text);
      const entry: Record<string, any> = {
        sourceKind: "worker",
        kind: "report",
        executionId,
        sequence: value.sequence,
        contentSignature: analysisContentHash(value),
        reportSha256: proof.sha256,
        reportByteSize: proof.byteSize,
      };
      if (index) {
        let prefix = 0;
        while (
          prefix < previous.length &&
          prefix < text.length &&
          previous[prefix] === text[prefix]
        )
          prefix++;
        let suffix = 0;
        while (
          suffix < previous.length - prefix &&
          suffix < text.length - prefix &&
          previous.at(-suffix - 1) === text.at(-suffix - 1)
        )
          suffix++;
        entry.reportDelta = {
          prefix,
          suffix,
          middle: text.slice(prefix, text.length - suffix),
        };
      } else entry.report = value;
      change?.(entry, index);
      previous = text;
      // Preserve the exact report text on direct members.
      return index
        ? JSON.stringify(entry)
        : `${JSON.stringify(entry).slice(0, JSON.stringify(entry).lastIndexOf(',"report":'))},"report":${text}}`;
    });
    const bytes = gzipSync(`${lines.join("\n")}\n`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const url = `/api/sync/v1/progressive-executions/${executionId}/report-archives/${sha256}?byteSize=${bytes.length}`;
    return { bytes, sha256, url, texts };
  };
  const headers = {
    "content-type": "application/gzip",
    "x-xfoilfoam-solver-token": token,
  };
  return {
    app,
    state,
    solver,
    executionId,
    promiseId,
    report,
    bundle,
    objects,
    upload,
    file,
    execute,
    headers,
    generation,
  };
}

it("pins every metadata and media request to the exact uint64 generation string", async () => {
  const f = await fixture();
  try {
    const page = f.bundle();
    const uploaded = await f.app.inject({
      method: "POST",
      url: page.url,
      headers: f.headers,
      payload: page.bytes,
    });
    expect(uploaded.statusCode).toBe(200);
    const receipt = uploaded.json();
    const restored = await f.app.inject({
      url: `${page.url}&generation=${f.generation}&crc32c=${encodeURIComponent(receipt.crc32c)}`,
      headers: f.headers,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.rawPayload).toEqual(page.bytes);
    const pinned = f.state.requests.filter(
      (request) => request.generation !== undefined,
    );
    expect(pinned.some((request) => request.kind === "metadata")).toBe(true);
    expect(pinned.some((request) => request.kind === "media")).toBe(true);
    expect(
      pinned.every(
        (request) =>
          request.generation === f.generation &&
          typeof request.generation === "string",
      ),
    ).toBe(true);
  } finally {
    await f.app.close();
  }
});

it("archives bounded delta pages on a closed dispatch, verifies the exact generation to EOF, and replays immutably", async () => {
  const f = await fixture();
  try {
    const page = f.bundle();
    const response = await f.app.inject({
      method: "POST",
      url: page.url,
      headers: f.headers,
      payload: page.bytes,
    });
    expect(response.statusCode).toBe(200);
    const receipt = response.json();
    expect(receipt).toMatchObject({
      storedSha256: page.sha256,
      storedByteSize: page.bytes.length,
      generation: f.generation,
      crc32c: checksum(page.bytes),
      compression: "gzip",
      archiveFormat: "jsonl",
    });
    expect(receipt.objectKey).toContain(
      `/worker/${f.executionId}/${page.sha256}.jsonl.gz`,
    );
    expect(f.state.readbacks).toBe(1);
    const replay = await f.app.inject({
      method: "POST",
      url: page.url,
      headers: f.headers,
      payload: page.bytes,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().generation).toBe(receipt.generation);
    const second = f.bundle([f.report(20), f.report(21)]);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: second.url,
          headers: f.headers,
          payload: second.bytes,
        })
      ).statusCode,
    ).toBe(200);
    expect(f.objects.size).toBe(2);
    expect(f.execute).toHaveBeenCalledTimes(6);
    expect(response.body).not.toMatch(
      /authToken|uploadUrl|credential|capability/i,
    );
  } finally {
    await f.app.close();
  }
});

it("requires registered authentication and permissions before storage access", async () => {
  const f = await fixture();
  try {
    const page = f.bundle();
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: page.url,
          payload: page.bytes,
          headers: {
            "content-type": "application/gzip",
            "x-xfoilfoam-sync-secret": "shared-secret",
          },
        })
      ).statusCode,
    ).toBe(401);
    f.state.canPush = false;
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: page.url,
          payload: page.bytes,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(403);
    f.state.revoked = true;
    expect(
      (await f.app.inject({ url: page.url, headers: f.headers })).statusCode,
    ).toBe(401);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});

it("rejects foreign executions, unsafe object overrides, wrong hashes, and wrong declared sizes", async () => {
  const f = await fixture();
  try {
    const page = f.bundle();
    for (const [url, status] of [
      [page.url.replace(f.executionId, randomUUID()), 403],
      [`${page.url}&bucket=foreign`, 400],
      [page.url.replace(page.sha256, "0".repeat(64)), 409],
      [
        page.url.replace(
          `byteSize=${page.bytes.length}`,
          `byteSize=${page.bytes.length + 1}`,
        ),
        400,
      ],
    ] as const) {
      expect(
        (
          await f.app.inject({
            method: "POST",
            url,
            headers: f.headers,
            payload: page.bytes,
          })
        ).statusCode,
      ).toBe(status);
    }
    expect(f.upload).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});

it.each(["executionId", "solverId", "promiseId", "assignmentSignature"])(
  "rejects reconstructed delta reports with foreign %s",
  async (field) => {
    const f = await fixture();
    try {
      const foreign = {
        ...f.report(11),
        [field]:
          field === "assignmentSignature" ? "b".repeat(64) : randomUUID(),
      };
      const page = f.bundle([f.report(10), foreign]);
      const response = await f.app.inject({
        method: "POST",
        url: page.url,
        headers: f.headers,
        payload: page.bytes,
      });
      expect(response.statusCode).toBe(409);
      expect(f.upload).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  },
);

it("rejects false PG text proofs and duplicate members before any cloud write", async () => {
  const f = await fixture();
  try {
    for (const page of [
      f.bundle(undefined, (entry, index) => {
        if (index) entry.reportSha256 = "f".repeat(64);
      }),
      f.bundle([f.report(10), f.report(10)]),
    ]) {
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: page.url,
            headers: f.headers,
            payload: page.bytes,
          })
        ).statusCode,
      ).toBe(409);
    }
    expect(f.upload).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});

it("does not issue a receipt when the generation readback fails after delivering its bytes", async () => {
  const f = await fixture();
  try {
    f.state.readError = true;
    const page = f.bundle();
    const response = await f.app.inject({
      method: "POST",
      url: page.url,
      headers: f.headers,
      payload: page.bytes,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).not.toHaveProperty("verifiedAt");
    expect(f.state.readbacks).toBe(0);
  } finally {
    await f.app.close();
  }
});

it("rejects an oversized or failed request stream before writing a cloud object", async () => {
  const f = await fixture();
  try {
    const page = f.bundle();
    const db = { execute: f.execute } as unknown as DB;
    const identity = { sha256: page.sha256, byteSize: page.bytes.length };
    await expect(
      putBrokeredWorkerReportBundle(
        db,
        f.solver,
        f.executionId,
        identity,
        Readable.from([page.bytes, Buffer.from("excess")]),
      ),
    ).rejects.toThrow(/declared byte size/);
    await expect(
      putBrokeredWorkerReportBundle(
        db,
        f.solver,
        f.executionId,
        identity,
        Readable.from(
          (async function* () {
            yield page.bytes;
            throw new Error("late request stream error");
          })(),
        ),
      ),
    ).rejects.toThrow(/late request stream error/);
    expect(f.upload).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});

it("restores only the exact generation and rejects corrupted bytes or metadata", async () => {
  const f = await fixture();
  try {
    const page = f.bundle();
    const uploaded = await f.app.inject({
      method: "POST",
      url: page.url,
      headers: f.headers,
      payload: page.bytes,
    });
    expect(uploaded.statusCode).toBe(200);
    const receipt = uploaded.json();
    const url = `${page.url}&generation=${receipt.generation}&crc32c=${encodeURIComponent(receipt.crc32c)}`;
    const restored = await f.app.inject({ url, headers: f.headers });
    expect(restored.statusCode).toBe(200);
    expect(restored.rawPayload).toEqual(page.bytes);
    expect(restored.headers["content-length"]).toBe(String(page.bytes.length));
    expect(restored.headers["x-gcs-generation"]).toBe(f.generation);
    expect(
      (
        await f.app.inject({
          url: url.replace(f.generation, "2"),
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.app.inject({
          url: url.replace(f.executionId, randomUUID()),
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(403);
    const object = f.objects.get(receipt.objectKey)!;
    const original = Buffer.from(object.bytes);
    object.bytes[object.bytes.length - 1] ^= 1;
    expect((await f.app.inject({ url, headers: f.headers })).statusCode).toBe(
      409,
    );
    object.bytes = original;
    object.metadata.crc32c = "AAAAAA==";
    expect((await f.app.inject({ url, headers: f.headers })).statusCode).toBe(
      409,
    );
  } finally {
    await f.app.close();
  }
});

it("rechecks reconstructed delta scope when restoring an already stored object", async () => {
  const f = await fixture();
  try {
    const page = f.bundle();
    const response = await f.app.inject({
      method: "POST",
      url: page.url,
      headers: f.headers,
      payload: page.bytes,
    });
    expect(response.statusCode).toBe(200);
    const receipt = response.json();
    const foreign = f.bundle([
      f.report(10),
      { ...f.report(11), solverId: randomUUID() },
    ]);
    const original = f.objects.get(receipt.objectKey)!;
    const key = receipt.objectKey.replace(page.sha256, foreign.sha256);
    f.objects.set(key, {
      bytes: foreign.bytes,
      metadata: {
        ...original.metadata,
        size: String(foreign.bytes.length),
        crc32c: checksum(foreign.bytes),
        metadata: {
          ...original.metadata.metadata,
          sha256: foreign.sha256,
          byteSize: String(foreign.bytes.length),
        },
      },
    });
    const url = `${foreign.url}&generation=${f.generation}&crc32c=${encodeURIComponent(checksum(foreign.bytes))}`;
    expect((await f.app.inject({ url, headers: f.headers })).statusCode).toBe(
      409,
    );
  } finally {
    await f.app.close();
  }
});
