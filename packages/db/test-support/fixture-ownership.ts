export async function cleanupOwnedFixtureIds(
  identifiers: string[],
  cleanup: (owned: string[]) => PromiseLike<unknown>,
): Promise<void> {
  const owned = new Set(identifiers);
  await cleanup([...owned]);
  const remaining = identifiers.filter((identifier) => !owned.has(identifier));
  identifiers.splice(0, identifiers.length, ...remaining);
}

export function fixtureCleanupLifecycle(cleanup: () => PromiseLike<unknown>) {
  let cleanupNeeded = false;
  let inFlight: Promise<void> | null = null;
  function finishCleanup(): Promise<void> {
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(cleanup)
        .then(() => {
          cleanupNeeded = false;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }
  return {
    async beforeEach() {
      if (cleanupNeeded) await finishCleanup();
      cleanupNeeded = true;
    },
    async afterEach() {
      await finishCleanup();
    },
  };
}
