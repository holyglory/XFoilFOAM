import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverEvidenceMigrationReceipts,
  MIGRATION_RECEIPT_NAME,
} from "../src/evidence-storage-backfill";

const roots: string[] = [];

async function receipt(
  root: string,
  jobId: string,
  caseId = "case-one",
  angle = "a0",
) {
  const evidence = join(
    root,
    "jobs",
    jobId,
    "cases",
    caseId,
    angle,
    "evidence",
  );
  await mkdir(evidence, { recursive: true });
  const path = join(evidence, MIGRATION_RECEIPT_NAME);
  await writeFile(path, "{}", "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
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

  it("selects sorted deduplicated exact paths without prefix leakage and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-discovery-exact-"));
    roots.push(root);
    const first = await receipt(root, "job-selected", "case-one", "a0");
    const second = await receipt(root, "job-selected", "case-one", "a1");
    await receipt(root, "job-selected", "case-one", "a1-extra");
    const selectedPaths = [
      "cases/case-one/a1/evidence",
      "cases/case-one/a0/evidence",
      "cases/case-one/a1/evidence",
    ];

    const discover = () =>
      discoverEvidenceMigrationReceipts(root, {
        jobIds: new Set(["job-selected"]),
        evidencePaths: selectedPaths,
      });

    await expect(discover()).resolves.toEqual([first, second]);
    await expect(discover()).resolves.toEqual([first, second]);
  });

  it.each([
    "../job-two/cases/case-one/a0/evidence",
    "/cases/case-one/a0/evidence",
    "cases//case-one/a0/evidence",
    "cases/./case-one/a0/evidence",
    "cases/case-one/../a0/evidence",
    "cases\\case-one\\a0\\evidence",
    "cases/case-one/a0/evidence\n",
  ])("rejects unsafe exact evidence path %j", async (evidencePath) => {
    const root = await mkdtemp(join(tmpdir(), "evidence-discovery-unsafe-"));
    roots.push(root);

    await expect(
      discoverEvidenceMigrationReceipts(root, {
        jobIds: new Set(["job-selected"]),
        evidencePaths: [evidencePath],
      }),
    ).rejects.toThrow(/--evidence-path/);
  });

  it("requires one exact job, forbids limit, and fails closed on cross-job paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-discovery-scope-"));
    roots.push(root);
    await receipt(root, "job-one", "case-one");
    await receipt(root, "job-two", "only-job-two");
    const path = "cases/case-one/a0/evidence";

    await expect(
      discoverEvidenceMigrationReceipts(root, {
        evidencePaths: [path],
      }),
    ).rejects.toThrow("requires exactly one --job-id");
    await expect(
      discoverEvidenceMigrationReceipts(root, {
        jobIds: new Set(["job-one", "job-two"]),
        evidencePaths: [path],
      }),
    ).rejects.toThrow("requires exactly one --job-id");
    await expect(
      discoverEvidenceMigrationReceipts(root, {
        jobIds: new Set(["job-one"]),
        evidencePaths: [path],
        limit: 1,
      }),
    ).rejects.toThrow("cannot be combined with --limit");
    await expect(
      discoverEvidenceMigrationReceipts(root, {
        jobIds: new Set(["job-one"]),
        evidencePaths: [path, "cases/only-job-two/a0/evidence"],
      }),
    ).rejects.toThrow("did not resolve in the exact job");
  });
});
