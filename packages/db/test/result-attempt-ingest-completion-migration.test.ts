import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const migration = readFileSync(
  resolve(here, "../migrations/0093_result_attempt_ingest_completion.sql"),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(here, "../migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };
const schema = readFileSync(resolve(here, "../src/schema.ts"), "utf8");

describe("0093 exact-attempt ingest completion migration", () => {
  it("binds one versioned full payload signature to the exact attempt owner", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS result_attempt_ingest_completions",
    );
    expect(migration).toContain("result_attempt_id uuid PRIMARY KEY NOT NULL");
    expect(migration).toContain("FOREIGN KEY (result_attempt_id, result_id)");
    expect(migration).toContain("REFERENCES result_attempts(id, result_id)");
    expect(migration).toContain("ON DELETE CASCADE");
    expect(migration).toContain("CHECK (payload_signature ~ '^[0-9a-f]{64}$')");
    expect(schema).toContain(
      "export const resultAttemptIngestCompletions = pgTable(",
    );
    expect(schema).toContain(
      '"result_attempt_ingest_completions_attempt_owner_fk"',
    );
  });

  it("does not backfill an unproved historical projection", () => {
    expect(migration).not.toMatch(
      /INSERT\s+INTO\s+result_attempt_ingest_completions/i,
    );
  });

  it("is the latest ordered migration", () => {
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 93,
      tag: "0093_result_attempt_ingest_completion",
    });
  });
});
