import { afterEach, expect, it, vi } from "vitest";
import type { DB, Sql } from "@aerodb/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  reconcileScope: vi.fn(),
  initialize: vi.fn(),
  reuse: vi.fn(),
  unbound: vi.fn(),
  inactive: vi.fn(),
  terminal: vi.fn(),
  spent: vi.fn(),
  classifyRetained: vi.fn(),
  invalidate: vi.fn(),
  baseline: vi.fn(),
  fit: vi.fn(),
  stages: vi.fn(),
}));

vi.mock("@aerodb/db", () => ({
  reconcileProgressiveGenerationRequest: mocks.reconcileScope,
  initializeProgressiveCfdWork: mocks.initialize,
  advanceProgressiveCfdStages: mocks.stages,
  recoverUnboundProgressiveCfdLeases: mocks.unbound,
  recoverInactiveProgressiveRemoteGaps: mocks.inactive,
  retryTerminalProgressiveNoEvidenceGaps: mocks.terminal,
  settleSpentProgressiveMaterialGaps: mocks.spent,
  refreshPolarClassificationsForJob: mocks.classifyRetained,
  invalidateProgressiveFitPolicy: mocks.invalidate,
}));
vi.mock("@aerodb/db/progressive-execution-policy", () => ({
  effectiveProgressiveStageSql: () => "stage",
}));
vi.mock("@aerodb/db/progressive-cfd-reuse", () => ({
  reconcileAcceptedProgressiveCfdEvidence: mocks.reuse,
}));
vi.mock("../src/progressive-baselines", () => ({
  runProgressiveBaselineBatch: mocks.baseline,
}));
vi.mock("../src/progressive-fitting", () => ({
  PROGRESSIVE_FIT_POLICY_ID: "test-policy",
  runProgressiveFitBatch: mocks.fit,
}));
vi.mock("../src/progressive-fit-concurrency", () => ({
  runProgressiveFitBatches: mocks.fit,
}));

import { runProgressiveBaselineService } from "../src/progressive-service";

function notifications() {
  const unlisten = vi.fn(async () => {});
  return {
    listen: vi.fn(async () => ({ unlisten })),
    unlisten,
  } as unknown as Pick<Sql, "listen"> & { unlisten: typeof unlisten };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("runs stage maintenance again without a solver notification and cleans its wake", async () => {
  vi.useFakeTimers();
  mocks.spent.mockResolvedValue({ settled: 0, busy: false });
  mocks.reconcileScope.mockResolvedValue(null);
  mocks.initialize.mockResolvedValue(0);
  mocks.reuse.mockResolvedValue(0);
  mocks.unbound.mockResolvedValue({ retried: 0, gaps: 0 });
  mocks.inactive.mockResolvedValue(0);
  mocks.terminal.mockResolvedValue(0);
  mocks.classifyRetained.mockResolvedValue([]);
  mocks.invalidate.mockResolvedValue(0);
  mocks.baseline.mockResolvedValue({
    claimed: 0,
    stored: 0,
    reused: 0,
    errors: [],
  });
  mocks.fit.mockResolvedValue({ claimed: 0, stored: 0, errors: [] });
  mocks.stages.mockResolvedValue({
    admitted: 0,
    closed: 0,
    waiting: 0,
    campaignsCompleted: 0,
  });
  const db = {
    execute: vi.fn().mockResolvedValue([{ enabled: true, remote: false }]),
  } as unknown as DB;
  const channel = notifications();
  const owner = new AbortController();
  const running = runProgressiveBaselineService(
    db,
    channel,
    {} as never,
    owner.signal,
  );

  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.initialize).toHaveBeenCalledOnce();
  expect(mocks.stages).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.initialize).toHaveBeenCalledTimes(2);
  expect(mocks.stages).toHaveBeenCalledTimes(2);

  owner.abort();
  await running;
  expect(channel.unlisten).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps retained evidence classification on the maintenance cadence", async () => {
  vi.useFakeTimers();
  mocks.spent.mockResolvedValue({ settled: 0, busy: false });
  mocks.reconcileScope.mockResolvedValue(null);
  mocks.initialize.mockResolvedValue(0);
  mocks.reuse.mockResolvedValue(0);
  mocks.unbound.mockResolvedValue({ retried: 0, gaps: 0 });
  mocks.inactive.mockResolvedValue(0);
  mocks.terminal.mockResolvedValue(0);
  mocks.classifyRetained
    .mockResolvedValueOnce([{}])
    .mockResolvedValueOnce([]);
  mocks.invalidate.mockResolvedValue(0);
  mocks.baseline.mockResolvedValue({
    claimed: 0,
    stored: 0,
    reused: 0,
    errors: [],
  });
  mocks.fit.mockResolvedValue({ claimed: 0, stored: 0, errors: [] });
  mocks.stages.mockResolvedValue({
    admitted: 0,
    closed: 0,
    waiting: 0,
    campaignsCompleted: 0,
  });
  const db = {
    execute: vi
      .fn()
      .mockResolvedValueOnce([{ enabled: true, remote: true }])
      .mockResolvedValueOnce([
        {
          id: "job-1",
          airfoil_id: "airfoil-1",
          simulation_preset_revision_id: "preset-1",
        },
      ])
      .mockResolvedValueOnce([{ enabled: true, remote: true }])
      .mockResolvedValueOnce([
        {
          id: "job-1",
          airfoil_id: "airfoil-1",
          simulation_preset_revision_id: "preset-1",
        },
      ]),
  } as unknown as DB;
  const reports: Record<string, unknown>[] = [];
  const owner = new AbortController();
  const running = runProgressiveBaselineService(
    db,
    notifications(),
    {} as never,
    owner.signal,
    (receipt) => reports.push(receipt),
  );

  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.classifyRetained).toHaveBeenCalledWith(
    db,
    "airfoil-1",
    "preset-1",
    "job-1",
  );
  expect(mocks.classifyRetained).toHaveBeenCalledOnce();
  expect(reports).toContainEqual({
    component: "progressive-terminal-evidence-classification",
    classified: 1,
  });

  owner.abort();
  await running;
});

