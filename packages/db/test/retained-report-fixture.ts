import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import {
  retainedSolverReportDownload,
  retainedSolverReports,
} from "../src/retained-solver-reports";
import { progressiveRemoteReportInventory } from "../src/progressive-remote-inventory";
import {
  progressiveReportedPointSources,
  type ProgressiveRemoteReport,
} from "../src/progressive-remote-report";
import {
  analysisContentHash,
  canonicalAnalysisJson,
} from "../src/analysis-target";
import {
  canonicalReportJson,
  parseReportJson,
  reportTextIdentity,
} from "../src/progressive-report-archive";

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
      resolved_report_text: canonicalAnalysisJson(original),
      inventory_signature: inventory.inventorySignature,
      source_count: inventory.sources.length,
      slug: report.airfoilSlug,
    };
    const altered = structuredClone(original);
    altered.status.message = "altered retained fixture observation";
    for (const changed of [
      { ...stored, resolved_report_text: canonicalAnalysisJson(altered) },
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

    // PostgreSQL itself supplies the stored text. The download may reorder keys
    // and normalize equivalent spellings, but must conserve every numeric value.
    const annotated = structuredClone(original);
    const numericToken = "retained-precise-number-token";
    for (const polar of annotated.result!.polars)
      for (const point of [...polar.points, ...(polar.attempts ?? [])])
        Object.assign(point, { retained_precise_integer: numericToken });
    const expandToken = (text: string) =>
      text.replaceAll(
        JSON.stringify(numericToken),
        "9007199254740993123456789",
      );
    const precise = expandToken(canonicalAnalysisJson(annotated)).replace(
      '"status":{',
      '"status":{"largeInteger":9007199254740993123456789,"preciseDecimal":0.123456789012345678901,"huge":1e400,',
    );
    const [pg] = await db.execute(sql`SELECT ${precise}::jsonb::text AS text`);
    const pgText = String(pg.text);
    const exactContent = canonicalReportJson(parseReportJson(pgText));
    const exactSignature = reportTextIdentity(exactContent).sha256;
    const exactSources = [
      ...new Map(
        progressiveReportedPointSources(annotated.result!).map(
          ({ point, polar }) => {
            const sourceSignature = reportTextIdentity(
              expandToken(
                canonicalAnalysisJson({
                  kind: "progressive-reported-point-v1",
                  executionId: annotated.result!.job_id,
                  chord: polar.chord,
                  speed: polar.speed,
                  reynolds: polar.reynolds,
                  mach: polar.mach ?? null,
                  point,
                }),
              ),
            ).sha256;
            return [
              sourceSignature,
              {
                point_content_signature: sourceSignature,
                aoa_deg: point.aoa_deg,
                case_slug: point.case_slug ?? null,
              },
            ] as const;
          },
        ),
      ).values(),
    ].sort((a, b) =>
      a.point_content_signature.localeCompare(b.point_content_signature),
    );
    expect(exactSources).toHaveLength(inventory.sources.length);
    const exactInventory = analysisContentHash({
      kind: "progressive-remote-report-inventory-v1",
      executionId,
      sequence: report.sequence,
      reportContentSignature: exactSignature,
      sources: exactSources,
    });
    const roundedSources = progressiveReportedPointSources(
      JSON.parse(pgText).result,
    )
      .map(({ point, contentSignature }) => ({
        point_content_signature: contentSignature,
        aoa_deg: point.aoa_deg,
        case_slug: point.case_slug ?? null,
      }))
      .sort((a, b) =>
        a.point_content_signature.localeCompare(b.point_content_signature),
      );
    const roundedInventory = analysisContentHash({
      kind: "progressive-remote-report-inventory-v1",
      executionId,
      sequence: report.sequence,
      reportContentSignature: exactSignature,
      sources: roundedSources,
    });
    const exactStored = {
      ...stored,
      resolved_report_text: pgText,
      inventory_signature: exactInventory,
    };
    const exactDb = { execute: async () => [exactStored] } as unknown as DB;
    const reference = { ...report, signature: exactSignature };
    const exactDownload = await retainedSolverReportDownload(
      exactDb,
      reference,
    );
    expect(exactDownload.content).toBe(exactContent);
    expect(exactDownload.content).toContain("9007199254740993123456789");
    expect(exactDownload.content).toContain("0.123456789012345678901");
    expect(exactDownload.content).toContain(`"huge":${"1" + "0".repeat(400)}`);
    expect(reportTextIdentity(exactDownload.content).sha256).toBe(
      exactSignature,
    );

    const member = reportTextIdentity(pgText);
    const archived = {
      ...exactStored,
      archive_bundle_id: randomUUID(),
      archive_bucket: "fixture-bucket",
      archive_object_key: "reports/fixture.jsonl.gz",
      archive_generation: "90071992547409931",
      archive_mime_type: "application/gzip",
      archive_compression: "gzip",
      archive_format: "jsonl",
      archive_stored_sha256: "a".repeat(64),
      archive_stored_byte_size: 100,
      archive_crc32c: "AAAAAA==",
      archive_member_count: 1,
      archive_first_sequence: report.sequence,
      archive_last_sequence: report.sequence,
      archive_report_sha256: member.sha256,
      archive_report_byte_size: member.byteSize,
    };
    const archivedDb = { execute: async () => [archived] } as unknown as DB;
    await expect(
      retainedSolverReportDownload(archivedDb, reference),
    ).rejects.toMatchObject({ statusCode: 503 });
    const archiveReader = {
      read: async (
        identity: import("../src/progressive-report-archive").ProgressiveReportArchiveReadIdentity,
      ) => {
        expect(identity).toMatchObject({
          sourceKind: "remote",
          memberKind: "report",
          reportSha256: member.sha256,
          reportByteSize: member.byteSize,
          generation: archived.archive_generation,
          memberCount: 1,
        });
        return pgText;
      },
    };
    expect(
      await retainedSolverReportDownload(archivedDb, reference, {
        archiveReader,
      }),
    ).toEqual(exactDownload);
    for (const changed of [
      { ...archived, inventory_signature: "0".repeat(64) },
      // A source inventory produced by rounding the point's big integer must
      // never authenticate the exact download, even if its blob hash matches.
      {
        ...archived,
        inventory_signature: roundedInventory,
      },
      { ...archived, archive_report_sha256: "0".repeat(64) },
      { ...archived, archive_report_byte_size: member.byteSize + 1 },
      { ...archived, source_count: inventory.sources.length + 1 },
      { ...archived, assignment_signature: "0".repeat(64) },
    ])
      await expect(
        retainedSolverReportDownload(
          { execute: async () => [changed] } as unknown as DB,
          reference,
          { archiveReader: { read: async () => pgText } },
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      retainedSolverReportDownload(archivedDb, reference, {
        archiveReader: {
          read: async () => pgText.replace("123456789", "123456788"),
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
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
