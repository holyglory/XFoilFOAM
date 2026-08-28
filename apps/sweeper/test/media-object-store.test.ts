import { Storage } from "@google-cloud/storage";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  ResultMediaObjectStore,
  resultMediaLocalPath,
} from "../src/media-object-store";

interface FakeObject {
  bytes: Buffer;
  generation: string;
  crc32c: string;
  contentType: string;
  metadata: Record<string, string>;
}

class FakeStorage {
  readonly objects = new Map<string, FakeObject>();
  uploads = 0;
  reads = 0;

  bucket(bucketName: string) {
    return {
      upload: async (
        localPath: string,
        options: {
          destination: string;
          preconditionOpts: { ifGenerationMatch: number };
          metadata: {
            contentType: string;
            metadata: Record<string, string>;
          };
        },
      ) => {
        expect(options.preconditionOpts.ifGenerationMatch).toBe(0);
        this.uploads += 1;
        const key = `${bucketName}/${options.destination}`;
        if (this.objects.has(key)) {
          throw Object.assign(new Error("already exists"), { code: 412 });
        }
        this.objects.set(key, {
          bytes: readFileSync(localPath),
          generation: "123456789",
          crc32c: "AAAAAA==",
          contentType: options.metadata.contentType,
          metadata: { ...options.metadata.metadata },
        });
      },
      file: (objectKey: string, options?: { generation?: string }) => {
        const key = `${bucketName}/${objectKey}`;
        const object = () => {
          const value = this.objects.get(key);
          if (!value)
            throw Object.assign(new Error("not found"), { code: 404 });
          if (options?.generation && value.generation !== options.generation) {
            throw Object.assign(new Error("generation changed"), { code: 412 });
          }
          return value;
        };
        return {
          getMetadata: async () => {
            const value = object();
            return [
              {
                generation: value.generation,
                crc32c: value.crc32c,
                size: String(value.bytes.byteLength),
                contentType: value.contentType,
                metadata: { ...value.metadata },
              },
            ];
          },
          createReadStream: () => {
            this.reads += 1;
            return Readable.from(object().bytes);
          },
        };
      },
    };
  }
}

const temporaryRoots: string[] = [];

function mediaFile(bytes: Buffer) {
  const root = mkdtempSync(join(tmpdir(), "xff-media-object-"));
  temporaryRoots.push(root);
  const path = join(root, "media.bin");
  writeFileSync(path, bytes);
  return {
    path,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("result media object storage", () => {
  it("uses create-only upload and verifies the pinned generation to EOF on retries", async () => {
    const local = mediaFile(Buffer.from("immutable result media"));
    const fake = new FakeStorage();
    const store = new ResultMediaObjectStore(
      "media-bucket",
      "solver-media/v1",
      fake as unknown as Storage,
    );

    const first = await store.putFile({
      localPath: local.path,
      mimeType: "image/png",
      sha256: local.sha256,
      byteSize: local.byteSize,
    });
    const retry = await store.putFile({
      localPath: local.path,
      mimeType: "image/png",
      sha256: local.sha256,
      byteSize: local.byteSize,
    });

    expect({ ...retry, verifiedAt: undefined }).toMatchObject({
      ...first,
      verifiedAt: undefined,
    });
    expect(first.objectKey).toBe(
      `solver-media/v1/sha256/${local.sha256.slice(0, 2)}/${local.sha256}`,
    );
    expect(fake.uploads).toBe(2);
    expect(fake.reads).toBe(2);
    expect(fake.objects.size).toBe(1);
  });

  it("rejects a pre-existing object whose bytes do not match its content address", async () => {
    const local = mediaFile(Buffer.from("expected media"));
    const fake = new FakeStorage();
    const store = new ResultMediaObjectStore(
      "media-bucket",
      "solver-media/v1",
      fake as unknown as Storage,
    );
    const stored = await store.putFile({
      localPath: local.path,
      mimeType: "video/mp4",
      sha256: local.sha256,
      byteSize: local.byteSize,
    });
    fake.objects.get(`${stored.bucket}/${stored.objectKey}`)!.bytes =
      Buffer.from("forged media");

    await expect(
      store.putFile({
        localPath: local.path,
        mimeType: "video/mp4",
        sha256: local.sha256,
        byteSize: local.byteSize,
      }),
    ).rejects.toThrow(/metadata does not match|readback verification/);
  });

  it("never resolves a local reclaim key outside managed media roots", () => {
    expect(() =>
      resultMediaLocalPath("../../etc/passwd", "/tmp/media"),
    ).toThrow(/outside managed media storage/);
    expect(() =>
      resultMediaLocalPath("jobs/a/file.png", "/tmp/media"),
    ).not.toThrow();
  });
});
