"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  continueUransResult,
  createPointCorrectedRun,
  getPointStory,
  isAdminApiError,
  requeuePoint,
} from "@/lib/admin";
import {
  pointContinuationGuidance,
  type PointCorrectionSettings,
  type PointStoryPayload,
  recommendedPointCorrections,
} from "@/lib/point-history";
import { pointRepairEligibility } from "@/lib/point-repair";
import { C, MONO } from "@/lib/tokens";
import { PointCorrectionForm } from "../PointCorrectionForm";

const actionButton: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 9.5,
  color: C.muted,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 7,
  padding: "5px 9px",
  cursor: "pointer",
};

export interface CampaignPointEvidenceTarget {
  resultId: string;
  resultAttemptId: string;
  aoaDeg: number;
  sourceAoaDeg: number;
}

export function CampaignPointManagement({
  resultId,
  sourceResultAttemptId,
  campaignId,
  aoaDeg,
  sourceAoaDeg,
  stage,
  onOpenEvidence,
  onChanged,
}: {
  resultId: string;
  sourceResultAttemptId: string | null;
  campaignId: string;
  aoaDeg: number;
  sourceAoaDeg: number;
  stage: "rans" | "fast" | "final";
  onOpenEvidence?: (target: CampaignPointEvidenceTarget) => void;
  onChanged: () => void;
}) {
  const [story, setStory] = useState<PointStoryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"retry" | "continue" | "correct" | null>(
    null,
  );
  const requestSeq = useRef(0);

  const loadStory = useCallback(async () => {
    const seq = ++requestSeq.current;
    setError(null);
    try {
      const next = await getPointStory(resultId);
      if (seq === requestSeq.current) setStory(next);
    } catch (loadError) {
      if (seq === requestSeq.current) setError((loadError as Error).message);
    }
  }, [resultId]);

  useEffect(() => {
    void loadStory();
    return () => {
      requestSeq.current += 1;
    };
  }, [loadStory]);

  const afterAction = useCallback(async () => {
    onChanged();
    await loadStory();
  }, [loadStory, onChanged]);

  const eligibility = pointRepairEligibility(story);
  const guidance = story ? pointContinuationGuidance(story) : null;
  const continuationRelevant =
    story != null &&
    (story.point.regime === "urans" ||
      (story.point.fidelity ?? "").startsWith("urans"));

  const doRequeue = async () => {
    if (!story || busy) return;
    const retry = story.point.status === "failed";
    if (
      !window.confirm(
        retry
          ? `Retry ${story.point.airfoilName} α ${story.point.aoaDeg}° from the normal solve queue? Existing evidence remains unchanged.`
          : `Requeue ${story.point.airfoilName} α ${story.point.aoaDeg}° for a fresh solver attempt? Existing evidence remains unchanged.`,
      )
    )
      return;
    setBusy("retry");
    setNotice(null);
    try {
      const outcome = await requeuePoint(resultId);
      setNotice(`Point requeued (${outcome.scope}).`);
      await afterAction();
    } catch (actionError) {
      setNotice(
        isAdminApiError(actionError)
          ? actionError.message
          : (actionError as Error).message,
      );
    } finally {
      setBusy(null);
    }
  };

  const doContinue = async (extraHours: 2 | 6 | 24) => {
    const resultAttemptId = story?.point.continuationResultAttemptId;
    if (!story || !resultAttemptId || busy) return;
    if (
      !window.confirm(
        `Continue ${story.point.airfoilName} α ${story.point.aoaDeg}° from its verified saved OpenFOAM case with +${extraHours} h? The run resumes at its last written time step.`,
      )
    )
      return;
    setBusy("continue");
    setNotice(null);
    try {
      const outcome = await continueUransResult(
        resultId,
        resultAttemptId,
        extraHours * 3600,
      );
      setNotice(
        outcome.created
          ? `Continuation queued with +${extraHours} h.`
          : `The existing ${outcome.request.state} continuation was reused.`,
      );
      await afterAction();
    } catch (actionError) {
      setNotice(
        isAdminApiError(actionError)
          ? actionError.message
          : (actionError as Error).message,
      );
    } finally {
      setBusy(null);
    }
  };

  const doCorrectedRun = async (
    settings: PointCorrectionSettings,
    fidelity: "precalc" | "full",
  ) => {
    const resultAttemptId =
      sourceResultAttemptId ?? story?.point.resultAttemptId ?? null;
    if (!story || !resultAttemptId || busy) return;
    if (
      !window.confirm(
        `Recalculate ${story.point.airfoilName} α ${story.point.aoaDeg}° from time zero as a fresh ${fidelity === "full" ? "FULL" : "FAST"} URANS case? The failed evidence and campaign setup stay unchanged.`,
      )
    )
      return;
    setBusy("correct");
    setNotice(null);
    try {
      const outcome = await createPointCorrectedRun(resultId, {
        resultAttemptId,
        fidelity,
        ...settings,
      });
      setNotice(
        outcome.created
          ? `Fresh ${fidelity === "full" ? "FULL" : "FAST"} recalculation queued on revision ${outcome.revisionId.slice(0, 8)}…`
          : `The existing ${outcome.request.state} recalculation was reused.`,
      );
      await afterAction();
    } catch (actionError) {
      setNotice(
        isAdminApiError(actionError)
          ? actionError.message
          : (actionError as Error).message,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      data-testid={`campaign-point-management-${aoaDeg}`}
      style={{
        display: "grid",
        gap: 8,
        padding: 9,
        border: `1px solid ${C.tealBorder}`,
        borderRadius: 7,
        background: C.panel,
        fontFamily: MONO,
        fontSize: 9.5,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ color: C.text, fontSize: 10.5 }}>
          Manage failed point
        </strong>
        <span style={{ color: C.dim }}>
          {stage.toUpperCase()} · α {aoaDeg}°
        </span>
      </div>

      {!story && !error && (
        <span role="status" style={{ color: C.dim }}>
          Loading exact point history…
        </span>
      )}
      {error && (
        <div role="alert" style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          <span style={{ color: C.red }}>
            Couldn&apos;t load point controls: {error}
          </span>
          <button
            type="button"
            onClick={() => void loadStory()}
            style={actionButton}
          >
            Try again
          </button>
        </div>
      )}

      {story && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {story.point.viewResultAttemptId && onOpenEvidence && (
              <button
                type="button"
                data-testid="campaign-point-open-evidence"
                onClick={() =>
                  onOpenEvidence({
                    resultId,
                    resultAttemptId: story.point.viewResultAttemptId!,
                    aoaDeg,
                    sourceAoaDeg,
                  })
                }
                style={{
                  ...actionButton,
                  color: C.teal,
                  borderColor: C.tealBorder,
                }}
              >
                Open stored evidence
              </button>
            )}
            {eligibility.requeueEligible && (
              <button
                type="button"
                data-testid="campaign-point-requeue"
                disabled={busy != null}
                onClick={() => void doRequeue()}
                style={{
                  ...actionButton,
                  color: C.amber,
                  borderColor: "rgba(245, 158, 11, 0.4)",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy === "retry"
                  ? "Requeueing…"
                  : eligibility.retryEligible
                    ? "Retry point"
                    : "Requeue point"}
              </button>
            )}
            {eligibility.continueEligible &&
              ([2, 6, 24] as const).map((hours) => (
                <button
                  key={hours}
                  type="button"
                  data-testid={`campaign-point-continue-${hours}h`}
                  disabled={busy != null}
                  onClick={() => void doContinue(hours)}
                  style={{
                    ...actionButton,
                    color: C.violet,
                    borderColor: C.violetBorder,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  {busy === "continue" ? "Queueing…" : `Continue +${hours}h`}
                </button>
              ))}
            <Link
              href={`/admin?section=queue&tab=points&pstatus=unpublished&pcampaign=${encodeURIComponent(campaignId)}`}
              style={{
                ...actionButton,
                color: C.muted,
                textDecoration: "none",
              }}
            >
              Full point history ↗
            </Link>
          </div>

          {continuationRelevant && guidance && (
            <div
              data-testid={
                eligibility.continueEligible
                  ? "campaign-point-continuation-available"
                  : "campaign-point-continuation-unavailable"
              }
              style={{
                display: "grid",
                gap: 3,
                padding: 7,
                border: `1px solid ${C.borderSoft}`,
                borderRadius: 6,
                color: C.muted,
                lineHeight: 1.45,
              }}
            >
              <strong
                style={{
                  color: eligibility.continueEligible ? C.violet : C.muted,
                }}
              >
                {guidance.title}
              </strong>
              <span>{guidance.detail}</span>
              <details>
                <summary style={{ cursor: "pointer" }}>
                  What continuation needs
                </summary>
                <p style={{ margin: "5px 0 0" }}>{guidance.requirement}</p>
              </details>
            </div>
          )}

          {notice && (
            <span
              role="status"
              data-testid="campaign-point-action-notice"
              style={{ color: C.amber }}
            >
              {notice}
            </span>
          )}

          {eligibility.correctionEligible && story.point.correctionSetup && (
            <details data-testid="campaign-point-recalculate">
              <summary
                style={{
                  width: "fit-content",
                  cursor: "pointer",
                  color: C.teal,
                  fontWeight: 700,
                }}
              >
                Recalculate from scratch · refine mesh / solver settings
              </summary>
              <div style={{ marginTop: 8 }}>
                <PointCorrectionForm
                  key={story.point.resultAttemptId}
                  identity={{
                    airfoilName: story.point.airfoilName,
                    aoaDeg: story.point.aoaDeg,
                    reynolds: story.point.reynolds,
                    mach: story.point.mach,
                    speed: story.point.speed,
                  }}
                  source={story.point.correctionSetup}
                  recommended={recommendedPointCorrections(story)}
                  busy={busy === "correct"}
                  onSubmit={(settings, fidelity) =>
                    void doCorrectedRun(settings, fidelity)
                  }
                />
              </div>
            </details>
          )}

          {!eligibility.requeueEligible &&
            !eligibility.continueEligible &&
            !eligibility.correctionEligible && (
              <span style={{ color: C.dim, lineHeight: 1.45 }}>
                This exact result has no safe manual mutation. Its stored
                evidence is still available for diagnosis; automatic work
                remains owned by the scheduler.
              </span>
            )}
        </>
      )}
    </section>
  );
}
