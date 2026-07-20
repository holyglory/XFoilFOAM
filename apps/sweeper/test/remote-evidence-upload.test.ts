import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, expect, it, vi } from "vitest";

const mediaDir = join(
  tmpdir(),
  `remote-evidence-upload-${process.pid}-${Date.now()}`,
);
mkdirSync(mediaDir, { recursive: true });
process.env.MEDIA_DIR = mediaDir;

const { uploadBrokeredEvidenceFile } = await import("../src/remote-solver");
const expectedCapability = {
  bucket: "evidence-bucket",
  objectKey: "solver-evidence/v1/sha256/aa/abc.tar.zst",
};
const validCapability =
  "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&upload_id=opaque&ifGenerationMatch=0";

afterEach(() => vi.unstubAllGlobals());
afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

it("uploads exact tar.zst bytes through an opaque capability without credentials", async () => {
  const bytes = Buffer.from("exact-compressed-evidence");
  writeFileSync(join(mediaDir, "bundle.tar.zst"), bytes);
  const seen: Array<{ url: string; headers: Headers; body: Buffer }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as unknown as AsyncIterable<Buffer>)
        chunks.push(Buffer.from(chunk));
      seen.push({
        url,
        headers: new Headers(init.headers),
        body: Buffer.concat(chunks),
      });
      expect(init.redirect).toBe("manual");
      return new Response(
        JSON.stringify({ generation: "9007199254740993123" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }),
  );

  const generation = await uploadBrokeredEvidenceFile(
    validCapability,
    expectedCapability,
    "bundle.tar.zst",
    bytes.length,
    async () => undefined,
  );

  expect(generation).toBe("9007199254740993123");
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe(validCapability);
  expect(seen[0]!.headers.get("authorization")).toBeNull();
  expect(seen[0]!.headers.get("content-range")).toBe(
    `bytes 0-${bytes.length - 1}/${bytes.length}`,
  );
  expect(seen[0]!.headers.get("content-length")).toBe(String(bytes.length));
  expect(seen[0]!.body).toEqual(bytes);
});

it("resumes at the exact committed byte and rejects local size drift", async () => {
  const chunkSize = 8 * 1024 * 1024;
  const bytes = Buffer.alloc(chunkSize + 17, 0x5a);
  writeFileSync(join(mediaDir, "resumable.tar.zst"), bytes);
  const ranges: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBeNull();
      ranges.push(headers.get("content-range") ?? "");
      for await (const _chunk of init.body as unknown as AsyncIterable<Buffer>) {
        // Consume the exact file range before returning the committed offset.
      }
      if (ranges.length === 1) {
        // Node's native fetch interprets 308 as a redirect before callers can
        // inspect the resumable-protocol response when redirect="error".
        // The production regression only appears once a bundle exceeds the
        // 8 MiB chunk size, so model that behavior explicitly here.
        if (init.redirect === "error") throw new TypeError("fetch failed");
        expect(init.redirect).toBe("manual");
        return new Response(null, {
          status: 308,
          headers: { range: `bytes=0-${chunkSize - 1}` },
        });
      }
      expect(init.redirect).toBe("manual");
      return new Response(null, {
        status: 200,
        headers: { "x-goog-generation": "18446744073709551615" },
      });
    }),
  );

  await expect(
    uploadBrokeredEvidenceFile(
      validCapability,
      expectedCapability,
      "resumable.tar.zst",
      bytes.length + 1,
      async () => undefined,
    ),
  ).rejects.toThrow(/declared size/);
  expect(fetch).not.toHaveBeenCalled();

  await expect(
    uploadBrokeredEvidenceFile(
      validCapability,
      expectedCapability,
      "resumable.tar.zst",
      bytes.length,
      async () => undefined,
    ),
  ).resolves.toBe("18446744073709551615");
  expect(ranges).toEqual([
    `bytes 0-${chunkSize - 1}/${bytes.length}`,
    `bytes ${chunkSize}-${bytes.length - 1}/${bytes.length}`,
  ]);
});

it("rejects redirects and never follows the capability to another host", async () => {
  const bytes = Buffer.from("redirect-evidence");
  writeFileSync(join(mediaDir, "redirect.tar.zst"), bytes);
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.redirect).toBe("manual");
    for await (const _chunk of init.body as unknown as AsyncIterable<Buffer>) {
      // A real fetch consumes the request stream before returning a response.
    }
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/exfiltrate" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    uploadBrokeredEvidenceFile(
      validCapability,
      expectedCapability,
      "redirect.tar.zst",
      bytes.length,
      async () => undefined,
    ),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(
    fetchMock.mock.calls.every(([url]) => String(url) === validCapability),
  ).toBe(true);
});
