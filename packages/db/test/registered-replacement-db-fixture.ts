import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "../src/client";
import { databaseUrl } from "../src/env";

export async function withRegisteredRoundDatabases(
  source: DB,
  run: (
    hub: ReturnType<typeof createClient>,
    worker: ReturnType<typeof createClient>,
    url: string,
    requests: { method: string; path: string; status: number }[],
  ) => Promise<void>,
) {
  const [row] = await source.execute(sql`SELECT current_database() AS name`);
  const url = new URL(databaseUrl()),
    origin = String(row!.name);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    ["5432", "5544"].includes(url.port) ||
    !/^(enrollment_|dc2_case_)[0-9a-f]{32}$/.test(origin)
  )
    throw Error("Expected the governed disposable campaign fixture database");
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = createClient({ url: adminUrl.href, max: 1 });
  const suffix = randomUUID().replaceAll("-", ""),
    hubName = "collision_hub_" + suffix,
    workerName = "collision_worker_" + suffix;
  const conn = (name: string) => {
    const u = new URL(url);
    u.pathname = "/" + name;
    return u.href;
  };
  const dir = await mkdtemp(join(tmpdir(), "registered-collision-"));
  const media = join(dir, "media");
  await mkdir(media);
  const pgEnv = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
  let hub: ReturnType<typeof createClient> | undefined,
    worker: ReturnType<typeof createClient> | undefined;
  let server: ReturnType<typeof fork> | undefined;
  let exited: Promise<unknown> | undefined;
  const copies: string[] = [];
  try {
    // The campaign's pool stays usable. Copy a consistent committed snapshot
    // without terminating another check's connections to obtain a template.
    const dump = execFileSync(
      "pg_dump",
      ["--no-owner", "--no-privileges", "--dbname", origin],
      {
        env: pgEnv,
        encoding: "utf8",
        maxBuffer: 160 * 1024 * 1024,
        timeout: 60000,
      },
    );
    await admin.sql`CREATE DATABASE ${admin.sql(hubName)}`;
    copies.push(hubName);
    // PG17 dump clients include this session setting even for a PG16 source.
    const supported = dump.replace(/^SET transaction_timeout = 0;\r?$/m, "");
    execFileSync(
      "psql",
      ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--dbname", hubName],
      {
        env: pgEnv,
        input: supported,
        stdio: ["pipe", "ignore", "pipe"],
        timeout: 90000,
      },
    );
    await admin.sql`CREATE DATABASE ${admin.sql(workerName)} TEMPLATE ${admin.sql(hubName)}`;
    copies.push(workerName);
    hub = createClient({ url: conn(hubName), max: 4 });
    worker = createClient({ url: conn(workerName), max: 6 });
    // Install the same real catalogue in the independent worker. No hub
    // dispatch, claim or solver result is a pre-existing worker execution.
    await worker.sql.begin(async (tx) => {
      await tx`SET LOCAL client_min_messages=warning`;
      await tx`TRUNCATE sim_jobs,sync_sweep_promises,registered_remote_solvers CASCADE`;
    });
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    server = fork(
      join(root, "apps/api/test/registered-replacement-round-server.ts"),
      [],
      {
        cwd: join(root, "apps/api"),
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          DATABASE_URL: conn(hubName),
          AIRFOILFOAM_DEPLOYMENT_ROLE: "hub",
          MEDIA_DIR: media,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    exited = once(server, "exit");
    let err = "";
    server.stderr?.on("data", (chunk) => {
      err = (err + String(chunk)).slice(-1200);
    });
    const requests: { method: string; path: string; status: number }[] = [];
    const ready = new Promise<string>((resolve, reject) => {
      server!.on(
        "message",
        (msg: {
          kind: string;
          url?: string;
          method?: string;
          path?: string;
          status?: number;
        }) => {
          if (msg.kind === "ready" && msg.url) resolve(msg.url);
          if (msg.kind === "request" && msg.method && msg.path && msg.status)
            requests.push({
              method: msg.method,
              path: msg.path,
              status: msg.status,
            });
        },
      );
      server!.once("error", reject);
      server!.once("exit", () =>
        reject(Error("Registered hub did not start: " + err)),
      );
    });
    await run(hub, worker, await ready, requests);
  } finally {
    if (server?.connected) server.send("close");
    if (server && exited) {
      const deadline = setTimeout(() => server?.kill("SIGTERM"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
      }
    }
    await Promise.all([worker?.sql.end(), hub?.sql.end()]);
    try {
      for (const name of copies.reverse())
        await admin.sql`DROP DATABASE ${admin.sql(name)}`;
    } finally {
      await admin.sql.end();
      await rm(dir, { recursive: true, force: true });
    }
  }
}
