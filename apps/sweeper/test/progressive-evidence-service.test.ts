import type { DB, Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { afterEach, expect, it, vi } from "vitest";
import {
  drainProgressiveWorkerEvidencePass,
  runProgressiveEvidenceService,
} from "../src/progressive-evidence-service";
import { withPeriodicIngestLeaseRenewal } from "../src/progressive-worker-evidence";

function notifications() {
  const callbacks = new Map<string, Set<() => void>>();
  const unlisten = vi.fn(async () => {});
  const listen = vi.fn(async (channel: string, callback: () => void) => {
    const listeners = callbacks.get(channel) ?? new Set();
    listeners.add(callback);
    callbacks.set(channel, listeners);
    return {
      unlisten: async () => {
        listeners.delete(callback);
        await unlisten();
      },
    };
  });
  return {
    connection: { listen } as unknown as Pick<Sql, "listen">,
    notify: (channel: string) =>
      callbacks.get(channel)?.forEach((callback) => callback()),
    unlisten,
    listen,
  };
}

function gate() {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

afterEach(() => vi.useRealTimers());

it("renews a delayed ingest without overlap and cleans up its timer", async () => {
  vi.useFakeTimers();
  const stagePointGate = gate();
  const renewalGate = gate();
  let activeRenewals = 0;
  let peakRenewals = 0;
  const stagePoint = vi.fn(async () => {
    await stagePointGate.pending;
  });
  const renew = vi.fn(async () => {
    activeRenewals += 1;
    peakRenewals = Math.max(peakRenewals, activeRenewals);
    try {
      await renewalGate.pending;
    } finally {
      activeRenewals -= 1;
    }
  });
  let settled = false;
  const running = withPeriodicIngestLeaseRenewal(
    async () => {
      await stagePoint();
      return "staged";
    },
    renew,
  ).then((result) => {
    settled = true;
    return result;
  });

  await vi.advanceTimersByTimeAsync(20_000);
  expect(stagePoint).toHaveBeenCalledTimes(1);
  expect(renew).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(renew).toHaveBeenCalledTimes(1);
  expect(peakRenewals).toBe(1);

  stagePointGate.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  renewalGate.release();
  await expect(running).resolves.toBe("staged");
  expect(activeRenewals).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds serial deliveries and stops when no eligible evidence remains", async () => {
  const deliver = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  expect(await drainProgressiveWorkerEvidencePass(deliver, true)).toBe(true);
  expect(deliver.mock.calls).toEqual([[true], [true], [true]]);
  const busy = vi.fn().mockResolvedValue(true);
  expect(await drainProgressiveWorkerEvidencePass(busy, false)).toBe(true);
  expect(busy).toHaveBeenCalledTimes(8);
});

it("refills a free staging slot while other imports and delivery remain pending", async () => {
  vi.useFakeTimers();
  const channel = notifications();
  const owner = new AbortController();
  const imports = Array.from({ length: 4 }, gate);
  const network = gate();
  let active = 0;
  let peak = 0;
  let started = 0;
  const stage = vi.fn(async (_preferActive: boolean) => {
    const ordinal = started++;
    active += 1;
    peak = Math.max(peak, active);
    try {
      if (ordinal < imports.length) {
        await imports[ordinal].pending;
        return true;
      }
      return false;
    } finally {
      active -= 1;
    }
  });
  const deliver = vi.fn(async () => {
    await network.pending;
    return false;
  });
  const running = runProgressiveEvidenceService(
    {} as DB,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    { stage, deliver, nextWakeAt: async () => null },
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(stage).toHaveBeenCalledTimes(4);
    expect(deliver).toHaveBeenCalledTimes(4);
    imports[0].release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stage).toHaveBeenCalledTimes(5);
    expect(active).toBe(3);
    expect(peak).toBe(4);
    expect(stage.mock.calls.slice(0, 4).map((call) => call[0])).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(stage.mock.calls[4][0]).toBe(false);
  } finally {
    owner.abort();
    imports.forEach((importing) => importing.release());
    network.release();
    await running;
  }
  expect(channel.unlisten).toHaveBeenCalledTimes(8);
});

it("uses bounded configured staging and delivery lane counts", async () => {
  vi.useFakeTimers();
  const previousStageLanes = process.env.REMOTE_EVIDENCE_STAGE_LANES;
  const previousDeliveryLanes = process.env.REMOTE_EVIDENCE_DELIVERY_LANES;
  process.env.REMOTE_EVIDENCE_STAGE_LANES = "2";
  process.env.REMOTE_EVIDENCE_DELIVERY_LANES = "3";
  const channel = notifications();
  const owner = new AbortController();
  const imports = Array.from({ length: 2 }, gate);
  const network = gate();
  const stage = vi.fn(async () => {
    await imports[0].pending;
    return false;
  });
  const deliver = vi.fn(async () => {
    await network.pending;
    return false;
  });
  const running = runProgressiveEvidenceService(
    {} as DB,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    { stage, deliver, nextWakeAt: async () => null },
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(stage).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledTimes(3);
  } finally {
    owner.abort();
    imports.forEach((pending) => pending.release());
    network.release();
    await running;
    if (previousStageLanes === undefined)
      delete process.env.REMOTE_EVIDENCE_STAGE_LANES;
    else process.env.REMOTE_EVIDENCE_STAGE_LANES = previousStageLanes;
    if (previousDeliveryLanes === undefined)
      delete process.env.REMOTE_EVIDENCE_DELIVERY_LANES;
    else process.env.REMOTE_EVIDENCE_DELIVERY_LANES = previousDeliveryLanes;
  }
});

it("continues delivery while all four staging slots wait", async () => {
  vi.useFakeTimers();
  const channel = notifications();
  const owner = new AbortController();
  const imports = gate();
  const stage = vi.fn(async () => {
    await imports.pending;
    return false;
  });
  const deliver = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  const running = runProgressiveEvidenceService(
    {} as DB,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    { stage, deliver, nextWakeAt: async () => null },
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(stage).toHaveBeenCalledTimes(4);
    expect(deliver).toHaveBeenCalledTimes(8);
    expect(deliver.mock.calls.every(([preferActive]) => preferActive)).toBe(
      true,
    );
    channel.notify("progressive_worker_evidence_changed");
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledTimes(12);
    expect(stage).toHaveBeenCalledTimes(4);
  } finally {
    owner.abort();
    imports.release();
    await running;
  }
});

it("keeps staging moving during delivery failures without bypassing delivery backoff", async () => {
  vi.useFakeTimers();
  const channel = notifications();
  const owner = new AbortController();
  const reportError = vi.fn();
  let staged = 0;
  const stage = vi.fn(async () => staged++ < 4);
  const deliver = vi.fn(async () => {
    channel.notify("progressive_worker_evidence_changed");
    throw new Error("isolated network failure");
  });
  const running = runProgressiveEvidenceService(
    {} as DB,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    { stage, deliver, nextWakeAt: async () => null, reportError },
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(stage).toHaveBeenCalledTimes(8);
    expect(deliver).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(99);
    expect(deliver).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledTimes(8);
    expect(reportError).toHaveBeenCalledTimes(8);
  } finally {
    owner.abort();
    await running;
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps retry deadlines independent and wakes all slots for acknowledged evidence", async () => {
  vi.useFakeTimers();
  const channel = notifications();
  const owner = new AbortController();
  const deadlines = { staging: Date.now() + 2057, delivery: Date.now() + 1033 };
  const stage = vi.fn().mockResolvedValue(false);
  const deliver = vi.fn().mockResolvedValue(false);
  const running = runProgressiveEvidenceService(
    {} as DB,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    {
      stage,
      deliver,
      nextWakeAt: async (scope) =>
        Date.now() < deadlines[scope] ? new Date(deadlines[scope]) : null,
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(1032);
    expect(stage).toHaveBeenCalledTimes(4);
    expect(deliver).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(stage).toHaveBeenCalledTimes(4);
    expect(deliver).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(1024);
    expect(stage).toHaveBeenCalledTimes(8);
    expect(deliver).toHaveBeenCalledTimes(8);
    channel.notify("progressive_worker_evidence_changed");
    await vi.advanceTimersByTimeAsync(0);
    expect(stage).toHaveBeenCalledTimes(12);
    expect(deliver).toHaveBeenCalledTimes(12);
    await vi.advanceTimersByTimeAsync(10000);
    expect(stage).toHaveBeenCalledTimes(12);
  } finally {
    owner.abort();
    await running;
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("awaits every in-flight operation on shutdown and never restarts after abort", async () => {
  vi.useFakeTimers();
  const channel = notifications();
  const owner = new AbortController();
  const imports = gate();
  const network = gate();
  const stage = vi.fn(async () => {
    await imports.pending;
    return true;
  });
  const deliver = vi.fn(async () => {
    await network.pending;
    return true;
  });
  let finished = false;
  const running = runProgressiveEvidenceService(
    {} as DB,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    { stage, deliver, nextWakeAt: async () => null },
  ).then(() => {
    finished = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    owner.abort();
    imports.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(channel.unlisten).toHaveBeenCalledTimes(4);
    expect(stage).toHaveBeenCalledTimes(4);
  } finally {
    owner.abort();
    imports.release();
    network.release();
    await running;
  }
  expect(finished).toBe(true);
  expect(channel.unlisten).toHaveBeenCalledTimes(8);
  expect(deliver).toHaveBeenCalledTimes(4);
});
