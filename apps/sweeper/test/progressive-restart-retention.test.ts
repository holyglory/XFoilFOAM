import { afterEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DB } from "@aerodb/db";
import type { EngineStripJobResponse } from "@aerodb/engine-client";
import * as ownership from "../src/progressive-remote-jobs";
import { reclaimProgressiveRestartState } from "../src/progressive-restart-retention";

afterEach(() => vi.restoreAllMocks());

const executionId = "cf591f48-7ddf-4a80-b039-0aa0b4380556";
const receipt = {
  job_id: executionId,
  unknown_entries: [],
  bytes_freed: 4096,
  files_removed: 2,
  kept_case_state: false,
};

function fixture(blocked = true, candidates = true) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([{ disk_admission_blocked: blocked }])
    .mockResolvedValueOnce(
      candidates
        ? [
            {
              id: executionId,
              sequence: 3,
              report: { result: { state: "completed" } },
            },
          ]
        : [],
    )
    .mockResolvedValue([]);
  const db = {
    execute,
    transaction: (run: (connection: DB) => Promise<unknown>) =>
      run(db as unknown as DB),
  } as unknown as DB;
  const stripJob = vi.fn(async (): Promise<EngineStripJobResponse> => receipt);
  const owned = vi
    .spyOn(ownership, "assertProgressiveWorkerEvidenceJob")
    .mockResolvedValue(true);
  return { db, execute, owned, engine: { stripJob } };
}

it("does not strip without pressure or a terminal candidate", async () => {
  for (const [blocked, candidates] of [
    [false, true],
    [true, false],
  ]) {
    const state = fixture(blocked, candidates);
    expect(
      await reclaimProgressiveRestartState(state.db, state.engine),
    ).toEqual({ stripped: 0, bytesFreed: 0 });
    expect(state.engine.stripJob).not.toHaveBeenCalled();
  }
});

it("authenticates exact worker ownership and requests only checkpoint stripping", async () => {
  const state = fixture();
  expect(await reclaimProgressiveRestartState(state.db, state.engine)).toEqual({
    stripped: 1,
    bytesFreed: 4096,
  });
  expect(state.owned).toHaveBeenCalledWith(
    state.db,
    expect.objectContaining({
      simJobId: executionId,
      engineJobId: executionId,
      reportSequence: 3,
    }),
  );
  expect(state.engine.stripJob).toHaveBeenCalledWith(
    executionId,
    { keep_case_state: false },
    { timeoutMs: 30000 },
  );
  const dialect = new PgDialect();
  const selected = dialect.sqlToQuery(state.execute.mock.calls[1][0]).sql;
  for (const guard of [
    "FOR UPDATE",
    "SKIP LOCKED",
    "stopProof,job_id",
    "continue_from,engine_job_id",
    "ingest_lease_expires_at",
    "sim_urans_requests",
    "sim_precalc_obligations",
    "sim_urans_verify_queue",
  ])
    expect(selected).toContain(guard);
  const saved = dialect.sqlToQuery(state.execute.mock.calls[2][0]);
  expect(saved.sql).toContain("strip_report=");
  expect(saved.sql).not.toContain("ingestedAt");
});

it.each([false, "foreign report"])(
  "refuses missing or changed evidence ownership %s",
  async (result) => {
    const state = fixture();
    if (result === false) state.owned.mockResolvedValue(false);
    else state.owned.mockRejectedValue(new Error(String(result)));
    await expect(
      reclaimProgressiveRestartState(state.db, state.engine),
    ).rejects.toThrow();
    expect(state.engine.stripJob).not.toHaveBeenCalled();
  },
);

it.each([
  { ...receipt, job_id: "foreign" },
  { ...receipt, unknown_entries: undefined },
  { ...receipt, bytes_freed: -1 },
  { ...receipt, kept_case_state: true },
])("does not certify malformed engine receipts", async (bad) => {
  const state = fixture();
  state.engine.stripJob.mockResolvedValue(bad);
  expect(
    await reclaimProgressiveRestartState(state.db, state.engine),
  ).toMatchObject({ stripped: 0, bytesFreed: 0, error: expect.any(String) });
  const saved = new PgDialect().sqlToQuery(state.execute.mock.calls[2][0]).sql;
  expect(saved).not.toContain("strip_report");
});

it("preserves a refused archive and does not certify unknown retained entries", async () => {
  const state = fixture();
  state.engine.stripJob.mockRejectedValueOnce(
    new Error("409 archive authentication refused"),
  );
  expect(
    await reclaimProgressiveRestartState(state.db, state.engine),
  ).toMatchObject({ stripped: 0, bytesFreed: 0 });
  const partial = fixture();
  partial.engine.stripJob.mockResolvedValue({
    ...receipt,
    unknown_entries: ["forensic-source"],
  });
  expect(
    await reclaimProgressiveRestartState(partial.db, partial.engine),
  ).toEqual({ stripped: 0, bytesFreed: 4096 });
  expect(
    new PgDialect().sqlToQuery(partial.execute.mock.calls[2][0]).sql,
  ).toContain("stripped_at=NULL");
});
