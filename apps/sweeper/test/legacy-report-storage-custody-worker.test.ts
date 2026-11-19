import { createHash, randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "@aerodb/db/client";
import {
  legacyNormalizeSql,
  type LegacyReportMember,
} from "@aerodb/db/legacy-report-storage";
import {
  encodeLegacyPage,
  readLegacyPageMembers,
  type LegacyBackupPage,
} from "@aerodb/db/legacy-report-storage-codec";
import {
  legacyReportCustodySql,
  verifyLegacyReportCustodyPage,
} from "@aerodb/db/legacy-report-custody";
import { withArchiveFixture } from "./progressive-report-archive-fixture";
import { legacyNormalizationTelemetry } from "../src/legacy-report-storage-migration";
import {
  applyLegacyCustodyWorkerTransaction,
  type LegacyWorkerSqlTransaction,
} from "../src/legacy-report-storage-custody-worker";

// Run in the migrated archive graph (schema + seed), not the empty-schema case.
// This is the production worker transaction with the real postgres-js driver,
// actual 0205 registration/compaction and rollback-owned fixture data.
const client = createClient({ max: 1 });
afterAll(() => client.sql.end());
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

it.each([false, true])(
  "binds the real worker driver and distinguishes report/conflict retention on replay (mixed=%s)",
  async (mixed) => {
    await withArchiveFixture(
      client,
      "worker",
      async (fixture) => {
        const instanceId = randomUUID();
        const [owner] = await fixture.db.execute(
          sql`SELECT registered_solver_id::text AS solver_id FROM sync_sweep_promises WHERE id=${fixture.promiseId}::uuid`,
        );
        const solverId = String(owner.solver_id);
        await fixture.db
          .execute(sql`UPDATE sync_api_settings SET instance_id=${instanceId}::uuid,remote_solver_registered_id=${solverId}::uuid,
      upstream_base_url='https://legacy-worker-driver.invalid/api/sync/v1' WHERE id=1`);
        await fixture.db.execute(
          sql`UPDATE sync_sweep_promises SET source_base_url='https://legacy-worker-driver.invalid/api/sync/v1' WHERE id=${fixture.promiseId}::uuid`,
        );
        await fixture.db.execute(
          sql`UPDATE sim_jobs SET request_payload=request_payload||'{"upstreamBaseUrl":"https://legacy-worker-driver.invalid/api/sync/v1"}'::jsonb WHERE id=${fixture.executionId}::uuid`,
        );
        if (mixed) {
          // Keep the fixture's exact engine-issued final report (sequence 4) last.
          // Only its earlier sequence 3 becomes unstaged and inline for this page.
          await fixture.db.execute(
            sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=false WHERE id=1`,
          );
          await fixture.db.execute(
            sql`DELETE FROM public.progressive_worker_evidence_receipts WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=3`,
          );
          await fixture.db
            .execute(sql`UPDATE public.progressive_worker_reports r SET report=public.resolve_progressive_report(to_jsonb(r.*)),result_payload_hash=NULL
        WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=3`);
          await fixture.db.execute(
            sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=true WHERE id=1`,
          );
        }
        const stored = await fixture.db
          .execute(sql`SELECT 'report' AS kind,r.sim_job_id::text AS id,r.sequence,r.content_signature,r.report->>'solverId' AS solver_id,
      to_jsonb(r.*)::text AS row_text,public.resolve_progressive_report(to_jsonb(r.*))::text AS report_text FROM progressive_worker_reports r
      WHERE sim_job_id=${fixture.executionId}::uuid
      UNION ALL SELECT 'conflict',c.sim_job_id::text,c.sequence,c.content_signature,c.report->>'solverId',to_jsonb(c.*)::text,
        public.resolve_progressive_report(v.report,v.result_payload_hash)::text FROM progressive_worker_report_conflicts c
        JOIN progressive_worker_conflict_storage v USING(sim_job_id,sequence,content_signature) WHERE c.sim_job_id=${fixture.executionId}::uuid ORDER BY sequence,kind DESC`);
        const members: LegacyReportMember[] = stored.map((row) => ({
          kind: row.kind as "report" | "conflict",
          executionId: String(row.id),
          sequence: Number(row.sequence),
          contentSignature: String(row.content_signature),
          solverId: String(row.solver_id),
          rowText: String(row.row_text),
          rowSha256: digest(String(row.row_text)),
          reportText: String(row.report_text),
          reportSha256: digest(String(row.report_text)),
          reportByteSize: Buffer.byteLength(String(row.report_text)),
        }));
        const page: LegacyBackupPage = {
          version: 1,
          sourceInstance: instanceId,
          solverId,
          scopeSha256: digest(fixture.executionId),
          members,
          start: { execution: 0, kind: "report", after: 0, copied: 0 },
          next: { execution: 1, kind: "report", after: 0, copied: 0 },
        };
        const packed = encodeLegacyPage(page).bytes;
        const object = {
          bucket: "legacy-worker-driver",
          objectKey: "",
          generation: "18446744073709551615",
          sha256: digest(packed),
          byteSize: packed.length,
          crc32c: "AAAAAA==",
          verifiedAt: new Date().toISOString(),
        };
        object.objectKey = `legacy-worker-reports/v1/${instanceId}/${solverId}/${page.scopeSha256}/${object.sha256}.jsonl.gz`;
        const proof = await verifyLegacyReportCustodyPage({
          page,
          object,
          access: {
            mode: "hub-local-reader",
            readHubObject: async () => packed,
            reader: {
              readPage: async () => ({
                storedBytes: packed,
                storageKey: `report-archives/v1/${object.sha256.slice(0, 2)}/${object.sha256}.jsonl.gz`,
                durableAt: new Date().toISOString(),
              }),
            },
          },
        });
        // Drizzle's fixture already owns the transaction. Its session client is the
        // real transaction-bound postgres-js callable, not a SQL/parameter double.
        const native = (
          fixture.db as unknown as {
            session: { client: LegacyWorkerSqlTransaction };
          }
        ).session.client;
        const input = {
          page,
          object,
          proof,
          custody: { legacyReportCustodySql },
          normalization: { legacyNormalizeSql },
          codec: { readLegacyPageMembers },
          productBytes: packed,
          verifiedMembers: members.map((member) => ({ ...member })),
        };
        const applied = await applyLegacyCustodyWorkerTransaction(
          native,
          input,
        );
        expect(applied).toMatchObject({
          verifiedReports: mixed ? 4 : 3,
          newlyNormalizedReports: mixed ? 1 : 0,
          normalizedReports: mixed ? 1 : 0,
          sourceDatabaseWrites: true,
          archiveMembersReleased: 4,
          replayMembersVerified: mixed ? 5 : 4,
          remainingWarmReports: mixed ? 1 : 0,
        });
        expect(
          legacyNormalizationTelemetry(
            { ...applied, rowProofs: [] },
            members.length,
          ),
        ).toMatchObject({
          sourceReportBodiesRetained: mixed ? 1 : 0,
          archiveMembersReleased: 4,
          reportRowsVerified: mixed ? 4 : 3,
        });
        const replay = await applyLegacyCustodyWorkerTransaction(native, input);
        expect(replay).toMatchObject({
          verifiedReports: mixed ? 4 : 3,
          newlyNormalizedReports: 0,
          normalizedReports: mixed ? 1 : 0,
          sourceDatabaseWrites: false,
          archiveMembersReleased: 0,
          replayMembersVerified: mixed ? 5 : 4,
          remainingWarmReports: mixed ? 1 : 0,
        });
        expect(
          legacyNormalizationTelemetry(
            { ...replay, rowProofs: [] },
            members.length,
          ),
        ).toMatchObject({
          sourceReportBodiesRetained: mixed ? 1 : 0,
          archiveMembersReleased: 0,
          sourceDatabaseWrites: false,
        });
        const [rows] = await fixture.db.execute(
          sql`SELECT count(*)::integer AS n FROM progressive_worker_reports WHERE sim_job_id=${fixture.executionId}::uuid AND archived_at IS NOT NULL`,
        );
        expect(rows.n).toBe(3);
      },
      { legacyConflict: "distinct", reportCount: mixed ? 4 : 3 },
    );
  },
  120000,
);
