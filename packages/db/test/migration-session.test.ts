import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Sql } from "../src/client";
import {
  prepareMigrationSession,
  SOURCE_GEOMETRY_MIGRATION_BOUNDARY,
} from "../src/migration-session";

function connection(boundary: number | string | null, present = true) {
  const query = vi
    .fn()
    .mockResolvedValueOnce([
      { relation: present ? "drizzle.__drizzle_migrations" : null },
    ]);
  if (present) query.mockResolvedValueOnce([{ boundary }]);
  const unsafe = vi.fn().mockResolvedValue([]);
  return {
    client: Object.assign(query, { unsafe }) as unknown as Sql,
    query,
    unsafe,
  };
}

describe("source geometry migration session", () => {
  it("binds the exceptional plan scope to the unchanged migration journal", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL("../migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    );
    expect(
      journal.entries.find(
        (entry: { tag: string }) =>
          entry.tag === "0163_progressive_source_geometry",
      ).when,
    ).toBe(SOURCE_GEOMETRY_MIGRATION_BOUNDARY);
  });

  it.each([null, SOURCE_GEOMETRY_MIGRATION_BOUNDARY - 1])(
    "bounds and orders the pending backfill only on the owned connection (%s)",
    async (boundary) => {
      const fixture = connection(boundary, boundary !== null);
      expect(await prepareMigrationSession(fixture.client)).toBe(true);
      expect(fixture.unsafe.mock.calls.map(([statement]) => statement)).toEqual(
        [
          "SET join_collapse_limit=1",
          "SET from_collapse_limit=1",
          "SET jit=off",
          "SET statement_timeout='120s'",
        ],
      );
    },
  );

  it.each([
    SOURCE_GEOMETRY_MIGRATION_BOUNDARY,
    SOURCE_GEOMETRY_MIGRATION_BOUNDARY + 1,
  ])(
    "does not change planning after the affected migration (%s)",
    async (boundary) => {
      const fixture = connection(boundary);
      expect(await prepareMigrationSession(fixture.client)).toBe(false);
      expect(fixture.unsafe).not.toHaveBeenCalled();
    },
  );

  it("refuses an unreadable migration boundary", async () => {
    const fixture = connection("invalid");
    await expect(prepareMigrationSession(fixture.client)).rejects.toThrow(
      "Invalid migration journal boundary",
    );
    expect(fixture.unsafe).not.toHaveBeenCalled();
  });
});
