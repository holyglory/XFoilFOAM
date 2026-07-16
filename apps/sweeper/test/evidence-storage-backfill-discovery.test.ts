import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverEvidenceMigrationReceipts,
  MIGRATION_RECEIPT_NAME,
} from "../src/evidence-storage-backfill";

const roots: string[] = [];

async function receipt(root: string, jobId: string, caseId = "case-one") {
  const evidence = join(root, "jobs", jobId, "cases", caseId, "a0", "evidence");
  await mkdir(evidence, { recursive: true });
  const path = join(evidence, MIGRATION_RECEIPT_NAME);
  await writeFile(path, "{}", "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("evidence migration receipt discovery", () => {
  it("starts at an explicit job and never reads sibling job trees", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-discovery-job-"));
    roots.push(root);
    const selected = await receipt(root, "job-selected");
    await receipt(root, "job-sibling");
    const calls: string[] = [];
    const siblingRoot = join(root, "jobs", "job-sibling");

    const found = await discoverEvidenceMigrationReceipts(root, {
      jobIds: new Set(["job-selected"]),
      readDirectory: async (path) => {
        calls.push(path);
        if (path.startsWith(siblingRoot)) {
          throw new Error("sibling job must not be traversed");
        }
        return readdir(path, { withFileTypes: true });
      },
    });

    expect(found).toEqual([selected]);
    expect(calls.some((path) => path.startsWith(siblingRoot))).toBe(false);
  });

  it("stops discovery at the receipt limit and prunes heavy solver trees", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-discovery-limit-"));
    roots.push(root);
    const first = await receipt(root, "job-a");
    await receipt(root, "job-b");
    const heavy = join(root, "jobs", "job-a", "cases", "case-one", "VTK");
    await mkdir(join(heavy, "nested"), { recursive: true });
    const calls: string[] = [];

    const found = await discoverEvidenceMigrationReceipts(root, {
      limit: 1,
      readDirectory: async (path) => {
        calls.push(path);
        if (path.startsWith(heavy)) {
          throw new Error("heavy solver tree must be pruned");
        }
        return readdir(path, { withFileTypes: true });
      },
    });

    expect(found).toEqual([first]);
    expect(
      calls.some((path) => path.startsWith(join(root, "jobs", "job-b"))),
    ).toBe(false);
    expect(calls.some((path) => path.startsWith(heavy))).toBe(false);
  });
});
