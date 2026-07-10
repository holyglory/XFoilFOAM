import type { SimulationDetail } from "@aerodb/core";

import { solverWorkPointKey, type SolverWorkCondition, type SolverWorkPoint } from "./solver-work";

export type ResultReviewVerdict = "waive" | "exclude" | "defer";

export interface ResultReviewGate {
  name: string;
  detail: string;
  pass: boolean;
}

export interface ResultReviewRecord {
  id?: string;
  verdict: ResultReviewVerdict;
  note: string | null;
  reviewer: string | null;
  createdAt: string;
  revokedAt?: string | null;
}

export type SimulationDetailWithReview = SimulationDetail & {
  gates?: ResultReviewGate[] | null;
};

export interface GateChecklistLine {
  key: string;
  text: string;
  pass: boolean;
}

export interface ReviewQueueItem {
  key: string;
  condition: SolverWorkCondition;
  point: SolverWorkPoint;
  resultId: string;
  re: number;
  aoa: number;
}

export interface SimModalReviewContext {
  admin: boolean;
  condition: SolverWorkCondition;
  point: SolverWorkPoint;
  queue: ReviewQueueItem[];
  onOpenQueueItem: (item: ReviewQueueItem) => void;
  onRefresh: () => void | Promise<void>;
  onContinue6h?: () => boolean | void | Promise<boolean | void>;
  onRequestFull?: () => boolean | void | Promise<boolean | void>;
}

export interface ReviewStepperView {
  label: string;
  nextLabel: "review next ▸";
  currentIndex: number;
  total: number;
  next: ReviewQueueItem;
}

export function resultReviewGates(sim: SimulationDetail | null | undefined): ResultReviewGate[] {
  const gates = (sim as SimulationDetailWithReview | null | undefined)?.gates;
  return Array.isArray(gates)
    ? gates.filter((gate): gate is ResultReviewGate => typeof gate?.name === "string" && typeof gate.detail === "string" && typeof gate.pass === "boolean")
    : [];
}

export function gateChecklistView(gates: ResultReviewGate[] | null | undefined): GateChecklistLine[] {
  if (!gates?.length) return [];
  return gates.map((gate, index) => ({
    key: `${gate.name}:${index}`,
    text: `${gate.pass ? "✓" : "✗"} ${gate.name} — ${gate.detail}`,
    pass: gate.pass,
  }));
}

export function isReviewLayerPoint(point: SolverWorkPoint | null | undefined): boolean {
  if (!point) return false;
  if (point.state === "needs_review" || point.state === "excluded") return true;
  return point.reviewed?.verdict === "waive" || point.reviewed?.verdict === "exclude";
}

export function shouldShowReviewLayer(admin: boolean, point: SolverWorkPoint | null | undefined): boolean {
  return admin && isReviewLayerPoint(point);
}

export function reviewVerdictRequiresNote(verdict: ResultReviewVerdict): boolean {
  return verdict === "waive" || verdict === "exclude";
}

export function canSubmitResultReview(verdict: ResultReviewVerdict, note: string): boolean {
  return !reviewVerdictRequiresNote(verdict) || note.trim().length > 0;
}

export function buildResultReviewPayload(verdict: ResultReviewVerdict, note: string): { verdict: ResultReviewVerdict; note?: string } {
  const trimmed = note.trim();
  return trimmed ? { verdict, note: trimmed } : { verdict };
}

export function buildReviewQueue(conditions: SolverWorkCondition[]): ReviewQueueItem[] {
  return conditions.flatMap((condition) =>
    condition.points
      .filter((point) => point.state === "needs_review" && !!point.resultId)
      .slice()
      .sort((a, b) => a.aoaDeg - b.aoaDeg)
      .map((point) => ({
        key: solverWorkPointKey(condition, point),
        condition,
        point,
        resultId: point.resultId!,
        re: condition.reynolds,
        aoa: point.aoaDeg,
      })),
  );
}

export function reviewStepperView(queue: ReviewQueueItem[], currentResultId: string | null | undefined): ReviewStepperView | null {
  if (queue.length <= 1 || !currentResultId) return null;
  const currentIndex = queue.findIndex((item) => item.resultId === currentResultId);
  if (currentIndex < 0) return null;
  const next = queue[(currentIndex + 1) % queue.length];
  return {
    label: `${currentIndex + 1} of ${queue.length} in queue`,
    nextLabel: "review next ▸",
    currentIndex,
    total: queue.length,
    next,
  };
}

export function resultReviewPastTense(verdict: ResultReviewVerdict): string {
  if (verdict === "waive") return "waived";
  if (verdict === "exclude") return "excluded";
  return "deferred";
}

export function formatResultReviewDate(iso: string): string {
  return iso ? iso.slice(0, 10) : "unknown date";
}

export function formatResultReviewLine(review: Pick<ResultReviewRecord, "verdict" | "note" | "reviewer" | "createdAt" | "revokedAt">): string {
  const note = review.note?.trim();
  return `${resultReviewPastTense(review.verdict)} by ${review.reviewer || "unknown"} · ${formatResultReviewDate(review.createdAt)}${review.revokedAt ? " · revoked" : ""}${note ? `: ${note}` : ""}`;
}

export function latestResultReviewLine(items: ResultReviewRecord[]): string | null {
  if (!items.length) return null;
  const latest = items
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  return formatResultReviewLine(latest);
}
