import { setTimeout as delay } from "node:timers/promises";

export const WORKER_REPORT_TRANSFER_TIMEOUT_MS = 10 * 60_000;

/** Recognize only the hub's bounded, internally consistent admission response. */
export async function registeredArchiveAdmissionDelay(response: Response): Promise<number | null> {
  if (response.status !== 503 || response.headers.get("content-type")?.split(";")[0] !== "application/json")
    return null;
  const bytes = Number(response.headers.get("content-length"));
  const seconds = Number(response.headers.get("retry-after"));
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 1024 ||
      !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 60)
    return null;
  const busy: unknown = await response.clone().json().catch(() => null);
  if (typeof busy !== "object" || busy === null ||
      !("code" in busy) || busy.code !== "sync_capacity_busy" ||
      !("retryAfterMs" in busy) || busy.retryAfterMs !== seconds * 1000)
    return null;
  return seconds * 1000;
}

/** Read from an already authenticated owner URL and yield to the hub's sync admission limit. */
export async function readRegisteredArchive(
  url: string,
  token: string,
  signal: AbortSignal,
  accept: "application/json" | "application/zstd",
) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      redirect: "error",
      signal,
      headers: {
        accept,
        "accept-encoding": "identity",
        "x-xfoilfoam-solver-token": token,
      },
    });
    if (attempt >= 3) return response;
    const retryAfterMs = await registeredArchiveAdmissionDelay(response);
    if (retryAfterMs === null) return response;
    await response.body?.cancel();
    await delay(Math.max(retryAfterMs, 1000 * 2 ** attempt), undefined, {
      signal,
    });
  }
}
