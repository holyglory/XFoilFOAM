import type { Sql } from "@aerodb/db";

export async function runNotificationDrain(
  notifications: Pick<Sql, "listen">,
  channel: string,
  signal: AbortSignal,
  options: {
    drain: () => Promise<boolean>;
    reportError: (error: unknown) => void;
    nextWakeAt?: () => Promise<Date | null>;
  },
): Promise<void> {
  if (signal.aborted) return;
  let pending = true;
  let wake: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryNotBefore = 0;
  let unlisten: (() => Promise<void>) | null = null;
  const notify = () => {
    pending = true;
    if (signal.aborted || Date.now() >= retryNotBefore) wake?.();
  };
  signal.addEventListener("abort", notify);
  try {
    const subscription = await notifications.listen(channel, notify, notify);
    unlisten = () => subscription.unlisten();
    while (!signal.aborted) {
      if (!pending || Date.now() < retryNotBefore)
        await new Promise<void>((resolve) => {
          wake = resolve;
          if ((pending && Date.now() >= retryNotBefore) || signal.aborted)
            resolve();
        });
      wake = null;
      pending = false;
      if (retry) clearTimeout(retry);
      retry = null;
      retryNotBefore = 0;
      if (signal.aborted) break;
      try {
        if (await options.drain()) pending = true;
        else if (options.nextWakeAt && !signal.aborted) {
          const deadline = await options.nextWakeAt();
          if (deadline && !signal.aborted && !pending) {
            if (!Number.isFinite(deadline.getTime()))
              throw new Error(
                "Notification drain received an invalid retry deadline",
              );
            retry = setTimeout(
              notify,
              Math.min(
                2147483647,
                Math.max(0, deadline.getTime() - Date.now()),
              ),
            );
          }
        }
      } catch (error) {
        options.reportError(error);
        if (!signal.aborted) {
          retryNotBefore = Date.now() + 100;
          pending = false;
          retry = setTimeout(notify, 100);
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", notify);
    if (retry) clearTimeout(retry);
    await unlisten?.();
  }
}
