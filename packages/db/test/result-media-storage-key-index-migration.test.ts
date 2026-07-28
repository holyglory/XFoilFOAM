import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const migration = readFileSync(
  resolve(here, "../migrations/0092_result_media_storage_key_index.sql"),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(here, "../migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };
const schema = readFileSync(resolve(here, "../src/schema.ts"), "utf8");

describe("0092 result-media storage-key index migration", () => {
  it("indexes retention lookups by their exact storage key", () => {
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS "result_media_storage_key_idx"',
    );
    expect(migration).toContain('ON "result_media" ("storage_key")');
    expect(schema).toContain(
      'storageIdx: index("result_media_storage_key_idx").on(t.storageKey)',
    );
  });

  it("is the latest ordered migration", () => {
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 92,
      tag: "0092_result_media_storage_key_index",
    });
  });
});
