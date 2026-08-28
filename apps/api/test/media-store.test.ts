import { Storage } from "@google-cloud/storage";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaUpstreamError, VolumeMediaStore } from "../src/media-store";
import { buildServer } from "../src/server";

const roots: string[] = [];

async function store() {
  const root = await mkdtemp(join(tmpdir(), "aerodb-media-store-"));
  roots.push(root);
  return new VolumeMediaStore(root);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("archived evidence media proxy", () => {
  it("preserves a slow upstream GCS outage as 503 instead of local ENOENT", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response('{"detail":"GCS unavailable"}', { status: 503 });
      }),
    );
    const media = await store();

    await expect(
      media.stream("jobs/job-one/cases/case/evidence/VTK/value.vtu"),
    ).rejects.toMatchObject<Partial<MediaUpstreamError>>({
      name: "MediaUpstreamError",
      statusCode: 503,
      upstreamStatus: 503,
    });
  });

  it("preserves an upstream checksum failure as 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"detail":"checksum mismatch"}', { status: 502 }),
      ),
    );
    const media = await store();

    await expect(
      media.stream("jobs/job-two/cases/case/evidence/engine_evidence.tar.zst"),
    ).rejects.toMatchObject<Partial<MediaUpstreamError>>({
      name: "MediaUpstreamError",
      statusCode: 502,
      upstreamStatus: 502,
    });
  });

  it("maps a network outage to 503 and keeps true 404 available for fallback", async () => {
    const media = await store();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection refused");
      }),
    );
    await expect(
      media.stream("jobs/job-three/cases/case/evidence/VTK/value.vtu"),
    ).rejects.toMatchObject<Partial<MediaUpstreamError>>({
      statusCode: 503,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(
      media.stream("jobs/job-three/cases/case/evidence/missing.vtu"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the engine's archived-evidence 502/503 through /api/media", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildServer();
    try {
      const checksum = await app.inject({
        method: "GET",
        url: "/api/media/jobs/job-four/cases/case/evidence/VTK/value.vtu",
      });
      expect(checksum.statusCode).toBe(502);
      expect(checksum.json().error).toMatch(/integrity verification/);

      const outage = await app.inject({
        method: "GET",
        url: "/api/media/jobs/job-four/cases/case/evidence/VTK/value.vtu",
      });
      expect(outage.statusCode).toBe(503);
      expect(outage.json().error).toMatch(/temporarily unavailable/);
    } finally {
      await app.close();
    }
  });
});

describe("immutable result media objects", () => {
  it("streams only the exact database-pinned GCS generation", async () => {
    const bytes = Buffer.from("stored result media");
    const metadata = {
      generation: "123456789",
      size: String(bytes.byteLength),
      crc32c: "AAAAAA==",
      contentType: "image/png",
      metadata: {
        sha256: "a".repeat(64),
        byteSize: String(bytes.byteLength),
      },
    };
    const fakeStorage = {
      bucket: () => ({
        file: (_key: string, options: { generation: string }) => {
          expect(options.generation).toBe(metadata.generation);
          return {
            getMetadata: async () => [metadata],
            createReadStream: () => Readable.from(bytes),
          };
        },
      }),
    } as unknown as Storage;
    const root = await mkdtemp(join(tmpdir(), "aerodb-media-store-gcs-"));
    roots.push(root);
    const media = new VolumeMediaStore(root, () => fakeStorage);

    const stored = await media.streamStoredMedia({
      bucket: "media-bucket",
      objectKey: "solver-media/v1/sha256/aa/" + "a".repeat(64),
      generation: metadata.generation,
      mimeType: metadata.contentType,
      sha256: "a".repeat(64),
      byteSize: bytes.byteLength,
      crc32c: metadata.crc32c,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stored.stream) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(stored.mime).toBe("image/png");
  });

  it("rejects metadata drift before returning a stream", async () => {
    const fakeStorage = {
      bucket: () => ({
        file: () => ({
          getMetadata: async () => [
            {
              generation: "123456789",
              size: "99",
              crc32c: "AAAAAA==",
              contentType: "image/png",
              metadata: {
                sha256: "b".repeat(64),
                byteSize: "99",
              },
            },
          ],
          createReadStream: () => Readable.from("must not stream"),
        }),
      }),
    } as unknown as Storage;
    const root = await mkdtemp(join(tmpdir(), "aerodb-media-store-gcs-"));
    roots.push(root);
    const media = new VolumeMediaStore(root, () => fakeStorage);

    await expect(
      media.streamStoredMedia({
        bucket: "media-bucket",
        objectKey: "solver-media/v1/sha256/aa/" + "a".repeat(64),
        generation: "123456789",
        mimeType: "image/png",
        sha256: "a".repeat(64),
        byteSize: 10,
        crc32c: "AAAAAA==",
      }),
    ).rejects.toMatchObject<Partial<MediaUpstreamError>>({ statusCode: 502 });
  });
});
