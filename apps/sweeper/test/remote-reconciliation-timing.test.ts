import { expect, it, vi } from "vitest";
import { measureRemoteReconciliationStep } from "../src/remote-reconciliation-timing";

it("measures a real completed step without including its payload", async () => {
  const value = { credential: "not-telemetry", identifiers: ["private"] };
  const report = vi.fn();
  expect(
    await measureRemoteReconciliationStep(
      "assignment_intake",
      async () => value,
      report,
    ),
  ).toBe(value);
  expect(report).toHaveBeenCalledTimes(1);
  const measurement = report.mock.calls[0][0];
  expect(measurement).toMatchObject({
    component: "remote-reconciliation-step",
    step: "assignment_intake",
    succeeded: true,
  });
  expect(Object.keys(measurement).sort()).toEqual([
    "checkedAt",
    "component",
    "durationMs",
    "step",
    "succeeded",
  ]);
  expect(measurement.durationMs).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(Date.parse(measurement.checkedAt))).toBe(true);
  expect(JSON.stringify(measurement)).not.toContain("not-telemetry");
});

it("keeps the original failure and emits no raw error content", async () => {
  const failure = new Error("private response");
  const report = vi.fn();
  await expect(
    measureRemoteReconciliationStep(
      "fleet_heartbeat",
      async () => {
        throw failure;
      },
      report,
    ),
  ).rejects.toBe(failure);
  expect(report.mock.calls[0][0]).toMatchObject({
    step: "fleet_heartbeat",
    succeeded: false,
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain("private response");
});

it("cannot change the operation outcome when telemetry output fails", async () => {
  const report = () => {
    throw new Error("logging unavailable");
  };
  expect(
    await measureRemoteReconciliationStep(
      "capabilities",
      async () => 3,
      report,
    ),
  ).toBe(3);
  const failure = new Error("original failure");
  await expect(
    measureRemoteReconciliationStep(
      "lease_renewal",
      async () => {
        throw failure;
      },
      report,
    ),
  ).rejects.toBe(failure);
});

it("does not report unfinished work as a completed stage", async () => {
  let release: (value: number) => void = () => {};
  const report = vi.fn();
  const result = measureRemoteReconciliationStep(
    "promise_expiry",
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      }),
    report,
  );
  await Promise.resolve();
  expect(report).not.toHaveBeenCalled();
  release(7);
  expect(await result).toBe(7);
  expect(report).toHaveBeenCalledTimes(1);
});
