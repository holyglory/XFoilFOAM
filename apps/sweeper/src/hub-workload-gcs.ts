import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
/** Hub-only metadata identity. No ADC, key files, impersonation or worker cloud identity. */
export class HubWorkloadGcs {
  constructor(
    protected readonly bucket: string,
    private readonly account: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (
      !/^[a-z0-9][a-z0-9_.-]{1,220}[a-z0-9]$/.test(bucket) ||
      !/^(?:[a-z0-9-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com|[0-9]+-compute@developer\.gserviceaccount\.com)$/.test(
        account,
      )
    )
      throw new Error("Invalid confirmed hub storage configuration");
  }
  private async token() {
    const base =
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/";
    const metadata = async (path: string) => {
      const r = await this.request(base + path, {
        headers: { "Metadata-Flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok || r.headers.get("Metadata-Flavor") !== "Google")
        throw new Error("Canonical hub workload identity unavailable");
      return (await boundedHubBody(r, 16384)).toString("utf8");
    };
    if ((await metadata("email")).trim() !== this.account)
      throw new Error("Canonical hub workload identity differs");
    const value = JSON.parse(await metadata("token"));
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      value.token_type !== "Bearer"
    )
      throw new Error("Invalid hub identity token");
    return value.access_token as string;
  }
  protected async call(url: string, options: RequestInit = {}) {
    return this.request(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: {
        ...options.headers,
        Authorization: `Bearer ${await this.token()}`,
        "Accept-Encoding": "identity",
      },
    });
  }
  protected url(key: string, generation?: string) {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
    );
    if (generation) url.searchParams.set("generation", generation);
    return url;
  }
}
export async function boundedHubBody(response: Response, max: number) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new HistoryOperationError(
      "hub_storage",
      response.status === 429 || response.status >= 500
        ? "transport"
        : response.status === 401 || response.status === 403
          ? "denied"
          : "integrity",
      response.status === 429 || response.status >= 500,
    );
  }
  if (!response.body) throw new Error("Hub history body missing");
  const reader = response.body.getReader(),
    chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.length;
      if (size > max) throw new Error("Hub history response exceeds bound");
      chunks.push(Buffer.from(value.value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
