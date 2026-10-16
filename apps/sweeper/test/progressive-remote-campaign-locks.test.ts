import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../src");

const source = (name: string) =>
  readFileSync(resolve(sourceRoot, name), "utf8");

it("uses nonexclusive campaign validation while retaining execution locks", () => {
  const progress = source("progressive-remote-progress.ts");
  const stop = source("progressive-remote-stop-receipt.ts");
  const settlement = source("progressive-remote-settlement.ts");

  for (const content of [progress, stop, settlement]) {
    expect(content).not.toContain("FOR UPDATE OF campaign");
    expect(content).toContain("campaign_owned");
    expect(content).toContain("FOR UPDATE OF job");
  }

  expect(settlement).toContain("FOR SHARE OF epoch FOR UPDATE OF job");
  expect(progress).toContain(
    "FROM sim_jobs job WHERE job.id = ${executionId}::uuid FOR UPDATE OF job",
  );
  expect(stop).toContain(
    "FROM sim_jobs job WHERE job.id = ${executionId}::uuid FOR UPDATE OF job",
  );
});
