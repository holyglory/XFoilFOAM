import {
  remoteAssetReferences,
  resultMedia,
  type DB,
  solverEvidenceArtifacts,
} from "@aerodb/db";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { sweepSyncImportOrphans } from "../src/retention";

function fakeDb(referenced: Set<string>): DB {
  const conditionMentionsReference = (
    value: unknown,
    seen = new Set<unknown>(),
  ): boolean => {
    if (typeof value === "string") return referenced.has(value);
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some((nested) =>
      conditionMentionsReference(nested, seen),
    );
  };
  const fake = {
    execute: async () => [],
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const rows =
            (table === solverEvidenceArtifacts ||
              table === resultMedia ||
              table === remoteAssetReferences) &&
            conditionMentionsReference(condition)
              ? [...referenced].map((storageKey) => ({ storageKey }))
              : [];
          return {
            limit: async (count: number) => rows.slice(0, count),
            then: <TResult1 = typeof rows, TResult2 = never>(
              onfulfilled?:
                | ((value: typeof rows) => TResult1 | PromiseLike<TResult1>)
                | null,
              onrejected?:
                | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
                | null,
            ) => Promise.resolve(rows).then(onfulfilled, onrejected),
          };
        },
      }),
    }),
  };
  return {
    ...fake,
    transaction: async <T>(callback: (tx: DB) => Promise<T>) =>
      callback(fake as unknown as DB),
  } as unknown as DB;
}

function writeAt(path: string, value: string, mtime: Date): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
  utimesSync(path, mtime, mtime);
}

describe("sync import crash recovery", () => {
  it("removes stale crash staging and unreferenced blobs but preserves young and referenced shared bytes", async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "xff-sync-gc-"));
    const now = new Date("2026-07-12T00:00:00.000Z");
    const old = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const paths = {
      temp: join(mediaDir, "sync-imports/tmp/crashed-upload.bin"),
      orphan: join(mediaDir, "sync-imports/aa/orphan.bin"),
      shared: join(mediaDir, "sync-imports/bb/shared.bin"),
      young: join(mediaDir, "sync-imports/cc/young.bin"),
    };
    writeAt(paths.temp, "temp", old);
    writeAt(paths.orphan, "orphan", old);
    writeAt(paths.shared, "shared", old);
    writeAt(paths.young, "young", now);
    try {
      expect(
        await sweepSyncImportOrphans(
          fakeDb(new Set(["sync-imports/bb/shared.bin"])),
          {
            now,
            mediaDir,
            tmpMinAgeMs: 60 * 60 * 1000,
            blobMinAgeMs: 60 * 60 * 1000,
            maxPerSweep: 100,
          },
        ),
      ).toBe(2);
      expect(existsSync(paths.temp)).toBe(false);
      expect(existsSync(paths.orphan)).toBe(false);
      expect(existsSync(paths.shared)).toBe(true);
      expect(existsSync(paths.young)).toBe(true);
    } finally {
      rmSync(mediaDir, { recursive: true, force: true });
    }
  });

  it("bounds crash cleanup work per sweep", async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "xff-sync-gc-bound-"));
    const tempDir = join(mediaDir, "sync-imports/tmp");
    const now = new Date("2026-07-12T00:00:00.000Z");
    const old = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    writeAt(join(tempDir, "one.bin"), "one", old);
    writeAt(join(tempDir, "two.bin"), "two", old);
    try {
      expect(
        await sweepSyncImportOrphans(fakeDb(new Set()), {
          now,
          mediaDir,
          tmpMinAgeMs: 1,
          blobMinAgeMs: 1,
          maxPerSweep: 1,
        }),
      ).toBe(1);
      expect(readdirSync(tempDir)).toHaveLength(1);
    } finally {
      rmSync(mediaDir, { recursive: true, force: true });
    }
  });
});
