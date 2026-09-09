export async function runRemoteTransferSteps(
  steps: Array<{ name: string; run: () => Promise<boolean> }>,
) {
  const receipt = {
    processed: false,
    errors: [] as Array<{ step: string; message: string }>,
  };
  for (const step of steps) {
    try {
      receipt.processed = (await step.run()) || receipt.processed;
    } catch (error) {
      receipt.errors.push({
        step: step.name,
        message: String(error instanceof Error ? error.message : error).slice(
          0,
          700,
        ),
      });
    }
  }
  return receipt;
}
