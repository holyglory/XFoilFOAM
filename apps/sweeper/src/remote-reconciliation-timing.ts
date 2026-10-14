type Step =
  | "capabilities"
  | "assignment_intake"
  | "lease_renewal"
  | "promise_expiry"
  | "rejected_results"
  | "fleet_heartbeat";

type Measurement = {
  component: "remote-reconciliation-step";
  step: Step;
  succeeded: boolean;
  durationMs: number;
  checkedAt: string;
};

export async function measureRemoteReconciliationStep<Result>(
  step: Step,
  operation: () => Promise<Result>,
  report: (measurement: Measurement) => void = (measurement) =>
    console.log(JSON.stringify(measurement)),
): Promise<Result> {
  const started = performance.now();
  let succeeded = false;
  try {
    const result = await operation();
    succeeded = true;
    return result;
  } finally {
    try {
      report({
        component: "remote-reconciliation-step",
        step,
        succeeded,
        durationMs: performance.now() - started,
        checkedAt: new Date().toISOString(),
      });
    } catch {}
  }
}
