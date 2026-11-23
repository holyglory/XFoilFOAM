import { createClient } from "@aerodb/db/client";
import { storeProgressiveRemoteReport } from "@aerodb/db/progressive-remote-reports";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ArchiveFixture } from "./progressive-report-archive-fixture";

export function stagingFixtureUrl() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.WORKER_STAGING_KEYS_ACCEPTANCE !== "1" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    ["5432", "5544"].includes(url.port) ||
    !/^\/[a-zA-Z0-9_]+$/.test(url.pathname)
  )
    throw new Error("Expected an isolated staging-key PostgreSQL database");
  return url;
}

export async function createStagingFixtureWorker() {
  const source = stagingFixtureUrl();
  const adminUrl = new URL(source);
  adminUrl.pathname = "/postgres";
  const admin = createClient({ url: adminUrl.toString(), max: 1 });
  const name = "staging_key_worker_" + randomUUID().replaceAll("-", "");
  const url = new URL(source);
  url.pathname = "/" + name;
  let made = false;
  async function close() {
    try {
      if (made) await admin.sql`DROP DATABASE ${admin.sql(name)}`;
    } finally {
      await admin.sql.end();
    }
  }
  try {
    await admin.sql`CREATE DATABASE ${admin.sql(name)}`;
    made = true;
    const cwd = fileURLToPath(
      new URL("../../../packages/db/", import.meta.url),
    );
    for (const file of ["src/migrate.ts", "seed/index.ts"])
      execFileSync(process.execPath, ["--import", "tsx", file], {
        cwd,
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 120_000,
      });
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function cloneStagingFixtureHub(
  fixture: ArchiveFixture,
  worker: URL,
) {
  const origin = stagingFixtureUrl();
  if (
    worker.host !== origin.host ||
    !/^\/staging_key_worker_[a-f0-9]{32}$/.test(worker.pathname)
  )
    throw new Error("Expected the isolated snapshot source");
  const hubName = "staging_key_hub_" + randomUUID().replaceAll("-", "");
  const adminUrl = new URL(worker);
  adminUrl.pathname = "/postgres";
  const hubUrl = new URL(worker);
  hubUrl.pathname = "/" + hubName;
  const admin = createClient({ url: adminUrl.toString(), max: 1 });
  const hub = createClient({ url: hubUrl.toString(), max: 1 });
  let created = false;
  async function close() {
    await hub.sql.end();
    try {
      if (created) await admin.sql`DROP DATABASE ${admin.sql(hubName)}`;
    } finally {
      await admin.sql.end();
    }
  }
  try {
    // The caller closes its only worker connection first. Never terminate
    // another client to obtain a template snapshot.
    await admin.sql`CREATE DATABASE ${admin.sql(hubName)} TEMPLATE ${admin.sql(worker.pathname.slice(1))}`;
    created = true;
    await hub.sql`UPDATE sync_api_settings SET instance_id=${randomUUID()},enabled=true,remote_solver_enabled=false WHERE id=1`;
    await hub.sql`INSERT INTO sync_api_permissions(data_type,can_fetch,can_push) VALUES('polars',false,true)
      ON CONFLICT(data_type) DO UPDATE SET can_push=true`;
    const [owner] =
      await hub.sql`SELECT id,request_payload->'remoteProgressiveExecution' envelope FROM sim_jobs WHERE id=${fixture.executionId}`;
    const envelope = owner.envelope;
    // The hub promise names the *worker* that owns its registered push.
    // The independent worker mirror's source base URL names the upstream hub.
    await hub.sql`UPDATE sync_sweep_promises p SET source_instance_id=s.instance_id
      FROM registered_remote_solvers s WHERE p.id=${fixture.promiseId} AND s.id=p.registered_solver_id`;
    await hub.sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
      VALUES(${fixture.executionId},${fixture.promiseId},${envelope.solverId},1,${envelope.contentSignature},${JSON.stringify(envelope)}::text::jsonb)`;
    for (const original of fixture.reports)
      await storeProgressiveRemoteReport(hub.db, {
        executionId: fixture.executionId,
        promiseId: fixture.promiseId,
        solverId: envelope.solverId,
        report: JSON.parse(original.text),
      });
    const requests: Array<{ path: string; status: number; conflicts: number }> =
      [];
    const send: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      const apiDir = fileURLToPath(new URL("../../api/", import.meta.url));
      const raw = execFileSync(
        process.execPath,
        ["--import", "tsx", "test/staging-key-hub-request.ts"],
        {
          cwd: apiDir,
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...process.env,
            DATABASE_URL: hubUrl.toString(),
            AIRFOILFOAM_DEPLOYMENT_ROLE: "hub",
            LOG_LEVEL: "silent",
          },
          input: JSON.stringify({
            path,
            headers: Object.fromEntries(new Headers(init?.headers)),
            body: String(init?.body),
          }),
        },
      );
      const result = JSON.parse(raw);
      const payload = JSON.parse(result.body);
      requests.push({
        path,
        status: result.status,
        conflicts: payload.conflictIds?.length ?? 0,
      });
      if (result.status >= 400 && result.status !== 409)
        throw new Error(
          "Fixture hub returned " + result.status + " " + String(payload.error),
        );
      return new Response(result.body, {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    };
    return { hub, send, requests, close };
  } catch (error) {
    await close();
    throw error;
  }
}