it.each([false, true])("continues committed spent pages through contention and a slow recovery (remote=%s)", async (remote) => {
  vi.useFakeTimers();
  mocks.spent.mockResolvedValueOnce({ settled: 64, busy: false })
    .mockResolvedValueOnce({ settled: 0, busy: true })
    .mockResolvedValueOnce({ settled: 0, busy: true })
    .mockResolvedValueOnce({ settled: 64, busy: false })
    .mockResolvedValueOnce({ settled: 2, busy: false })
    .mockResolvedValue({ settled: 0, busy: false });
  mocks.reconcileScope.mockResolvedValue(null);
  mocks.initialize.mockResolvedValue(0);
  mocks.reuse.mockResolvedValue(0);
  mocks.unbound.mockResolvedValue({retried:0,gaps:0});
  mocks.inactive.mockResolvedValue(0);
  let finishRead!: () => void;
  const slowArchiveRead = new Promise<void>(resolve => { finishRead = resolve; });
  mocks.terminal.mockResolvedValue(0);
  mocks.invalidate.mockResolvedValue(0);
  mocks.baseline.mockResolvedValue({claimed:0,stored:0,reused:0,errors:[]});
  mocks.fit.mockResolvedValue({claimed:0,stored:0,errors:[]});
  mocks.stages.mockResolvedValue({admitted:0,closed:0,waiting:0,campaignsCompleted:0});
  if (remote) {
    mocks.reuse.mockImplementationOnce(async () => { await slowArchiveRead; return 0; });
  } else {
    mocks.fit.mockImplementationOnce(async () => {
      await slowArchiveRead;
      return {claimed:0,stored:0,errors:[]};
    });
  }
  const dialect = new PgDialect();
  const db = {execute: vi.fn(async (q: SQL) =>
    dialect.sqlToQuery(q).sql.includes("FROM sweeper_state") ? [{enabled:true,remote}] : [])} as unknown as DB;
  const channel = notifications(), owner = new AbortController();
  const reports: Record<string, unknown>[] = [];
  const run = runProgressiveBaselineService(db, channel, {} as never, owner.signal, row => reports.push(row));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(remote ? mocks.reuse : mocks.fit).toHaveBeenCalledOnce();
    for (const [elapsed, calls] of [[999,1],[1,2],[1_999,2],[1,3],[3_999,3],[2_001,6]] as const) {
      await vi.advanceTimersByTimeAsync(elapsed);
      expect(mocks.spent).toHaveBeenCalledTimes(calls);
    }
    expect(reports.filter(r=>r.component==="progressive-spent-material-gaps").map(r=>r.settled)).toEqual([64,64,2]);
    expect(mocks.reconcileScope).toHaveBeenCalledOnce();
    finishRead();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.spent).toHaveBeenCalledTimes(7);
    expect(mocks.terminal).toHaveBeenCalledTimes(remote ? 1 : 2);
    if (remote) {
      expect(mocks.baseline).not.toHaveBeenCalled();
      expect(mocks.fit).not.toHaveBeenCalled();
    } else {
      expect(mocks.baseline).toHaveBeenCalledTimes(2);
      expect(mocks.stages).toHaveBeenCalledTimes(2);
    }
  } finally {
    finishRead();
    owner.abort();
    await run;
  }
  expect(channel.unlisten).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
