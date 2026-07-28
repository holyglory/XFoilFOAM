import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const migration = readFileSync(
  resolve(here, "../migrations/0091_remote_promise_failover_lease.sql"),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(here, "../migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };
const schema = readFileSync(resolve(here, "../src/schema.ts"), "utf8");

describe("0091 remote promise failover lease migration", () => {
  it("makes 72 hours the durable default and upgrades only the old default", () => {
    expect(migration).toContain(
      "ALTER COLUMN default_promise_ttl_hours SET DEFAULT 72",
    );
    expect(migration).toContain("SET default_promise_ttl_hours = 72");
    expect(migration).toContain("WHERE default_promise_ttl_hours = 24");
    expect(schema).toMatch(/defaultPromiseTtlHours:[\s\S]*?\.default\(72\)/);
  });

  it("remains ordered before later migrations", () => {
    expect(journal.entries.find((entry) => entry.idx === 91)).toMatchObject({
      idx: 91,
      tag: "0091_remote_promise_failover_lease",
    });
    expect(journal.entries.findIndex((entry) => entry.idx === 91)).toBeLessThan(
      journal.entries.findIndex((entry) => entry.idx === 92),
    );
  });
});
