import {
  createClient,
  DEFAULT_DATABASE_URL,
  solverExecutionPools,
  solverImplementations,
  type DB,
} from "@aerodb/db";
import { EngineClient } from "@aerodb/engine-client";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const ORIGINAL_ENV = { ...process.env };
const MIGRATIONS = resolve(
  fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)),
);
const dbName = `api_pool_admission_${process.pid}_${Date.now().toString(36)}`;
let db: DB;
let buildServer: (typeof import("../src/server"))["buildServer"];
let closeDatabasePools: (typeof import("../src/db"))["closeDatabasePools"];
let admin: ReturnType<typeof createClient>;

beforeAll(async () => {
  // Run against a fresh, fully migrated database. The developer's shared
  // API-test DB may intentionally lag while migration tests exercise upgrade
  // paths; this regression must not mutate or depend on that shared state.
  const adminUrl = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  admin = createClient({ url: adminUrl.toString(), max: 1 });
  await admin.sql.unsafe(`CREATE DATABASE "${dbName}"`);
  const isolatedUrl = new URL(adminUrl);
  isolatedUrl.pathname = `/${dbName}`;
  const migrationClient = createClient({ url: isolatedUrl.toString(), max: 1 });
  try {
    await migrate(migrationClient.db, { migrationsFolder: MIGRATIONS });
  } finally {
    await migrationClient.sql.end();
  }
  process.env.DATABASE_URL = isolatedUrl.toString();
  ({ db, closeDatabasePools } = await import("../src/db"));
  ({ buildServer } = await import("../src/server"));
}, 120_000);

afterAll(async () => {
  if (closeDatabasePools) await closeDatabasePools();
  if (admin) {
    await admin.sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${dbName}`;
    await admin.sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.sql.end();
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("solver execution-pool live admission", () => {
  it("disables an already-enabled pool when its enable handshake fails", async () => {
    process.env.ADMIN_AUTH_DISABLED = "true";
    const suffix = `${process.pid}-${Date.now().toString(36)}`;
    const [implementation] = await db
      .insert(solverImplementations)
      .values({
        key: `test:pool-admission:${suffix}`,
        family: "test-openfoam",
        distribution: `test-${suffix}`,
        releaseVersion: "2606",
        methodFamily: "rans-urans",
        adapterContractVersion: 1,
        numericsRevision: "1",
      })
      .returning({ id: solverImplementations.id });
    const [pool] = await db
      .insert(solverExecutionPools)
      .values({
        slug: `test-pool-admission-${suffix}`,
        name: "Test already-enabled execution pool",
        solverImplementationId: implementation.id,
        routingKey: `test-pool-admission-${suffix}`,
        enabled: true,
      })
      .returning({ id: solverExecutionPools.id });

    const capabilitySpy = vi
      .spyOn(EngineClient.prototype, "capabilities")
      .mockRejectedValue(new Error("capability probe timed out"));
    const queueSpy = vi
      .spyOn(EngineClient.prototype, "getQueue")
      .mockRejectedValue(new Error("queue probe timed out"));
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/admin/solver-execution-pools/${pool.id}`,
        payload: { enabled: true },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: expect.stringContaining("execution pool has been disabled"),
      });
      expect(queueSpy).toHaveBeenCalledWith({ timeoutMs: 15_000 });
      const [persisted] = await db
        .select({ enabled: solverExecutionPools.enabled })
        .from(solverExecutionPools)
        .where(eq(solverExecutionPools.id, pool.id));
      expect(persisted).toEqual({ enabled: false });
    } finally {
      capabilitySpy.mockRestore();
      queueSpy.mockRestore();
      await app.close();
      await db
        .delete(solverExecutionPools)
        .where(eq(solverExecutionPools.id, pool.id));
      await db
        .delete(solverImplementations)
        .where(eq(solverImplementations.id, implementation.id));
    }
  });
});
