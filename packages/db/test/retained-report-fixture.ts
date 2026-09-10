import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import {
  retainedSolverReportDownload,
  retainedSolverReports,
} from "../src/retained-solver-reports";
import { progressiveRemoteReportInventory } from "../src/progressive-remote-inventory";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";

export async function verifyRetainedReports(db: DB, executionId: string) {
  const [job] = await db.execute(
    sql`SELECT campaign_id FROM sim_jobs WHERE id=${executionId}::uuid`,
  );
  const filter = { campaignId: String(job.campaign_id), limit: 1 };
  const first = await retainedSolverReports(db, filter);
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).not.toBeNull();
  const second = await retainedSolverReports(db, {
    ...filter,
    cursor: first.nextCursor!,
  });
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(first.items[0].signature).not.toBe(second.items[0].signature);
  for (const report of [...first.items, ...second.items]) {
    expect(report.executionId).toBe(executionId);
    expect(report.sourceCount).toBeGreaterThan(0);
    expect(report.receivedSourceCount).toBe(0);
    expect(report.angles.length).toBeGreaterThan(0);
    expect(report.receivedAt).toMatch(/\.\d{6}Z$/);
    const downloaded = await retainedSolverReportDownload(db, report);
    expect(createHash("sha256").update(downloaded.content).digest("hex")).toBe(
      report.signature,
    );
    expect(JSON.parse(downloaded.content)).toMatchObject({
      executionId,
      sequence: report.sequence,
    });
    expect(downloaded.filename).toMatch(/-solver-report-\d+\.json$/);
    const [dispatch] =
      await db.execute(sql`SELECT envelope,solver_id,promise_id,content_signature AS assignment_signature
      FROM progressive_remote_dispatches WHERE sim_job_id=${executionId}::uuid`);
    const original = JSON.parse(downloaded.content) as ProgressiveRemoteReport;
    const inventory = progressiveRemoteReportInventory(original);
    const stored = {
      ...dispatch,
      report: original,
      inventory_signature: inventory.inventorySignature,
      source_count: inventory.sources.length,
      slug: report.airfoilSlug,
    };
    const altered = structuredClone(original);
    altered.status.message = "altered retained fixture observation";
    for (const changed of [
      { ...stored, report: altered },
      { ...stored, inventory_signature: "0".repeat(64) },
      { ...stored, assignment_signature: "0".repeat(64) },
      { ...stored, source_count: inventory.sources.length + 1 },
    ]) {
      const corrupted = { execute: async () => [changed] } as unknown as DB;
      await expect(
        retainedSolverReportDownload(corrupted, report),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    const wrongRow = { execute: async () => [stored] } as unknown as DB;
    await expect(
      retainedSolverReportDownload(wrongRow, {
        ...report,
        sequence: report.sequence + 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      retainedSolverReportDownload(db, {
        ...report,
        signature: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      retainedSolverReportDownload(db, {
        ...report,
        executionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  }
  expect(
    (await retainedSolverReports(db, { campaignId: randomUUID() })).items,
  ).toEqual([]);
  expect(
    (await retainedSolverReports(db, { ...filter, airfoil: "%" })).items,
  ).toEqual([]);
  expect(
    (
      await retainedSolverReports(db, {
        ...filter,
        airfoil: first.items[0].airfoilSlug,
      })
    ).items,
  ).toHaveLength(1);
  expect(
    (
      await retainedSolverReports(db, {
        campaignId: String(job.campaign_id),
        includeDelivered: true,
      })
    ).items,
  ).toHaveLength(2);
  await expect(
    retainedSolverReports(db, {
      ...filter,
      cursor: first.nextCursor!,
      airfoil: "changed",
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    retainedSolverReports(db, { ...filter, cursor: "invalid" }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(retainedSolverReports(db, { limit: 51 })).rejects.toMatchObject({
    statusCode: 400,
  });
  const rollback = new Error("Restore retained report stop proof");
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      await connection.execute(
        sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}::uuid`,
      );
      expect((await retainedSolverReports(connection, filter)).items).toEqual(
        [],
      );
      await expect(
        retainedSolverReportDownload(connection, first.items[0]),
      ).rejects.toMatchObject({ statusCode: 404 });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
