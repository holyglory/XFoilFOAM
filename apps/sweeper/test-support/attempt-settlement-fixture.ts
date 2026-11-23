import type { PolarPoint } from "@aerodb/engine-client";
import { PgDialect } from "drizzle-orm/pg-core";
import { CRC32C, type File, type Storage } from "@google-cloud/storage";
import { createClient, type DB } from "@aerodb/db/client";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { AttemptEvidenceStore } from "../src/attempt-evidence-store";
import { archiveAttemptEvidence } from "../src/attempt-evidence-service";

/** Only object transport is doubled. Upload/readback use the production codec,
 * store, exact generation interceptor and full SQL source/catalog guards. */
interface FixtureObject {
  interceptors: File["interceptors"];
  getMetadata(): Promise<Record<string, any>[]>;
  createReadStream(options: {
    validation: string;
    decompress: boolean;
  }): Readable;
}
interface FixtureBucket {
  upload(path: string, options: Record<string, any>): Promise<void>;
  file(key: string, options?: { generation: string }): FixtureObject;
}

export class SettlementGcs {
  readonly objects = new Map<
    string,
    { bytes: Buffer; metadata: Record<string, any> }
  >();
  readonly pinned: string[] = [];
  failReads = false;
  lateError = false;
  uploads = 0;
  bucket(bucket: string): FixtureBucket {
    return {
      upload: async (path: string, options: Record<string, any>) => {
        if (
          options.preconditionOpts?.ifGenerationMatch !== 0 ||
          options.validation !== "crc32c"
        )
          throw new Error(
            "Archive fixture requires a create-only CRC-verified upload",
          );
        const key = `${bucket}/${options.destination}`;
        if (this.objects.has(key))
          throw Object.assign(new Error("exists"), { code: 412 });
        const bytes = await readFile(path),
          crc = new CRC32C();
        crc.update(bytes);
        this.uploads++;
        this.objects.set(key, {
          bytes,
          metadata: {
            ...options.metadata,
            generation: "18446744073709551615",
            size: String(bytes.length),
            crc32c: crc.toString(),
          },
        });
      },
      file: (key: string, options?: { generation: string }) => {
        const interceptors: File["interceptors"] = [];
        const get = () => {
          let request: Parameters<File["interceptors"][number]["request"]>[0] =
            {
              uri: "https://fixture.invalid/object",
              qs: options ? { generation: Number(options.generation) } : {},
            };
          for (const interceptor of interceptors)
            request = interceptor.request(request);
          const entry = this.objects.get(`${bucket}/${key}`);
          if (
            !entry ||
            (options && request.qs.generation !== entry.metadata.generation)
          )
            throw new Error("Archive fixture exact generation is missing");
          if (options) this.pinned.push(String(request.qs.generation));
          return entry;
        };
        return {
          interceptors,
          getMetadata: async () => [get().metadata],
          createReadStream: (readOptions: {
            validation: string;
            decompress: boolean;
          }) => {
            if (
              readOptions.validation !== "crc32c" ||
              readOptions.decompress !== false
            )
              throw new Error(
                "Archive fixture requires compressed-byte validation",
              );
            const entry = get(),
              fail = this.failReads,
              late = this.lateError;
            return Readable.from(
              (async function* () {
                yield fail ? Buffer.from("corrupt") : entry.bytes;
                if (late) throw new Error("fixture late GCS error");
              })(),
            );
          },
        };
      },
    };
  }
}

// Derive real dependency table shapes from the migrated product schema. These
// copies have no FK to public application rows. Functions and triggers are
// installed in this new schema, so no temp shadowing/cached public plans apply.
const dependencies = [
  "airfoils",
  "results",
  "sim_jobs",
  "result_attempts",
  "result_media",
  "result_classifications",
  "progressive_remote_dispatches",
  "progressive_cfd_attempts",
  "progressive_cfd_evidence",
  "progressive_cfd_units",
  "progressive_work",
  "progressive_generations",
  "polar_analysis_targets",
  "progressive_cfd_evidence_reuses",
  "progressive_cfd_budget_extensions",
  "progressive_cfd_recovery_plans",
  "progressive_polar_model_evidence",
  "progressive_remote_evidence_receipts",
  "progressive_worker_evidence_attempts",
  "sim_campaign_points",
  "sim_precalc_obligations",
  "sim_precalc_obligation_attempts",
  "sim_urans_verify_queue",
  "sim_urans_requests",
  "sim_rans_polar_promotions",
  "point_correction_runs",
  "sim_solver_incidents",
  "result_interpretations",
  "result_canonical_selections",
  "result_interpretation_backfill_items",
  "result_interpretation_recovery_actions",
  "legacy_urans_archive_gap_recovery_actions",
  "result_media_repairs",
  "sync_sweep_promise_points",
  "sync_remote_result_deliveries",
  "sync_remote_hub_binding_receipts",
  "sync_brokered_evidence_uploads",
];

