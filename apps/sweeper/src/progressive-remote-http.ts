const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(MAX_RETRY_DELAY_MS, seconds * 1000);
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt))
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAt - Date.now()));
  }
  return Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * 2 ** attempt);
}

export async function fetchProgressiveRemote(
  fetcher: typeof fetch,
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetcher(input, init);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES)
      return response;
    await response.arrayBuffer().catch(() => undefined);
    await new Promise((resolve) =>
      setTimeout(resolve, retryDelayMs(response, attempt)),
    );
  }
}
