export async function runSweeperServices(
  signal: AbortSignal,
  services: Array<{
    name: string;
    run: (signal: AbortSignal) => Promise<void>;
  }>,
): Promise<void> {
  if (signal.aborted) return;
  const lifecycle = new AbortController();
  const stop = () => lifecycle.abort();
  signal.addEventListener("abort", stop, { once: true });
  const running = services.map(async (service) => {
    await service.run(lifecycle.signal);
    if (!lifecycle.signal.aborted)
      throw new Error(
        `Required sweeper service stopped before shutdown: ${service.name}`,
      );
  });
  try {
    await Promise.all(running);
  } finally {
    stop();
    await Promise.allSettled(running);
    signal.removeEventListener("abort", stop);
  }
}
