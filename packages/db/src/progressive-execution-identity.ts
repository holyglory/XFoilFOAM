export function assertProgressiveExecutionIdentity(
  simJobId: string,
  engineJobId: string | null,
  requestPayload: unknown,
): void {
  const payload = requestPayload as {
    progressive?: { executionId?: string };
    engineRequest?: { execution_id?: string };
  } | null;
  if (
    engineJobId !== simJobId ||
    payload?.progressive?.executionId !== simJobId ||
    payload?.engineRequest?.execution_id !== simJobId
  )
    throw new Error(
      "Progressive execution identity conflict: reservation retained; foreign execution must not be polled, cancelled or ingested",
    );
}
