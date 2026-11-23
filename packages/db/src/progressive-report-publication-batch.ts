import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalAnalysisJson } from "./analysis-target";
import type { ProgressiveRemoteReport } from "./progressive-remote-report";

export const MAX_PROGRESSIVE_PUBLICATION_REPORTS = 16;

export interface ProgressiveReportStatusUpdate<
  Status = ProgressiveRemoteReport["status"],
> {
  sequence: number;
  status: Status;
  contentSignature: string;
}

export function sameLiveProgressStatus(
  first: ProgressiveRemoteReport["status"],
  next: ProgressiveRemoteReport["status"],
): boolean {
  if (first.state !== "running" || next.state !== "running") return false;
  const { updated_at: _at, solver_budget_progress: _budget, ...a } = first;
  const {
    updated_at: _nextAt,
    solver_budget_progress: _nextBudget,
    ...b
  } = next;
  return isDeepStrictEqual(a, b);
}

/**
 * Each follower is the original v1 envelope with only sequence and live status
 * changed. Hash the canonical bytes through the unchanged result once. SHA-256
 * state copies yield exactly the normal complete report digest for every suffix.
 */
export function progressiveRepeatedReportSigner(
  anchor: ProgressiveRemoteReport,
) {
  if (
    anchor.status.state !== "running" ||
    anchor.result?.state !== "running" ||
    anchor.stopProof !== null
  )
    throw new Error(
      "Repeated report results require an unstopped running source",
    );
  const keys = (Object.keys(anchor) as (keyof ProgressiveRemoteReport)[]).sort(
    (a, b) => a.localeCompare(b, "en"),
  );
  const split = keys.indexOf("result") + 1;
  const prefixKeys = keys.slice(0, split);
  if (
    !split ||
    prefixKeys.includes("sequence") ||
    prefixKeys.includes("status")
  )
    throw new Error("Unexpected canonical report field order");
  const field = (key: string, value: unknown) =>
    JSON.stringify(key) + ":" + canonicalAnalysisJson(value);
  const prefix = createHash("sha256").update(
    "{" + prefixKeys.map((k) => field(k, anchor[k])).join(","),
    "utf8",
  );
  const tail = keys.slice(split);
  return (
    update: Pick<ProgressiveReportStatusUpdate, "sequence" | "status">,
  ) => {
    const suffix = tail.map((k) =>
      field(
        k,
        k === "sequence"
          ? update.sequence
          : k === "status"
            ? update.status
            : anchor[k],
      ),
    );
    return prefix
      .copy()
      .update("," + suffix.join(",") + "}", "utf8")
      .digest("hex");
  };
}