export async function createSettlementFixture(workerCustody = false) {
  const client = createClient({ max: 1 });
  const namespace = `attempt_settle_${randomUUID().replaceAll("-", "")}`;
  const db = client.db;
  await db.execute(sql`CREATE SCHEMA ${sql.identifier(namespace)}`);
  try {
    await db.execute(sql`SET search_path=${sql.identifier(namespace)},public`);
    const workerTables = workerCustody
      ? [
          "sync_api_settings",
          "sync_sweep_promises",
          "registered_remote_solvers",
          "progressive_worker_hub_receipts",
          "progressive_worker_submission_intents",
          "progressive_worker_evidence_receipts",
          "progressive_worker_evidence_delivery_claims",
          "progressive_worker_delivery_failures",
          "progressive_worker_reports",
          "progressive_worker_report_conflicts",
          "progressive_report_archive_bundles",
          "progressive_report_archive_members",
        ]
      : [];
    for (const table of [...dependencies, ...workerTables])
      await db.execute(
        sql`CREATE TABLE ${sql.identifier(table)} AS SELECT * FROM public.${sql.identifier(table)} WITH NO DATA`,
      );
    await db.execute(sql`ALTER TABLE result_attempts DROP COLUMN IF EXISTS evidence_archive_id, DROP COLUMN IF EXISTS evidence_storage_event_id,
      ADD PRIMARY KEY(id), ADD UNIQUE(id,result_id)`);
    await db.execute(sql`ALTER TABLE results ADD PRIMARY KEY(id)`);
    await db.execute(sql`ALTER TABLE sim_jobs ADD PRIMARY KEY(id)`);
    for (const file of [
      "0207_attempt_evidence_archives.sql",
      "0208_attempt_history_readthrough.sql",
      ...(workerCustody
        ? [
            "0210_stopped_progressive_attempt_history.sql",
            "0211_progressive_attempt_receipt_sources.sql",
            "0212_hz_attempt_history_custody.sql",
            "0213_urans_attempt_history.sql",
            "0214_verified_attempt_history_policy.sql",
            "0215_verified_attempt_active_role.sql",
            "0216_hz_retained_original_attempts.sql",
            "0224_hz_settled_attempt_receipts.sql",
          ]
        : []),
    ]) {
      const body = await readFile(
        new URL(`../../../packages/db/migrations/${file}`, import.meta.url),
        "utf8",
      );
      for (const statement of body
        .split("--> statement-breakpoint")
        .filter((part) => part.trim()))
        await db.execute(sql.raw(statement));
    }
    return {
      client,
      db,
      namespace,
      async reset() {
        const tables = await db.execute(
          sql`SELECT tablename FROM pg_tables WHERE schemaname=${namespace}`,
        );
        await db.execute(
          sql`TRUNCATE TABLE ${sql.join(
            tables.map(
              (row) =>
                sql`${sql.identifier(namespace)}.${sql.identifier(String(row.tablename))}`,
            ),
            sql`, `,
          )} CASCADE`,
        );
        await db.execute(
          sql`INSERT INTO attempt_evidence_storage_policy(id) VALUES(1)`,
        );
      },
      async close() {
        try {
          await db.execute(
            sql`DROP SCHEMA ${sql.identifier(namespace)} CASCADE`,
          );
        } finally {
          await client.sql.end();
        }
      },
    };
  } catch (error) {
    try {
      await db.execute(sql`DROP SCHEMA ${sql.identifier(namespace)} CASCADE`);
    } finally {
      await client.sql.end();
    }
    throw error;
  }
}

