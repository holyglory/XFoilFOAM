export type BackgroundTask = () => Promise<unknown>;

/**
 * Return a non-blocking runner that admits at most one background task at a
 * time. A rejected task is reported and releases the slot for a later pass.
 */
export function createSingleFlightBackgroundRunner(
  onError: (error: unknown) => void,
): (task: BackgroundTask) => boolean {
  let running: Promise<void> | null = null;
  return (task) => {
    if (running) return false;
    running = Promise.resolve()
      .then(task)
      .then(() => undefined)
      .catch(onError)
      .finally(() => {
        running = null;
      });
    return true;
  };
}
