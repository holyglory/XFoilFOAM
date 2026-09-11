import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { ProgressiveEvidenceCustodyReceipt } from "@aerodb/db";
import {
  preflightProgressiveArchive,
  runArchiveReclaimPass,
} from "../src/progressive-archive-reclaim";

const bytes = Buffer.from("immutable archive bytes");
const remote = {
  storedByteSize: bytes.length,
  storedSha256: createHash("sha256").update(bytes).digest("hex"),
  generation: "123",
} as ProgressiveEvidenceCustodyReceipt["remote"];
const headers = {
  "content-type": "application/zstd",
  "content-length": String(bytes.length),
  "x-content-sha256": remote.storedSha256,
  "x-gcs-generation": remote.generation,
};

afterEach(() => vi.unstubAllGlobals());

it("gives both archive queues work within the existing eight-claim pass", async () => {
  const legacy = vi.fn(async () => 4);
  const progressive = vi.fn(async () => 3);
  expect(await runArchiveReclaimPass(legacy, progressive)).toBe(7);
  expect(legacy).toHaveBeenCalledWith(4);
  expect(progressive).toHaveBeenCalledWith(4);
});

it("observes safe sibling completion before reporting a reclaim failure", async () => {
  let release: (value: number) => void = () => {};
  const progressive = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      }),
  );
  let finished = false;
  const running = runArchiveReclaimPass(() => {
    throw new Error("legacy unavailable");
  }, progressive).catch((error) => {
    finished = true;
    return error;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(progressive).toHaveBeenCalledWith(4);
  expect(finished).toBe(false);
  release(1);
  expect(await running).toBeInstanceOf(AggregateError);
  expect(finished).toBe(true);
});

it("authenticates to the configured owner and reads every byte of the pinned archive", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(bytes, { headers }));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  await preflightProgressiveArchive(
    "https://hub.example/api/sync/v1/evidence-uploads/test/download",
    "test-token",
    remote,
    signal,
  );
  expect(fetcher).toHaveBeenCalledWith(expect.any(String), {
    redirect: "error",
    signal,
    headers: {
      accept: "application/zstd",
      "x-xfoilfoam-solver-token": "test-token",
    },
  });
});

it.each([
  ["short", bytes.subarray(1), headers, 200],
  ["long", Buffer.concat([bytes, bytes]), headers, 200],
  ["changed", Buffer.alloc(bytes.length), headers, 200],
  ["generation", bytes, { ...headers, "x-gcs-generation": "124" }, 200],
  ["hash", bytes, { ...headers, "x-content-sha256": "f".repeat(64) }, 200],
  ["size", bytes, { ...headers, "content-length": "1" }, 200],
  ["mime", bytes, { ...headers, "content-type": "text/html" }, 200],
  ["unauthorized", bytes, headers, 403],
] as const)(
  "refuses %s without a complete immutable readback",
  async (_name, body, responseHeaders, status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { headers: responseHeaders, status }),
        ),
    );
    await expect(
      preflightProgressiveArchive(
        "https://hub.example/archive",
        "test-token",
        remote,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  },
);

it("refuses a stream that fails after apparently complete data", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
    },
    pull(controller) {
      controller.error(new Error("truncated transport"));
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(stream, { headers })),
  );
  await expect(
    preflightProgressiveArchive(
      "https://hub.example/archive",
      "test-token",
      remote,
      new AbortController().signal,
    ),
  ).rejects.toThrow("truncated transport");
});