function settledRansPayload(compressible = false) {
  const count = 1600;
  const values = Array.from({ length: count }, (_, i) =>
    compressible ? 0 : Number((Math.sin(i * 0.143) / 100 + 0.6).toFixed(12)),
  );
  const history = {
    iterations: Array.from({ length: count }, (_, i) => (compressible ? 0 : i)),
    cl: values,
    cd: values.map((v) => (compressible ? 0 : Number((v / 40).toFixed(12)))),
    cm: values.map((v) => (compressible ? 0 : Number((-v / 20).toFixed(12)))),
    window: { start_iter: 0, end_iter: count - 1 },
    mean_stable: true,
    note: "measured stable history fixture",
  };
  return JSON.stringify({
    fidelity: "rans",
    mesh_recovery_version: 1,
    aoa_deg: 0,
    cl: 0.6,
    cd: 0.015,
    cm: -0.03,
    unsteady: false,
    converged: true,
    first_order_fallback: false,
    steady_history: history,
    evidence_artifacts: [
      {
        kind: "manifest",
        path: "case/evidence.json",
        sha256: "a".repeat(64),
        byte_size: 7,
      },
    ],
    certificate: { source: "preserved" },
    diagnostic: "EXACT_WIDE_NUMBER",
  }).replace('"EXACT_WIDE_NUMBER"', "9007199254740993123456789");
}

interface SettledHistoryOptions {
  id?: string;
  compressible?: boolean;
  uransPoint?: PolarPoint;
}

export async function seedInlineSettledHistory(
  db: DB,
  options: SettledHistoryOptions = {},
) {
  const attemptId = options.id ?? randomUUID(),
    resultId = randomUUID(),
    jobId = randomUUID(),
    airfoilId = randomUUID(),
    revisionId = randomUUID();
  const point = options.uransPoint;
  const payload = point
    ? JSON.stringify({ ...point, mesh_recovery_version: 3 })
    : settledRansPayload(options.compressible);
  await db.execute(sql`INSERT INTO airfoils(id,points) VALUES(${airfoilId}::uuid,
    '[{"x":1,"y":0.001},{"x":0,"y":0},{"x":1,"y":-0.001}]'::jsonb)`);
  await db.execute(sql`INSERT INTO sim_jobs(id,status,"ingestedAt",engine_state,request_payload,airfoil_id,simulation_preset_revision_id)
    VALUES(${jobId}::uuid,'done',clock_timestamp(),'completed','{}'::jsonb,${airfoilId}::uuid,${revisionId}::uuid)`);
  await db.execute(sql`INSERT INTO results(id,current_result_attempt_id,airfoil_id,simulation_preset_revision_id,cl,cd)
    VALUES(${resultId}::uuid,NULL,${airfoilId}::uuid,${revisionId}::uuid,${point ? point.cl : 0.6},${point ? point.cd : 0.015})`);
  await db.execute(sql`INSERT INTO result_attempts(id,result_id,sim_job_id,airfoil_id,bc_id,simulation_preset_revision_id,
    aoa_deg,status,source,regime,valid_for_polar,unsteady,converged,stalled,first_order_fallback,engine_job_id,
    evidence_payload,cl,cd,cm,"createdAt","solvedAt") VALUES(${attemptId}::uuid,${resultId}::uuid,${jobId}::uuid,
    ${airfoilId}::uuid,${randomUUID()}::uuid,${revisionId}::uuid,${point?.aoa_deg ?? 0},'done','solved',${point ? "urans" : "rans"},
    ${!point},${Boolean(point)},${point ? point.converged : true},false,false,
    ${`local:${jobId}`},${payload}::jsonb,${point ? point.cl : 0.6},${point ? point.cd : 0.015},${point ? point.cm : -0.03},clock_timestamp(),clock_timestamp())`);
  return { attemptId, resultId, jobId, airfoilId, revisionId };
}

export async function seedSettledHistory(
  db: DB,
  options: SettledHistoryOptions & { memory?: SettlementGcs } = {},
) {
  const source = await seedInlineSettledHistory(db, options);
  const memory = options.memory ?? new SettlementGcs(),
    store = new AttemptEvidenceStore(memory as unknown as Storage);
  const result = await archiveAttemptEvidence(db, store, {
    attemptId: source.attemptId,
    bucket: "fixture",
    sourceInstance: "hub",
  });
  return {
    ...source,
    archive: result.archive,
    memory,
    store,
  };
}

export function interruptBeforeReadback(db: DB) {
  const dialect = new PgDialect();
  return new Proxy(db, {
    get(target, key) {
      if (key !== "execute") return Reflect.get(target, key, target);
      return (query: Parameters<DB["execute"]>[0]) => {
        const statement =
          typeof query === "string"
            ? query
            : dialect.sqlToQuery(query.getSQL()).sql;
        if (statement.includes("SET app_readback_at=clock_timestamp()"))
          throw new Error("process stopped before confirming visible read");
        return target.execute(query);
      };
    },
  });
}
