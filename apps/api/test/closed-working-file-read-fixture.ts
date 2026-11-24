import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "@aerodb/db";
import { registerClosedWorkingFileSource } from "../src/closed-working-file-source";
import { registerRoutes } from "../src/routes";
import { registerClosedWorkingFileRead } from "../../sweeper/src/closed-progressive-retention";
import { RetentionFiles } from "../../sweeper/src/retention-files";
import { env } from "../src/env";

/** The ordinary sweeper has just completed this real signed PG16 fixture, closed the job and removed its two copies. */
export async function verifyClosedWorkingFileRead(
  db: DB,
  job: string,
  root: string,
  volume: string,
  python: string,
  assignment: string,
  setUpstreamFailure: (
    mode: "wrong-generation" | "bad-bytes" | "busy" | "historical-owner" | null,
  ) => void,
) {
  const app = Fastify();
  const priorToken = env.engineControlPlaneToken,
    priorEngine = env.engineUrl;
  const token = "private-file-fixture-control";
  env.engineControlPlaneToken = token;
  registerClosedWorkingFileSource(app, db);
  await registerRoutes(app);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const launch = `
import socket,sys,uvicorn
from airfoilfoam.api import main
from airfoilfoam import working_file_restore
from pathlib import Path
settings=main.get_settings().model_copy(update={"data_dir":Path(sys.argv[1]),"control_plane_token":sys.argv[3]})
main.get_settings=lambda:settings
working_file_restore.GATEWAY=sys.argv[2]+"/internal/closed-working-files"
sock=socket.socket();sock.bind(("127.0.0.1",0));sock.listen(16)
print(sock.getsockname()[1],flush=True)
uvicorn.Server(uvicorn.Config(main.create_app(),log_level="error",lifespan="off")).run(sockets=[sock])
`;
  const engine = spawn(python, ["-B", "-c", launch, volume, origin, token], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: join(root, "src") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain stderr while the child is running; assertions exercise the HTTP surface.
  engine.stderr.resume();
  const lines = createInterface({ input: engine.stdout });
  const close = once(engine, "exit");
  try {
    const port = await Promise.race([
      once(lines, "line").then(([line]) => Number(line)),
      close.then(() => 0),
    ]);
    expect(port).toBeGreaterThan(0);
    env.engineUrl = "http://127.0.0.1:" + port;
    const [row] =
      await db.execute(sql`SELECT strip_report->'closedWorkingFileRead' AS witness,
      strip_report->'closedProgressiveFiles' AS receipt FROM sim_jobs WHERE id=${job}::uuid`);
    const w = row.witness as {
      filesSha256: string;
      plan: string;
      files: number;
      sources: { upload: string; generation: string }[];
    };
    expect(w.files).toBe(2);
    const source =
      origin +
      `/internal/closed-working-files/${job}/${w.plan}/${w.filesSha256}/foil`;
    expect((await fetch(source)).status).toBe(401);
    const working =
      "cases/foil/transient_a0/postProcessing/forceCoeffs/0/coefficient.dat";
    const direct = env.engineUrl + "/jobs/" + job + "/files/" + working;
    const media = origin + "/api/media/jobs/" + job + "/" + working;
    // Upgrade a completed pre-reader receipt. A missing index keeps the old 404,
    // then the normal full native after-read adds only a sibling read witness.
    await db.execute(
      sql`UPDATE sim_jobs SET strip_report=strip_report-'closedWorkingFileRead' WHERE id=${job}::uuid`,
    );
    expect((await fetch(direct)).status).toBe(404);
    const preview = await registerClosedWorkingFileRead(
      db,
      new RetentionFiles(volume),
      job,
      w.plan,
      AbortSignal.timeout(45000),
      true,
    );
    expect(preview).toEqual(row.witness);
    expect((await fetch(direct)).status).toBe(404);
    const registered = await registerClosedWorkingFileRead(
      db,
      new RetentionFiles(volume),
      job,
      w.plan,
      AbortSignal.timeout(45000),
    );
    expect(registered).toEqual(row.witness);
    const bytes = Buffer.from(
      "# Time Cl Cd Cm\n0.01 0.42 0.02 -0.03\n0.02 0.43 0.018 -0.03\n",
    );
    for (const url of [direct, media]) {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
    const range = await fetch(direct, { headers: { range: "bytes=4-13" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("x-gcs-generation")).toBe("18446744073709551614");
    expect(range.headers.get("x-working-file-plan")).toBe(w.plan);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(
      bytes.subarray(4, 14),
    );
    for (const mode of ["wrong-generation", "bad-bytes", "busy"] as const) {
      setUpstreamFailure(mode);
      const res = await fetch(direct);
      expect(res.status).toBe(mode === "busy" ? 503 : 409);
      expect(Buffer.from(await res.arrayBuffer())).not.toEqual(bytes);
      const nodeFailure = await fetch(media);
      expect(nodeFailure.status).toBeGreaterThanOrEqual(400);
      expect(Buffer.from(await nodeFailure.arrayBuffer())).not.toEqual(bytes);
    }
    setUpstreamFailure("historical-owner");
    expect((await fetch(direct)).status).toBe(404);
    setUpstreamFailure(null);
    const opts = { headers: { authorization: "Bearer " + token } };
    const workerRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    expect(workerRole).toBe("remote-solver");
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
    try {
      expect((await fetch(source, opts)).status).toBe(403);
      const object = source + "/" + w.sources[0].upload + "/" + w.sources[0].generation;
      expect((await fetch(object, opts)).status).toBe(403);
      for (const url of [direct, media]) {
        const rejected = await fetch(url);
        expect(rejected.status).toBeGreaterThanOrEqual(400);
        expect(Buffer.from(await rejected.arrayBuffer())).not.toEqual(bytes);
      }
    } finally {
      process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = workerRole;
    }
    expect(
      (
        await fetch(
          source + "/" + w.sources[0].upload + "/18446744073709551615",
          opts,
        )
      ).status,
    ).toBe(404);
    const [instance] = await db.execute(
      sql`SELECT instance_id FROM sync_api_settings WHERE id=1`,
    );
    await db.execute(
      sql`UPDATE sync_api_settings SET instance_id=gen_random_uuid() WHERE id=1`,
    );
    try {
      expect((await fetch(direct)).status).toBe(409);
    } finally {
      await db.execute(
        sql`UPDATE sync_api_settings SET instance_id=${String(instance.instance_id)}::uuid WHERE id=1`,
      );
    }
    const entry = join(
      volume,
      "jobs",
      job,
      "closed_progressive_duplicate_files.intent.json",
    );
    const original = await readFile(entry);
    try {
      const changed = JSON.parse(original.toString());
      changed.files[0][1] = "a".repeat(64);
      await writeFile(entry, JSON.stringify(changed));
      expect((await fetch(direct)).status).toBe(409);
    } finally {
      await writeFile(entry, original);
    }
    // A local historical-raw owner cannot use this separate ordinary channel.
    await db.execute(
      sql`INSERT INTO progressive_historical_raw_archives(sim_job_id) VALUES(${job}::uuid)`,
    );
    try {
      expect((await fetch(direct)).status).toBe(404);
    } finally {
      await db.execute(
        sql`DELETE FROM progressive_historical_raw_archives WHERE sim_job_id=${job}::uuid`,
      );
    }
    const live = await fetch(
      env.engineUrl + "/jobs/" + job + "/files/cases/foil/transient_a0/1/p",
    );
    expect(await live.text()).toBe("latest pressure");
    const [after] =
      await db.execute(sql`SELECT strip_report->'closedProgressiveFiles' AS receipt,
      request_payload#>>'{remoteProgressiveExecution,contentSignature}' AS assignment FROM sim_jobs WHERE id=${job}::uuid`);
    expect(after.receipt).toEqual(row.receipt);
    expect(after.assignment).toBe(assignment);
  } finally {
    setUpstreamFailure(null);
    lines.close();
    engine.kill("SIGTERM");
    await close;
    await app.close();
    env.engineControlPlaneToken = priorToken;
    env.engineUrl = priorEngine;
  }
}
