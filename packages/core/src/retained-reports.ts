export interface RetainedSolverReport {
  executionId: string;
  sequence: number;
  signature: string;
  receivedAt: string;
  airfoilSlug: string;
  airfoilName: string;
  campaignId: string | null;
  campaignName: string | null;
  reynolds: number | null;
  mach: number | null;
  angles: number[];
  sourceCount: number;
  receivedSourceCount: number;
  jobStatus: string;
  recovery: { queuedAngles: number; claimedAngles: number };
}

export interface RetainedSolverReportPage {
  items: RetainedSolverReport[];
  nextCursor: string | null;
}
