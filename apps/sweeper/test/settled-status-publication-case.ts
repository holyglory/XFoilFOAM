import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { createClient, type DB } from "@aerodb/db/client";
import {
  installProgressiveReportArchiveReader,
  readProgressiveReport,
} from "@aerodb/db/progressive-report-reader";
import { storeProgressiveRemoteReport } from "@aerodb/db/progressive-remote-reports";
import { compactSettledStatusHeader } from "../src/settled-report-status-headers";
import { archiveProgressiveReportBatch } from "../src/progressive-report-archive-service";
import { ProgressiveReportArchiveStore } from "../src/progressive-report-archive-store";
import {
  withArchiveFixture,
  type ArchiveFixture,
} from "./progressive-report-archive-fixture";
import { startReportObjectServer } from "./shared-report-gcs-server";

export async function verifyStatusHeaderPublication() {
  const client = createClient({ max: 2 }),
    publisher = createClient({ max: 1 });
  const emulator = await startReportObjectServer(),
    previous = process.env.STORAGE_EMULATOR_HOST;
  process.env.STORAGE_EMULATOR_HOST = emulator.url;
  try {
    const [database] = await client.sql`SELECT current_database() AS name`;
    expect(database.name).toBe("shared_report_service");
    const store = new ProgressiveReportArchiveStore("shared-fixture");
    installProgressiveReportArchiveReader(store);
    let seeded: ArchiveFixture | undefined;
    await withArchiveFixture(
      client,
      "remote",
      async (f) => {
        seeded = f;
      },
      {
        serviceAcceptance: "ordinary",
        reportCount: 3,
        nullPrefix: 1,
        quietStatusPrefix: 1,
      },
    );
    const f = seeded!;
    expect(
      await archiveProgressiveReportBatch(
        client.db,
        "remote",
        f.executionId,
        store.putFile.bind(store),
      ),
    ).toBe(3);
    const first = f.reports[0]!,
      report = JSON.parse(first.text);
    const input = {
      executionId: f.executionId,
      solverId: report.solverId as string,
      promiseId: f.promiseId,
      report,
    };
    const [prior] =
      await client.sql`SELECT archive_bundle_id::text AS bundle,report::text AS header FROM progressive_remote_reports
      WHERE sim_job_id=${f.executionId} AND sequence=${first.sequence}`;
    const key = {
      job: f.executionId,
      sequence: first.sequence,
      signature: first.contentSignature,
      bundle: String(prior.bundle),
    };
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>((r) => {
        locked = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const publication = publisher.db.transaction(async (tx) => {
      const [d] =
        await tx.execute(sql`SELECT sim_job_id FROM progressive_remote_dispatches
        WHERE sim_job_id=${f.executionId}::uuid FOR UPDATE`);
      expect(d).toBeDefined();
      locked();
      await gate;
      return storeProgressiveRemoteReport(tx as unknown as DB, input);
    });
    try {
      await Promise.race([
        acquired,
        publication.then(() => {
          throw new Error("Publisher ended before the gate");
        }),
      ]);
      expect(
        await compactSettledStatusHeader(client.db, "remote", key),
      ).toBeNull();
      const [held] =
        await client.sql`SELECT report::text AS header FROM progressive_remote_reports
        WHERE sim_job_id=${f.executionId} AND sequence=${first.sequence}`;
      expect(held.header).toBe(prior.header);
    } finally {
      release();
    }
    expect(await publication).toMatchObject({ replayed: true });
    expect(
      await compactSettledStatusHeader(client.db, "remote", key),
    ).toBeGreaterThan(0);
    expect(
      await storeProgressiveRemoteReport(publisher.db, input),
    ).toMatchObject({ replayed: true });
    const changed = {
      ...report,
      status: { ...report.status, message: randomUUID() },
    };
    await expect(
      storeProgressiveRemoteReport(publisher.db, { ...input, report: changed }),
    ).rejects.toThrow();
    expect(
      await readProgressiveReport(client.db, {
        sourceKind: "remote",
        executionId: key.job,
        sequence: key.sequence,
        contentSignature: key.signature,
      }),
    ).toEqual(report);
    const [count] =
      await client.sql`SELECT count(*)::int AS n FROM progressive_remote_reports WHERE sim_job_id=${f.executionId}`;
    expect(count.n).toBe(3);
    expect(
      await compactSettledStatusHeader(client.db, "remote", key),
    ).toBeNull();
  } finally {
    installProgressiveReportArchiveReader(null);
    if (previous === undefined) delete process.env.STORAGE_EMULATOR_HOST;
    else process.env.STORAGE_EMULATOR_HOST = previous;
    await Promise.all([
      client.sql.end(),
      publisher.sql.end(),
      emulator.close(),
    ]);
  }
}
