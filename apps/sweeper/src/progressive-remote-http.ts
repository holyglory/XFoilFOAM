const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export async function fetchProgressiveRemote(
  fetcher: typeof fetch,
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetcher(input, init);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt >= 2)
      return response;
    await response.arrayBuffer().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
}
