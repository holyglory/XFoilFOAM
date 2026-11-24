import { execFile, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import { databaseUrl } from "@aerodb/db/env";
import { loadSettledAttemptEvidenceCopy } from "@aerodb/db/attempt-evidence-storage";
import {
  canonicalSubtreeCandidates,
  restoreCanonicalSubtree,
  type CanonicalFieldProof,
} from "@aerodb/db/result-history-subtrees";
import {
  resultHistoriesMatch,
  loadResultHistorySource,
} from "@aerodb/db/result-history-storage";
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
import { reportTextIdentity } from "@aerodb/db/progressive-report-archive";
import { readStoredResultHistories } from "../../api/src/result-history-reader";
import { packHzAttemptSource } from "../src/hz-attempt-custody";
import { hzAttemptStorage } from "../src/hz-attempt-storage-cli";
import { attemptEvidenceStorageMain } from "../src/attempt-evidence-storage-cli";
import type { AttemptRelay } from "../src/hz-attempt-migration";
import { join } from "node:path";
import { prepareHzHistory } from "@aerodb/db/hz-point-history-storage";
import {
  verifyCanonicalPointHistory,
  verifyStoredHzHistory,
} from "../src/hz-point-history-relay";

// Hold only this fixture's reference table. Observe the actual RPC process
// waiting on PostgreSQL, then release it or let its normal lock timeout fire.
async function verifyCanonicalApiProcess(db: DB, namespace: string, proof: CanonicalFieldProof) {
  const url = new URL(databaseUrl());
  url.searchParams.set("options", `-c search_path=${namespace},public`);
  const entry = fileURLToPath(new URL("../../api/src/hz-attempt-custody-cli.ts", import.meta.url));
  const request = { id: 1, operation: "canonical-read", resultId: proof.resultId, kind: proof.kind, reference: proof.reference };
  const batch = [
    { ...request, id: 1, attemptReadSession: "api" },
    { ...request, id: 2, attemptReadSession: "api" },
    { ...request, id: 3, operation: "canonical-confirm", attemptReadSession: "api" },
  ];
  const sessionReplies = execFileSync(process.execPath, ["--import", "tsx", entry], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    input: batch.map(r => JSON.stringify(r)).join("\n") + "\n", encoding: "utf8", timeout: 20000,
  }).trim().split("\n").map(line => JSON.parse(line));
  expect(sessionReplies).toEqual([
    { id: 1, result: proof, attemptReadSession: "api" },
    { id: 2, result: proof, attemptReadSession: "api" },
    { id: 3, error: { operation: "attempt_read_scope", category: "denied", retryable: false } },
  ]);
  for (const expectTimeout of [false, true]) {
    let pid: number | undefined;
    let reply!: Promise<string>;
    await db.transaction(async tx => {
      await tx.execute(sql`LOCK TABLE ${sql.identifier(namespace)}.result_history_subtree_refs IN ACCESS EXCLUSIVE MODE`);
      let finished = false;
      reply = new Promise<string>((resolve, reject) => {
        const child = execFile(process.execPath, ["--import", "tsx", entry], {
          env: { ...process.env, DATABASE_URL: url.toString() }, encoding: "utf8", timeout: 20000,
        }, (err, stdout) => {
          finished = true;
          if (err) reject(err); else resolve(stdout);
        });
        child.stdin!.end(JSON.stringify(request) + "\n");
      });
      // Attach a handler now so an early process error is still observed
      // while polling for its blocked database connection.
      void reply.catch(() => undefined);
      const deadline = Date.now() + 15000;
      while (!pid && !finished && Date.now() < deadline) {
        const [session] = await tx.execute(sql`SELECT DISTINCT waiting.pid FROM pg_locks held
          JOIN pg_locks waiting ON waiting.relation=held.relation AND waiting.database=held.database
          WHERE held.pid=pg_backend_pid() AND held.mode='AccessExclusiveLock' AND held.granted
            AND waiting.mode='AccessShareLock' AND NOT waiting.granted`);
        if (session) pid = Number(session.pid);
        else await delay(10);
      }
      expect(pid, "the real canonical read must own an open connection while waiting").toBeDefined();
      if (expectTimeout) await reply;
    });
    const response = JSON.parse(await reply);
    if (expectTimeout) expect(response).toMatchObject({ id: 1, error: {
      operation: "attempt_canonicalread_lock_timeout", retryable: true,
    } });
    else expect(response).toEqual({ id: 1, result: proof });
    const stillOpen = await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE pid=${pid} AND datname=current_database()`);
    expect(stillOpen).toHaveLength(0);
  }
}

export async function verifyCanonicalSubtreeJourney(
  db: DB,
  id: string,
  job: string,
  original: string,
  namespace: string,
  config: string[],
  io: { relay: AttemptRelay; report: (value: unknown) => void },
  objects: ReadonlyMap<string, unknown>,
  directory: string,
  kind: "steady_history" | "frame_track",
) {
  const [r] = await db.execute(
    sql`SELECT result_id FROM result_attempts WHERE id=${id}::uuid`,
  );
  const result = String(r.result_id);
  const column = sql.identifier(kind),
    refColumn = sql.identifier(kind + "_subtree_id"),
    archiveColumn = sql.identifier(kind + "_archive_id");
  const channel = kind === "steady_history" ? "iterations" : "frames";
  const fieldForApi =
    kind === "steady_history" ? "steadyHistory" : "frameTrack";
  const matches = (value: unknown) =>
    resultHistoriesMatch(db, result, {
      steadyHistory: null,
      frameTrack: null,
      [fieldForApi]: value,
    });
  const readField = async (value: unknown) =>
    (await readStoredResultHistories(db, { id: result, [fieldForApi]: value }))[
      fieldForApi
    ];
  await db.execute(sql`UPDATE results SET sim_job_id=${job}::uuid,${column}=${original}::jsonb->${kind},
    current_result_attempt_id=NULL WHERE id=${result}::uuid`);
  const [origin] = await db.execute(
    sql`SELECT ${column}::text AS original FROM results WHERE id=${result}::uuid`,
  );
  const fieldText = String(origin.original),
    field = JSON.parse(fieldText);
  expect(Buffer.byteLength(fieldText)).toBeLessThan(4096);
  expect(field[channel].length).toBeGreaterThan(0);
  const canonical = async () =>
    (
      await db.execute(sql`SELECT id,${column} AS value, ${archiveColumn} AS archive, ${refColumn} AS subtree,
    current_result_attempt_id selected, sim_job_id job,cl,cd,cm,converged,status FROM results WHERE id=${result}::uuid`)
    )[0]!;
  const before = await canonical();
  const packed = await packHzAttemptSource(
    await loadSettledAttemptEvidenceCopy(db, id),
  );
  const bound = await io.relay.worker({ operation: "bound" });
  const actor = { instance: bound.instance, solver: bound.solver };
  const fresh = await io.relay.hub({ operation: "put", ...actor, ...packed });
  const ar = await io.relay.worker(
    {
      operation: "stage",
      ...fresh,
      enable: true,
      retained: true,
      settled: true,
      requireTransfers: true,
      owner: actor,
    },
    true,
  );
  expect(objects.size).toBe(1);
  expect(await canonicalSubtreeCandidates(db, id)).toEqual([]);
  async function enable(canary: string) {
    const old = process.env.DATABASE_URL,
      uri = new URL(databaseUrl());
    uri.searchParams.set("options", `-c search_path=${namespace},public`);
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      process.env.DATABASE_URL = uri.toString();
      await attemptEvidenceStorageMain([
        "enable-canonical-subtrees",
        "--id",
        canary,
      ]);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
        canonicalHistorySubtreesEnabled: true,
        canonicalHistoryCanaryResultId: canary,
      });
    } finally {
      output.mockRestore();
      if (old === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = old;
    }
  }
  await enable("00000001-0000-4000-8000-000000000001");
  expect(await canonicalSubtreeCandidates(db, id)).toEqual([]);
  await enable(result);
  const [candidate] = await canonicalSubtreeCandidates(db, id);
  expect(candidate).toMatchObject({
    archive: ar.id,
    selected: null,
    field_sha: reportTextIdentity(fieldText).sha256,
    field_bytes: Buffer.byteLength(fieldText),
  });
  await expect(
    db.execute(sql`SELECT bind_canonical_history_subtree(${result}::uuid,${kind},${id}::uuid,${ar.id}::uuid,
    ${fresh.identity.generation},NULL,${original + " "},clock_timestamp())`),
  ).rejects.toThrow(/original generation or bytes/);
  await db.execute(
    sql`UPDATE sim_jobs SET ingest_lease_token=gen_random_uuid(),ingest_lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=${job}::uuid`,
  );
  expect(await canonicalSubtreeCandidates(db, id)).toEqual([]);
  await db.execute(
    sql`UPDATE sim_jobs SET ingest_lease_token=NULL,ingest_lease_expires_at=NULL WHERE id=${job}::uuid`,
  );
  const changed = {
    ...field,
    note: "published field with different source metadata",
  };
  await db.execute(
    sql`UPDATE results SET ${column}=${JSON.stringify(changed)}::jsonb WHERE id=${result}::uuid`,
  );
  expect(await canonicalSubtreeCandidates(db, id)).toEqual([]);
  expect(
    (
      await db.execute(sql`SELECT bind_canonical_history_subtree(${result}::uuid,${kind},${id}::uuid,${ar.id}::uuid,
    ${fresh.identity.generation},NULL,${original},clock_timestamp()) ref`)
    )[0].ref,
  ).toBeNull();
  await db.execute(
    sql`UPDATE results SET ${column}=${fieldText}::jsonb WHERE id=${result}::uuid`,
  );
  const args = [
    "migrate",
    ...config,
    "--include-settled-receipts",
    "--canonical-fields",
    "--id",
    id,
  ];
  const interrupted: AttemptRelay = {
    ...io.relay,
    async worker(request, write) {
      const value = await io.relay.worker(request, write);
      if (request.operation === "canonical-bind")
        throw Error("lost canonical bind acknowledgement");
      return value;
    },
  };
  await expect(
    hzAttemptStorage(args, { ...io, relay: interrupted }),
  ).rejects.toThrow("lost canonical bind acknowledgement");
  const [pending] = await canonicalSubtreeCandidates(db, id);
  expect(pending.existing_ref).toBeTruthy();
  const messages: Record<string, any>[] = [];
  if (kind === "steady_history") {
    const held = new AbortController();
    const busy: AttemptRelay = {
      ...io.relay,
      async worker(request, write) {
        if (request.operation === "canonical-candidates")
          throw new HistoryOperationError(
            "canonical_candidates_lock_timeout",
            "database_busy",
            true,
          );
        return io.relay.worker(request, write);
      },
    };
    await hzAttemptStorage(
      [
        "watch",
        ...config,
        "--include-settled-receipts",
        "--directory",
        join(directory, "held-canonical"),
        "--limit",
        "1",
      ],
      {
        ...io,
        relay: busy,
        signal: held.signal,
        report(value) {
          const observation = value as Record<string, any>;
          if (observation.canonicalFieldDeferred === id) {
            expect(observation.category).toBe("database_busy");
            held.abort();
          }
        },
      },
    );
    expect(held.signal.aborted).toBe(true);
    expect((await canonicalSubtreeCandidates(db, id))[0]?.existing_ref).toBe(
      pending.existing_ref,
    );
  }
  // Restart the existing ordinary worker, with the real selection and native
  // producer/consumer RPCs. A lost acknowledgement must not duplicate a row.
  const signal = new AbortController();
  if (kind === "frame_track") {
    // The frame fixture has another genuine attempt. Reconcile exactly this
    // archived generation through the normal scoped controller.
    await hzAttemptStorage(args, {
      ...io,
      report: (value) => messages.push(value as Record<string, any>),
    });
  } else
    await hzAttemptStorage(
      [
        "watch",
        ...config,
        "--include-settled-receipts",
        "--directory",
        join(directory, "canonical"),
        "--limit",
        "1",
      ],
      {
        ...io,
        signal: signal.signal,
        report(value) {
          const v = value as Record<string, any>;
          messages.push(v);
          if (v.canonicalFields?.length) signal.abort();
        },
      },
    );
  expect(
    messages.find((v) => v.canonicalFields)?.canonicalFields[0],
  ).toMatchObject({
    reference: pending.existing_ref,
    resultId: result,
    archiveId: ar.id,
    kind,
  });
  const cold = await canonical();
  expect(cold.selected).toBeNull();
  expect(cold.archive).toBeNull();
  await verifyCanonicalApiProcess(db, namespace, {
    resultId: result, kind, reference: String(cold.subtree), archiveId: ar.id,
    generation: fresh.identity.generation, fieldText,
  });
  const inspection = await verifyStoredHzHistory(
    { kind, id: result },
    {
      prepare: (selection) => prepareHzHistory(db, selection),
      verifySubtree: (source) =>
        verifyCanonicalPointHistory(source, io.relay.hub, io.relay.api),
      read: async () => {
        throw Error("Unexpected standalone archive read");
      },
      apiRead: async () => {
        throw Error("Unexpected standalone API probe");
      },
    },
  );
  expect(inspection).toMatchObject({
    verified: true,
    attemptArchive: { id: ar.id },
    api: { sourceSha256: reportTextIdentity(fieldText).sha256 },
  });
  expect(cold.subtree).toBe(pending.existing_ref);
  for (const key of ["id", "cl", "cd", "cm", "status", "converged", "job"])
    expect(cold[key]).toEqual(before[key]);
  expect(cold.value).toMatchObject({
    [channel]: {
      archivedResultHistoryArray: true,
      length: field[channel].length,
    },
    ...(kind === "steady_history"
      ? { note: field.note }
      : { stationary: field.stationary }),
  });
  expect(await readField(cold.value)).toEqual(field);
  expect(await matches(field)).toBe(true);
  expect(await matches(changed)).toBe(false);
  expect(await matches(cold.value)).toBe(false);
  expect(objects.size).toBe(1);
  expect(
    await db.execute(
      sql`SELECT * FROM result_history_archives WHERE result_id=${result}::uuid`,
    ),
  ).toHaveLength(0);
  expect(
    await db.execute(
      sql`SELECT * FROM result_history_subtree_refs WHERE result_id=${result}::uuid AND app_readback_at IS NOT NULL`,
    ),
  ).toHaveLength(1);
  await expect(loadResultHistorySource(db, result, kind)).rejects.toThrow(
    /subtree|archived/,
  );
  const proof: CanonicalFieldProof = {
    resultId: result,
    kind,
    archiveId: ar.id,
    generation: fresh.identity.generation,
    reference: pending.existing_ref!,
    fieldText,
  };
  await expect(
    restoreCanonicalSubtree(db, { ...proof, fieldText: fieldText + " " }),
  ).rejects.toThrow(/exact original/);
  expect(await restoreCanonicalSubtree(db, proof)).toBe(true);
  expect((await canonical()).value).toEqual(field);
  const failing: AttemptRelay = {
    ...io.relay,
    async api(request) {
      const v = await io.relay.api(request);
      if (request.operation === "canonical-read")
        throw Error("unavailable canonical application read");
      return v;
    },
  };
  await expect(
    hzAttemptStorage(args, { ...io, relay: failing }),
  ).rejects.toThrow(/unavailable canonical/);
  expect((await canonical()).subtree).toBeNull();
  expect((await canonical()).value).toEqual(field);
  await hzAttemptStorage(args, io);
  const last = await canonical();
  expect(last.subtree).not.toBe(proof.reference);
  await expect(readField(cold.value)).rejects.toThrow(/changed/);
  // A later selection changes point metadata normally. It cannot retarget
  // the old field reference or prevent genuine replacement of its bytes.
  await db.execute(
    sql`UPDATE results SET current_result_attempt_id=${id}::uuid WHERE id=${result}::uuid`,
  );
  expect(await readField(last.value)).toEqual(field);
  await db.execute(
    sql`UPDATE results SET ${column}=${JSON.stringify(changed)}::jsonb WHERE id=${result}::uuid`,
  );
  const replaced = await canonical();
  expect(replaced.selected).toBe(id);
  expect(replaced.subtree).toBeNull();
  expect(replaced.value).toEqual(changed);
  expect(
    await restoreCanonicalSubtree(db, {
      ...proof,
      reference: String(last.subtree),
    }),
  ).toBe(false);
  expect(await matches(changed)).toBe(true);
}
