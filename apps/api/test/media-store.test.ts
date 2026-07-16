import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
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
      vi.fn(async () =>
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
