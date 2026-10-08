export interface ProgressiveFitBatchSummary {
  claimed: number;
  stored: number;
  errors: string[];
}

export async function runProgressiveFitBatches(
  concurrency: number,
  run: () => Promise<ProgressiveFitBatchSummary>,
): Promise<ProgressiveFitBatchSummary> {
  const batches = await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(16, concurrency)) },
      () => run(),
    ),
  );
  return batches.reduce(
    (summary, current) => ({
      claimed: summary.claimed + current.claimed,
      stored: summary.stored + current.stored,
      errors: [...summary.errors, ...current.errors],
    }),
    { claimed: 0, stored: 0, errors: [] },
  );
}
