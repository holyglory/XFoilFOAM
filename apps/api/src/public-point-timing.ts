import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";

export type PointStage =
  | "airfoil"
  | "selection"
  | "attemptFields"
  | "fullOriginal"
  | "review"
  | "media"
  | "scales"
  | "artifacts"
  | "forceRow"
  | "forceHistory"
  | "setup"
  | "verification";

interface ReadTimes {
  stagesMs: Partial<Record<PointStage, number>>;
  storage: {
    operation: string;
    headersMs: number;
    bodyMs: number;
    bytes: number | null;
  }[];
}
const active = new AsyncLocalStorage<ReadTimes>();

/** Other callers of the shared assembler keep their normal execution context. */
export async function pointStage<T>(
  stage: PointStage,
  query: PromiseLike<T>,
): Promise<T> {
  const trace = active.getStore();
  if (!trace) return query;
  const start = performance.now();
  try {
    return await query;
  } finally {
    trace.stagesMs[stage] =
      (trace.stagesMs[stage] ?? 0) + Math.round(performance.now() - start);
  }
}

export async function timePointRead<T>(run: () => Promise<T>) {
  const trace: ReadTimes = { stagesMs: {}, storage: [] };
  const start = performance.now();
  const value = await active.run(trace, run);
  return { value, trace, assemblyMs: Math.round(performance.now() - start) };
}

/** Install only in the point reader. Keep object names, generations, request
 * headers, query text and content out of the request log. */
export function observePointStorage(): void {
  channel("http.client.request.start").subscribe((message) => {
    const trace = active.getStore();
    if (!trace) return;
    const req = (message as { request: ClientRequest }).request;
    const host = req.getHeader("host");
    if (
      typeof host !== "string" ||
      !/^(?:[a-z0-9.-]+\.)?storage\.googleapis\.com(?::443)?$/.test(host)
    )
      return;
    const path = req.path.toLowerCase();
    const kind = path.includes("solver-histor")
      ? "force"
      : path.includes("result-histor")
        ? "field"
        : path.includes("attempt-evidence")
          ? "fullOriginal"
          : undefined;
    if (!kind) return;
    const operation =
      kind +
      (path.includes("alt=media") || path.includes("/download/")
        ? "Media"
        : "Metadata");
    const start = performance.now();
    req.once("response", (response: IncomingMessage) => {
      const headers = performance.now();
      response.once("end", () => {
        const length = response.headers["content-length"];
        trace.storage.push({
          operation,
          headersMs: Math.round(headers - start),
          bodyMs: Math.round(performance.now() - headers),
          bytes: length === undefined ? null : Number(length),
        });
      });
    });
  });
}
