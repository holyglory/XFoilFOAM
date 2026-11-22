import {
  airfoils,
  analysisContentHash,
  createClient,
  registeredRemoteSolvers,
  resultAttempts,
  results,
  sealProgressiveRemoteExecution,
  simJobs,
  syncSweepPromises,
  type DB,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import { OPENCFD_2606_ENGINE } from "@aerodb/engine-client";
import {
  canonicalReportJson,
  parseReportJson,
} from "@aerodb/db/progressive-report-archive";
import { progressiveRemoteReportInventory } from "@aerodb/db/progressive-remote-inventory";
import { setProgressiveReportNormalization } from "@aerodb/db/progressive-report-payloads";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { createMinimalSolverFixture } from "../../../packages/db/test/solver-fixture";

export type ArchiveSource = "remote" | "worker";
export const archiveTable = (source: ArchiveSource) =>
  sql.identifier(
    source === "remote"
      ? "progressive_remote_reports"
      : "progressive_worker_reports",
  );
export const archiveSha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const LARGE_REPORT_INTEGER = "90071992547409931234567890123456789";

export interface ArchiveFixture {
  db: DB;
  source: ArchiveSource;
  executionId: string;
  promiseId: string;
  attemptId: string;
  reports: {
    sequence: number;
    contentSignature: string;
    text: string;
    payloadHash: string | null;
  }[];
}

/** Reuse the exact setup fixture, with real migrated report tables/triggers.
 * Everything, including singleton normalization and immutable archives, rolls
 * back; deleting immutable rows is deliberately not part of fixture cleanup. */
export async function withArchiveFixture(
  client: ReturnType<typeof createClient>,
  source: ArchiveSource,
  run: (fixture: ArchiveFixture) => Promise<void>,
  options: {
    normalized?: boolean;
    stopped?: boolean;
    settled?: boolean;
    reportCount?: number;
    angles?: number[];
    historyRepeats?: number;
    legacyConflict?: "identical" | "distinct";
  } = {},
) {
  const rollback = new Error(
    "Rollback disposable progressive report archive fixture",
  );
  try {
    await client.db.transaction(async (transaction) => {
      const db = transaction as unknown as DB;
      await setProgressiveReportNormalization(db, {
        enabled: options.normalized ?? true,
        readersReady: true,
      });
      const executionId = randomUUID();
      const solver = await createMinimalSolverFixture(
        db,
        `report-archive-${executionId}`,
      );
      const [airfoil] = await db
        .select({ id: airfoils.id, slug: airfoils.slug })
        .from(airfoils)
        .limit(1);
      if (!airfoil)
        throw new Error(
          "Archive regression requires the graph's seeded airfoil catalog",
        );
      const [epoch] =
        await db.execute(sql`INSERT INTO calculation_epochs (current,reason)
        VALUES (false,'disposable report archive regression') RETURNING id`);
      const [remote] = await db
        .insert(registeredRemoteSolvers)
        .values({
          instanceId: `archive-${executionId}`,
          instanceName: "Disposable archive fixture",
        })
        .returning();
      const promiseId = randomUUID();
      const units = (options.angles ?? [0]).map((alpha) => ({
        unitId: randomUUID(),
        token: randomUUID(),
        alpha,
        activeBudgetSeconds: 900,
      }));
      const envelope = sealProgressiveRemoteExecution({
        solverId: remote.id,
        promiseId,
        scope: {
          executionContract: "progressive-cfd-v1",
          executionId,
          epochId: String(epoch.id),
          generationId: randomUUID(),
          targetId: "a".repeat(64),
          recipeId: "b".repeat(64),
          stage: 2,
          tokens: units.map((u) => u.token),
          units,
        },
        request: {
          execution_id: executionId,
          expected_engine: { ...OPENCFD_2606_ENGINE },
          expected_execution_pool: "archive-fixture",
          expected_solver_budget_version: 2,
          expected_mesh_recovery_version: 1,
          airfoil: { name: airfoil.slug },
          chord_lengths: [0.987654],
          speeds: [19.876543],
          aoa: { angles: units.map((u) => u.alpha) },
          solver: { warm_start: true },
          resources: { case_concurrency: 1, case_solver_budget_seconds: 900 },
        },
      });
      await db.insert(syncSweepPromises).values({
        id: promiseId,
        registeredSolverId: remote.id,
        airfoilId: airfoil.id,
        simulationPresetRevisionId: solver.revisionId,
        aoaCount: units.length,
        status: "expired",
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        requestPayload: { ...envelope },
      });
      // Hub ownership comes only from its dispatch. Worker ownership comes only
      // from its local mirror payload; neither fixture has the other's identity.
      await db.insert(simJobs).values({
        id: executionId,
        engineJobId: executionId,
        airfoilId: airfoil.id,
        bcIds: [solver.bcId],
        simulationPresetRevisionId: solver.revisionId,
        referenceChordM: 0.987654,
        status: "failed",
        engineState: "failed",
        totalCases: units.length,
        completedCases: 1,
        ingestedAt: new Date(),
        requestPayload:
          source === "remote"
            ? { progressive: { epochId: epoch.id } }
            : {
                remoteSolver: true,
                syncPromiseId: promiseId,
                remoteProgressiveExecution: envelope,
              },
      });
      if (source === "remote")
        await db.execute(sql`INSERT INTO progressive_remote_dispatches
        (sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
        VALUES (${executionId}::uuid,${promiseId}::uuid,${remote.id}::uuid,1,
          ${envelope.contentSignature},${JSON.stringify(envelope)}::jsonb)`);

      // Retain an actual rejected attempt and its result projection, so an
      // archive cannot appear correct merely because the result tables are empty.
      const [result] = await db
        .insert(results)
        .values({
          airfoilId: airfoil.id,
          bcId: solver.bcId,
          simulationPresetRevisionId: solver.revisionId,
          aoaDeg: 0,
          simJobId: executionId,
          engineJobId: executionId,
          engineCaseSlug: "archive-case",
          status: "failed",
          source: "solved",
          regime: "rans",
          converged: false,
        })
        .returning();
      const [attempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: result.id,
          airfoilId: airfoil.id,
          bcId: solver.bcId,
          simulationPresetRevisionId: solver.revisionId,
          aoaDeg: 0,
          simJobId: executionId,
          engineJobId: executionId,
          engineCaseSlug: "archive-case",
          status: "failed",
          source: "solved",
          regime: "rans",
          validForPolar: false,
          converged: false,
          error: "retained archive regression diagnostic",
        })
        .returning();
      const proof = {
        version: 1,
        job_id: executionId,
        execution_stopped: true,
        producer_stopped: true,
        namespace_verified: true,
        remaining: [],
        observed_at: "2026-11-10T13:00:00Z",
        error: null,
        fence: "terminal_result",
        ownership_basis: "recorded_execution_namespace",
      };
      if (options.stopped !== false)
        await db.execute(sql`INSERT INTO progressive_cfd_execution_stops
        (sim_job_id,engine_job_id,epoch_id,proof,proof_signature,observed_at)
        VALUES (${executionId}::uuid,${executionId},${epoch.id}::uuid,${JSON.stringify(proof)}::jsonb,
          ${analysisContentHash(proof)},${proof.observed_at}::timestamptz)`);

      const fixture: ArchiveFixture = {
        db,
        source,
        executionId,
        promiseId,
        attemptId: attempt.id,
        reports: [],
      };
      const count = options.reportCount ?? 3;
      for (let sequence = 1; sequence <= count; sequence++) {
        const report = {
          version: 1,
          solverId: remote.id,
          promiseId,
          executionId,
          assignmentSignature: envelope.contentSignature,
          sequence,
          status: {
            job_id: executionId,
            state: sequence === count ? "failed" : "running",
            total_cases: units.length,
            completed_cases: sequence === 1 ? 0 : 1,
            // Unknown diagnostic values must survive archival without JS rounding.
            diagnosticLargeInteger: "__LARGE_INTEGER__",
            diagnosticNull: null,
            message: [
              "archive diagnostic: λ 🌬️",
              'quote "',
              String.fromCharCode(92),
            ].join(String.fromCharCode(10)),
          },
          result:
            sequence === 1
              ? null
              : {
                  job_id: executionId,
                  state: sequence === count ? "failed" : "running",
                  polars: [
                    {
                      chord: 0.987654,
                      speed: 19.876543,
                      reynolds: 1_234_567,
                      points: [],
                      attempts: [
                        {
                          aoa_deg: 0,
                          case_slug: "archive-case",
                          cl: null,
                          cd: null,
                          cm: null,
                          converged: false,
                          unsteady: false,
                          first_order_fallback: false,
                          images: {},
                          error: "repeated immutable history λ🌬️".repeat(
                            options.historyRepeats ?? 512,
                          ),
                        },
                      ],
                    },
                  ],
                },
          stopProof:
            sequence === count && options.stopped !== false ? proof : null,
        };
        const inputText = JSON.stringify(report).replace(
          '"__LARGE_INTEGER__"',
          LARGE_REPORT_INTEGER,
        );
        const contentSignature = archiveSha256(
          canonicalReportJson(parseReportJson(inputText)),
        );
        if (source === "worker" && sequence === 2 && options.legacyConflict) {
          // Insert before its source exists, as an old outbox conflict would
          // have been stored before migration 0203. No trigger is disabled.
          const conflictText =
            options.legacyConflict === "identical"
              ? sql`${inputText}::jsonb`
              : sql`${inputText}::jsonb||'{"distinctLegacyBody":null}'::jsonb`;
          await db.execute(sql`INSERT INTO progressive_worker_report_conflicts
            (sim_job_id,sequence,content_signature,report,reason)
            VALUES (${executionId}::uuid,${sequence},${contentSignature},${conflictText},'retained legacy conflict reason')`);
        }
        await db.execute(sql`INSERT INTO ${archiveTable(source)} (sim_job_id,sequence,content_signature,report)
          VALUES (${executionId}::uuid,${sequence},${contentSignature},${inputText}::jsonb)`);
        if (source === "remote" && options.settled !== false) {
          const inventory = progressiveRemoteReportInventory(
            report as unknown as ProgressiveRemoteReport,
          );
          await db.execute(sql`INSERT INTO progressive_remote_report_inventories
            (sim_job_id,sequence,report_content_signature,inventory_signature,source_count)
            VALUES (${executionId}::uuid,${sequence},${contentSignature},${analysisContentHash(
              {
                kind: "progressive-remote-report-inventory-v1",
                executionId,
                sequence,
                reportContentSignature: contentSignature,
                sources: inventory.sources,
              },
            )},${inventory.sources.length})`);
          for (const point of inventory.sources) {
            await db.execute(sql`INSERT INTO progressive_remote_report_sources
              (sim_job_id,sequence,point_content_signature,aoa_deg,case_slug)
              VALUES (${executionId}::uuid,${sequence},${point.point_content_signature},${point.aoa_deg},${point.case_slug})`);
            await db.execute(sql`INSERT INTO progressive_remote_diagnostic_receipts
              (sim_job_id,sequence,point_content_signature,receipt)
              VALUES (${executionId}::uuid,${sequence},${point.point_content_signature},'{"kind":"retained-progressive-diagnostic"}'::jsonb)
              ON CONFLICT DO NOTHING`);
          }
          await db.execute(sql`INSERT INTO progressive_remote_progress_receipts (sim_job_id,sequence,content_signature)
            VALUES (${executionId}::uuid,${sequence},${contentSignature})`);
        } else if (source === "worker" && options.settled !== false) {
          await db.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp()
            WHERE sim_job_id=${executionId}::uuid AND sequence=${sequence}`);
          await db.execute(sql`INSERT INTO progressive_worker_evidence_receipts (sim_job_id,sequence,content_signature)
            VALUES (${executionId}::uuid,${sequence},${contentSignature})`);
        }
        const [stored] =
          await db.execute(sql`SELECT public.resolve_progressive_report(report,result_payload_hash)::text AS text,
          result_payload_hash FROM ${archiveTable(source)} WHERE sim_job_id=${executionId}::uuid AND sequence=${sequence}`);
        fixture.reports.push({
          sequence,
          contentSignature,
          text: String(stored.text),
          payloadHash:
            stored.result_payload_hash == null
              ? null
              : String(stored.result_payload_hash),
        });
      }
      await run(fixture);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

export async function archiveSnapshot({
  db,
  executionId,
  promiseId,
  reports,
}: ArchiveFixture) {
  const snapshot: Record<string, unknown> = {};
  for (const table of [
    "sim_jobs",
    "results",
    "result_attempts",
    "progressive_remote_reports",
    "progressive_worker_reports",
    "progressive_remote_report_inventories",
    "progressive_remote_report_sources",
    "progressive_remote_progress_receipts",
    "progressive_remote_diagnostic_receipts",
    "progressive_worker_evidence_receipts",
    "progressive_worker_report_conflicts",
    "progressive_report_archive_bundles",
    "progressive_report_archive_members",
  ]) {
    const key = table === "sim_jobs" ? sql`id` : sql`sim_job_id`;
    snapshot[table] = [
      ...(await db.execute(sql`SELECT to_jsonb(t)::text AS row
      FROM ${sql.identifier(table)} t WHERE ${key}=${executionId}::uuid ORDER BY to_jsonb(t)::text`)),
    ];
  }
  snapshot.promise = [
    ...(await db.execute(sql`SELECT to_jsonb(p)::text AS row
    FROM sync_sweep_promises p WHERE id=${promiseId}::uuid`)),
  ];
  // Compare full payloads as text too: JSON.parse would hide the numeric defect.
  const hashes = reports.flatMap((report) =>
    report.payloadHash ? [report.payloadHash] : [],
  );
  snapshot.payloads = hashes.length
    ? [
        ...(await db.execute(sql`SELECT content_hash,result::text,byte_size
    FROM progressive_report_result_payloads
    WHERE content_hash IN (${sql.join(
      hashes.map((hash) => sql`${hash}`),
      sql`,`,
    )}) ORDER BY content_hash`)),
      ]
    : [];
  return snapshot;
}
