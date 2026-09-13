import type { RetainedSolverReport } from "@aerodb/core";

export interface RetainedReportFilters {
  airfoil: string;
  campaignId: string;
  includeDelivered: boolean;
  cursor: string;
}

export function retainedReportFilters(search: string): RetainedReportFilters {
  const params = new URLSearchParams(search);
  return {
    airfoil: (params.get("reportAirfoil") ?? "").slice(0, 120),
    campaignId: params.get("reportCampaign") ?? "",
    includeDelivered: params.get("reportDelivered") === "1",
    cursor: params.get("reportCursor") ?? "",
  };
}

export function retainedReportSearch(
  search: string,
  filters: RetainedReportFilters,
) {
  const params = new URLSearchParams(search);
  for (const [name, value] of [
    ["reportAirfoil", filters.airfoil.trim()],
    ["reportCampaign", filters.campaignId],
    ["reportDelivered", filters.includeDelivered ? "1" : ""],
    ["reportCursor", filters.cursor],
  ]) {
    if (value) params.set(name, value);
    else params.delete(name);
  }
  return params.size ? `?${params}` : "";
}

export function retainedReportDownloadPath(
  report: Pick<RetainedSolverReport, "executionId" | "sequence" | "signature">,
) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
      report.executionId,
    ) ||
    !Number.isSafeInteger(report.sequence) ||
    report.sequence < 1 ||
    !/^[a-f0-9]{64}$/.test(report.signature)
  ) {
    throw new Error("Invalid stored report reference");
  }
  return `/api/admin/retained-reports/${report.executionId}/${report.sequence}?signature=${report.signature}`;
}
