import { setTimeout as delay } from "node:timers/promises";

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
      headers: { accept, "accept-encoding": "identity", "x-xfoilfoam-solver-token": token },
    });
    if (response.status !== 503 || attempt >= 3 ||
        response.headers.get("content-type")?.split(";")[0] !== "application/json")
      return response;
    const bytes = Number(response.headers.get("content-length"));
    const seconds = Number(response.headers.get("retry-after"));
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 1024 ||
        !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 60)
      return response;
    const busy = await response.clone().json().catch(() => null);
    if (busy?.code !== "sync_capacity_busy" || busy.retryAfterMs !== seconds * 1000)
      return response;
    await response.body?.cancel();
    await delay(Math.max(busy.retryAfterMs, 1000 * 2 ** attempt), undefined, { signal });
  }
}
