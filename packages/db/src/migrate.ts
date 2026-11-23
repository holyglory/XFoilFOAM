import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createClient } from "./client";
import { prepareMigrationSession } from "./migration-session";
import { prepareSolverEvidenceOwnerIndexes } from "./solver-evidence-owner-indexes";
import { preparePreciseCandidateIndex } from "./online-partial-indexes";
import { prepareReportPayloadReferenceIndexes } from "./report-payload-reference-indexes";

const here = dirname(fileURLToPath(import.meta.url));
const { db, sql } = createClient({ max: 1 });
const config = { migrationsFolder: resolve(here, "../migrations") };

try {
  if (process.argv.includes("--prepare-evidence-owner-indexes")) {
    console.log(JSON.stringify(await prepareSolverEvidenceOwnerIndexes(sql)));
  } else if (process.argv.includes("--prepare-report-payload-indexes")) {
    console.log(
      JSON.stringify(await prepareReportPayloadReferenceIndexes(sql)),
    );
  } else {
    // A pre-0198 installation may already have populated reports. Commit
    // their ordinary versioned column/FK migration before concurrent DDL.
    const [legacy] = await sql`SELECT EXISTS(SELECT FROM pg_catalog.pg_class c
      WHERE c.oid IN (to_regclass('public.progressive_worker_reports'),to_regclass('public.progressive_remote_reports'))
        AND NOT EXISTS(SELECT FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid
          AND a.attname='result_payload_hash' AND NOT a.attisdropped)) AS missing_columns`;
    if (legacy.missing_columns) {
      await prepareMigrationSession(sql);
      const through0198 = readMigrationFiles(config).filter(
        (m) => m.folderMillis <= 1794902400000,
      );
      await new PgDialect().migrate(through0198, db._.session, config);
    }
    await prepareSolverEvidenceOwnerIndexes(sql);
    await prepareReportPayloadReferenceIndexes(sql);
    await preparePreciseCandidateIndex(sql);
    await prepareMigrationSession(sql);
    await migrate(db, config);
    console.log("✓ migrations applied");
  }
} finally {
  await sql.end();
}
