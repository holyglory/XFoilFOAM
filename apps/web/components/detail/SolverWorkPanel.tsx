"use client";

import { type CSSProperties, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { adminMe, continueUransResult, deleteResultReview, isAdminApiError, requestUrans, requeuePoint } from "@/lib/admin";
import { getSolverWork } from "@/lib/api";
import { buildReviewQueue, type ReviewQueueItem, type SimModalReviewContext } from "@/lib/result-review";
import {
  buildSolverWorkConditionSummary,
  buildSolverWorkPopoverView,
  conditionHasSolving,
  filterSortSolverWorkConditions,
  formatAoa,
  formatCompactNumber,
  formatReynolds,
  SOLVER_WORK_STATE_STYLES,
  solverWorkLegendStates,
  solverWorkPointKey,
  solverWorkPointPresentation,
  solverWorkResultContext,
  solverWorkRollup,
  solverWorkStateClass,
  type SolverWorkCondition,
  type SolverWorkFilter,
  type SolverWorkJob,
  type SolverWorkPoint,
  type SolverWorkPointState,
  type SolverWorkPopoverAction,
  type SolverWorkPopoverView,
  type SolverWorkResultContext,
  type SolverWorkSort,
} from "@/lib/solver-work";
import { C, MONO } from "@/lib/tokens";

const smallBtn: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  color: C.muted,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 7,
  padding: "4px 9px",
  cursor: "pointer",
};

const chipBtn: CSSProperties = {
  ...smallBtn,
  borderRadius: 999,
  padding: "4px 10px",
  whiteSpace: "nowrap",
};

const selectStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  color: C.text,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 7,
  padding: "5px 7px",
};

type OpenPoint = {
  conditionKey: string;
  pointKey: string;
  position: CSSProperties;
};

export function SolverWorkPanel({
  slug,
  airfoilId,
  revisionId,
  onOpenResult,
}: {
  slug: string;
  airfoilId: string;
  revisionId?: string | null;
  onOpenResult: (ctx: SolverWorkResultContext, review?: SimModalReviewContext | null) => void;
}) {
  const [conditions, setConditions] = useState<SolverWorkCondition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SolverWorkFilter>("all");
  const [sort, setSort] = useState<SolverWorkSort>("re-asc");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [showSuperseded, setShowSuperseded] = useState<Record<string, boolean>>({});
  const [engineOpen, setEngineOpen] = useState<Record<string, boolean>>({});
  const [openPoint, setOpenPoint] = useState<OpenPoint | null>(null);
  const [compactPopover, setCompactPopover] = useState(false);
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [optimisticStates, setOptimisticStates] = useState<Record<string, SolverWorkPointState>>({});
  const popoverRef = useRef<HTMLDivElement>(null);
  const latestConditionsRef = useRef<SolverWorkCondition[]>([]);

  const refresh = useCallback(
    async (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true);
      setError(null);
      try {
        const payload = await getSolverWork(slug, revisionId);
        latestConditionsRef.current = payload.conditions;
        setConditions(payload.conditions);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        if (!opts?.quiet) setLoading(false);
      }
    },
    [slug, revisionId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    adminMe()
      .then((me) => {
        if (!cancelled) setAdminAuthed(!!me.authed);
      })
      .catch(() => {
        if (!cancelled) setAdminAuthed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setExpandedGroups((prev) => {
      const next: Record<string, boolean> = {};
      for (const condition of conditions) {
        next[condition.presetRevisionId] = prev[condition.presetRevisionId] ?? condition.attentionCount > 0;
      }
      return next;
    });
  }, [conditions]);

  useEffect(() => {
    const update = () => setCompactPopover(window.innerWidth <= 640);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!openPoint) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPoint(null);
    };
    const onMouseDown = (e: globalThis.MouseEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-solver-point-badge]")) return;
      const popover = popoverRef.current;
      if (popover && e.target instanceof Node && popover.contains(e.target)) return;
      setOpenPoint(null);
    };
    const onScroll = () => setOpenPoint(null);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [openPoint]);

  const optimisticConditions = useMemo(
    () =>
      conditions.map((condition) => ({
        ...condition,
        points: condition.points.map((point) => {
          const state = optimisticStates[solverWorkPointKey(condition, point)];
          return state ? { ...point, state } : point;
        }),
      })),
    [conditions, optimisticStates],
  );

  useEffect(() => {
    latestConditionsRef.current = optimisticConditions;
  }, [optimisticConditions]);

  const filteredConditions = useMemo(
    () => filterSortSolverWorkConditions(optimisticConditions, filter, sort),
    [optimisticConditions, filter, sort],
  );

  const attentionGroups = optimisticConditions.filter((condition) => condition.attentionCount > 0).length;
  const solvingGroups = optimisticConditions.filter(conditionHasSolving).length;
  const totalJobs = optimisticConditions.reduce((sum, condition) => sum + condition.jobs.length, 0);

  const openContext = useMemo(() => {
    if (!openPoint) return null;
    const condition = optimisticConditions.find((item) => item.presetRevisionId === openPoint.conditionKey);
    if (!condition) return null;
    const point = condition.points.find((item) => solverWorkPointKey(condition, item) === openPoint.pointKey);
    if (!point) return null;
    return { condition, point };
  }, [openPoint, optimisticConditions]);

  const openBadge = useCallback((e: MouseEvent<HTMLButtonElement>, condition: SolverWorkCondition, point: SolverWorkPoint) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setActionNotice(null);
    setOpenPoint({
      conditionKey: condition.presetRevisionId,
      pointKey: solverWorkPointKey(condition, point),
      position: popoverPosition(rect),
    });
  }, []);

  const optimisticFlip = useCallback((condition: SolverWorkCondition, point: SolverWorkPoint, state: SolverWorkPointState) => {
    setOptimisticStates((prev) => ({ ...prev, [solverWorkPointKey(condition, point)]: state }));
  }, []);

  const runContinue = useCallback(
    async (condition: SolverWorkCondition, point: SolverWorkPoint, hours: 2 | 6 | 24) => {
      if (!point.resultId || busyAction) return false;
      if (
        !window.confirm(
          `Continue this URANS solve (α ${formatAoa(point.aoaDeg)}) from its saved case state with a +${hours} h wall-clock budget? It resumes from the last written time step (no work is redone) and re-enters the queue at precalc rank.`,
        )
      )
        return false;
      setBusyAction(`continue-${hours}h`);
      setActionNotice(null);
      try {
        const res = await continueUransResult(point.resultId, hours * 3600);
        optimisticFlip(condition, point, res.request.state === "running" ? "solving" : "queued");
        setActionNotice(
          res.created
            ? `continuation queued (+${hours} h) — resumes from the saved case state after all RANS gaps`
            : `already queued — the open continuation request is reused (${res.request.state})`,
        );
        void refresh({ quiet: true });
        return true;
      } catch (e) {
        setActionNotice(isAdminApiError(e) ? e.message : (e as Error).message);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, optimisticFlip, refresh],
  );

  const runRetry = useCallback(
    async (condition: SolverWorkCondition, point: SolverWorkPoint) => {
      if (!point.resultId || busyAction) return;
      if (!window.confirm(`Retry this point (α ${formatAoa(point.aoaDeg)})? The evidence returns to the solve queue for a fresh attempt.`)) return;
      setBusyAction("retry");
      setActionNotice(null);
      try {
        const res = await requeuePoint(point.resultId);
        optimisticFlip(condition, point, "queued");
        setActionNotice(`requeued (${res.scope}) — the point is back in the queue`);
        void refresh({ quiet: true });
      } catch (e) {
        setActionNotice(isAdminApiError(e) ? e.message : (e as Error).message);
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, optimisticFlip, refresh],
  );

  const runRequestFull = useCallback(
    async (condition: SolverWorkCondition, point: SolverWorkPoint) => {
      if (busyAction) return false;
      if (
        !window.confirm(
          `Queue a full-fidelity URANS solve for α ${formatAoa(point.aoaDeg)}? Full mesh, 7 shedding periods, 12 h budget. It runs after all RANS gaps, at precalc rank.`,
        )
      )
        return false;
      setBusyAction("request-full-tier");
      setActionNotice(null);
      try {
        const res = await requestUrans({
          airfoilId,
          revisionId: condition.presetRevisionId,
          aoaDeg: point.aoaDeg,
          fidelity: "full",
        });
        optimisticFlip(condition, point, res.request.state === "running" ? "solving" : "queued");
        setActionNotice(
          res.created
            ? "URANS full requested — scheduled after all RANS gaps"
            : `already requested — the open full request is reused (${res.request.state})`,
        );
        void refresh({ quiet: true });
        return true;
      } catch (e) {
        setActionNotice(isAdminApiError(e) ? e.message : (e as Error).message);
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [airfoilId, busyAction, optimisticFlip, refresh],
  );

  const runRevokeReview = useCallback(
    async (condition: SolverWorkCondition, point: SolverWorkPoint) => {
      if (!point.resultId || busyAction) return;
      setBusyAction("revoke-review");
      setActionNotice(null);
      try {
        await deleteResultReview(point.resultId);
        setActionNotice("review revoked — solver work refreshed");
        void refresh({ quiet: true });
      } catch (e) {
        setActionNotice(isAdminApiError(e) ? e.message : (e as Error).message);
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, refresh],
  );

  const openResultWithReview = useCallback(
    (condition: SolverWorkCondition, point: SolverWorkPoint) => {
      const ctx = solverWorkResultContext(condition, point);
      if (!ctx) return;
      const makeReviewContext = (reviewCondition: SolverWorkCondition, reviewPoint: SolverWorkPoint): SimModalReviewContext => ({
        admin: adminAuthed,
        condition: reviewCondition,
        point: reviewPoint,
        queue: buildReviewQueue(latestConditionsRef.current),
        onOpenQueueItem: (item: ReviewQueueItem) => {
          const latestItem = buildReviewQueue(latestConditionsRef.current).find((candidate) => candidate.resultId === item.resultId) ?? item;
          const nextCtx = solverWorkResultContext(latestItem.condition, latestItem.point);
          if (nextCtx) onOpenResult(nextCtx, makeReviewContext(latestItem.condition, latestItem.point));
        },
        onRefresh: () => refresh({ quiet: true }),
        onContinue6h: () => runContinue(reviewCondition, reviewPoint, 6),
        onRequestFull: () => runRequestFull(reviewCondition, reviewPoint),
      });
      onOpenResult(ctx, makeReviewContext(condition, point));
    },
    [adminAuthed, onOpenResult, refresh, runContinue, runRequestFull],
  );

  return (
    <section data-testid="solver-work-panel" style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 16px",
          borderBottom: `1px solid ${C.borderSoft}`,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim, letterSpacing: "0.12em" }}>SOLVER WORK</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>
            {optimisticConditions.length} condition{optimisticConditions.length === 1 ? "" : "s"} · {totalJobs} engine job{totalJobs === 1 ? "" : "s"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {([
            ["all", `All ${optimisticConditions.length}`],
            ["attention", `Attention ${attentionGroups}`],
            ["solving", `Solving ${solvingGroups}`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              data-testid={`solver-work-filter-${key}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              style={{
                ...chipBtn,
                color: filter === key ? C.teal : C.muted,
                borderColor: filter === key ? C.tealBorder : C.stroke,
                background: filter === key ? C.tealFill : C.panel3,
              }}
            >
              {label}
            </button>
          ))}
          <select
            data-testid="solver-work-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SolverWorkSort)}
            style={selectStyle}
            aria-label="Sort solver work"
          >
            <option value="re-asc">Re ↑</option>
            <option value="attention-first">attention first</option>
            <option value="recent">recent</option>
          </select>
        </div>
      </div>

      {error && (
        <div style={{ padding: "12px 16px", fontFamily: MONO, fontSize: 11, color: C.redText, borderBottom: `1px solid ${C.borderRow}` }}>
          {error}
          <button type="button" onClick={() => void refresh()} style={{ ...smallBtn, marginLeft: 8 }}>
            retry
          </button>
        </div>
      )}
      {loading && !conditions.length && !error ? (
        <div style={{ padding: "14px 16px", fontFamily: MONO, fontSize: 11, color: C.muted }}>Loading solver work…</div>
      ) : filteredConditions.length === 0 && !error ? (
        <div style={{ padding: "14px 16px", fontFamily: MONO, fontSize: 11, color: C.muted }}>No solver work matches this filter.</div>
      ) : (
        <div style={{ display: "grid" }}>
          {filteredConditions.map((condition) => {
            const key = condition.presetRevisionId;
            return (
              <ConditionGroup
                key={key}
                condition={condition}
                expanded={!!expandedGroups[key]}
                showSuperseded={!!showSuperseded[key]}
                engineOpen={!!engineOpen[key]}
                onToggleExpanded={() => setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }))}
                onToggleSuperseded={() => setShowSuperseded((prev) => ({ ...prev, [key]: !prev[key] }))}
                onToggleEngine={() => setEngineOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
                onBadge={openBadge}
              />
            );
          })}
        </div>
      )}

      {openContext && openPoint && (
        <div
          ref={popoverRef}
          data-testid="point-popover"
          role="dialog"
          aria-label={`Solver point ${formatAoa(openContext.point.aoaDeg)}`}
          style={
            compactPopover
              ? {
                  position: "fixed",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 60,
                  background: C.popover,
                  borderTop: `1px solid ${C.stroke}`,
                  boxShadow: `0 -18px 45px ${C.shadow}`,
                  padding: 12,
                }
              : openPoint.position
          }
        >
          <PointPopoverBody
            view={buildSolverWorkPopoverView(openContext.condition, openContext.point, adminAuthed)}
            busyAction={busyAction}
            actionNotice={actionNotice}
            onOpenResults={() => {
              openResultWithReview(openContext.condition, openContext.point);
            }}
            onContinue={(hours) => void runContinue(openContext.condition, openContext.point, hours)}
            onRetry={() => void runRetry(openContext.condition, openContext.point)}
            onRequestFull={() => void runRequestFull(openContext.condition, openContext.point)}
            onRevokeReview={() => void runRevokeReview(openContext.condition, openContext.point)}
          />
        </div>
      )}
    </section>
  );
}

function ConditionGroup({
  condition,
  expanded,
  showSuperseded,
  engineOpen,
  onToggleExpanded,
  onToggleSuperseded,
  onToggleEngine,
  onBadge,
}: {
  condition: SolverWorkCondition;
  expanded: boolean;
  showSuperseded: boolean;
  engineOpen: boolean;
  onToggleExpanded: () => void;
  onToggleSuperseded: () => void;
  onToggleEngine: () => void;
  onBadge: (e: MouseEvent<HTMLButtonElement>, condition: SolverWorkCondition, point: SolverWorkPoint) => void;
}) {
  const summary = buildSolverWorkConditionSummary(condition);
  const visiblePoints = showSuperseded ? condition.points : condition.points.filter((point) => point.state !== "superseded");
  const supersededCount = condition.points.length - condition.points.filter((point) => point.state !== "superseded").length;
  const rollup = solverWorkRollup(condition.points, showSuperseded);
  const legend = solverWorkLegendStates(condition.points, showSuperseded);
  return (
    <article data-testid="solver-work-condition" style={{ borderBottom: `1px solid ${C.borderRow}`, minWidth: 0 }}>
      <button
        type="button"
        data-testid="solver-work-condition-header"
        aria-expanded={expanded}
        onClick={onToggleExpanded}
        style={{
          width: "100%",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          gap: 12,
          textAlign: "left",
          alignItems: "center",
          background: "transparent",
          border: 0,
          padding: "12px 16px",
          cursor: "pointer",
          color: C.text,
        }}
      >
        <span style={{ display: "grid", gap: 5, minWidth: 0 }}>
          <span style={{ fontFamily: MONO, fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <span aria-hidden style={{ color: C.dim, marginRight: 6 }}>
              {expanded ? "▾" : "▸"}
            </span>
            <strong style={{ color: C.violet, fontWeight: 800 }}>Re {summary.titleParts.reynolds}</strong> · M {summary.titleParts.mach} · c {summary.titleParts.chord} · {summary.titleParts.speed}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>{summary.meta}</span>
          <RollupBar segments={rollup} />
        </span>
        <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "3px 8px" }}>
            {summary.countLabel}
          </span>
          {summary.attentionLabel && (
            <span style={{ fontFamily: MONO, fontSize: 10, color: C.amber, border: "1px solid rgba(245,158,11,0.45)", borderRadius: 999, padding: "3px 8px", background: "rgba(245,158,11,0.08)" }}>
              {summary.attentionLabel}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "0 16px 14px", display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {visiblePoints.map((point) => (
              <PointBadge key={solverWorkPointKey(condition, point)} condition={condition} point={point} onClick={onBadge} />
            ))}
            {supersededCount > 0 && (
              <button type="button" data-testid="solver-work-superseded-toggle" onClick={onToggleSuperseded} style={{ ...chipBtn, color: C.dim }}>
                {showSuperseded ? "hide superseded" : `show superseded ${supersededCount}`}
              </button>
            )}
          </div>
          {legend.length > 0 && (
            <div data-testid="solver-work-legend" style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {legend.map((state) => (
                <StatePill key={state} state={state} compact />
              ))}
            </div>
          )}
          {condition.jobs.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              <button type="button" data-testid="solver-work-engine-toggle" onClick={onToggleEngine} style={{ ...smallBtn, width: "fit-content" }}>
                {engineOpen ? "▾" : "▸"} engine jobs ({condition.jobs.length})
              </button>
              {engineOpen && (
                <div style={{ background: C.panel2, border: `1px solid ${C.borderSoft}`, borderRadius: 9, overflow: "hidden" }}>
                  {condition.jobs.map((job) => (
                    <EngineJobRow key={job.id} work={job} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function PointBadge({
  condition,
  point,
  onClick,
}: {
  condition: SolverWorkCondition;
  point: SolverWorkPoint;
  onClick: (e: MouseEvent<HTMLButtonElement>, condition: SolverWorkCondition, point: SolverWorkPoint) => void;
}) {
  const presentation = solverWorkPointPresentation(point);
  const style = SOLVER_WORK_STATE_STYLES[presentation.visualState];
  return (
    <button
      type="button"
      data-testid="solver-work-point-badge"
      data-solver-point-badge
      data-state={presentation.visualState}
      data-reviewed={presentation.badgeMark ? "true" : undefined}
      className={solverWorkStateClass(presentation.visualState)}
      onClick={(e) => onClick(e, condition, point)}
      style={{
        position: "relative",
        fontFamily: MONO,
        fontSize: 10,
        color: style.color,
        background: style.background,
        border: `1px solid ${style.border}`,
        borderRadius: 999,
        minWidth: 48,
        height: 26,
        padding: "0 9px",
        cursor: "pointer",
      }}
    >
      {formatAoa(point.aoaDeg)}
      {presentation.badgeMark && (
        <span
          aria-label="reviewed"
          style={{
            position: "absolute",
            top: -5,
            right: -3,
            minWidth: 14,
            height: 14,
            borderRadius: 999,
            display: "grid",
            placeItems: "center",
            fontSize: 9,
            lineHeight: 1,
            color: C.tealInk,
            background: C.teal,
            border: `1px solid ${C.tealBorder}`,
          }}
        >
          {presentation.badgeMark}
        </span>
      )}
    </button>
  );
}

function RollupBar({ segments }: { segments: ReturnType<typeof solverWorkRollup> }) {
  return (
    <span data-testid="solver-work-rollup" style={{ display: "flex", height: 5, width: "min(260px, 100%)", borderRadius: 999, overflow: "hidden", background: C.panel3 }}>
      {segments.map((segment) => (
        <span
          key={segment.state}
          data-state={segment.state}
          title={`${segment.style.label} ${segment.count}`}
          style={{ width: `${segment.percent}%`, background: segment.style.color }}
        />
      ))}
    </span>
  );
}

function StatePill({ state, compact = false, label }: { state: SolverWorkPointState; compact?: boolean; label?: string }) {
  const style = SOLVER_WORK_STATE_STYLES[state];
  return (
    <span
      className={solverWorkStateClass(state)}
      style={{
        fontFamily: MONO,
        fontSize: compact ? 9 : 10,
        color: style.color,
        border: `1px solid ${style.border}`,
        background: style.background,
        borderRadius: 999,
        padding: compact ? "2px 7px" : "3px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {label ?? style.label}
    </span>
  );
}

export function PointPopoverBody({
  view,
  busyAction,
  actionNotice,
  onOpenResults,
  onContinue,
  onRetry,
  onRequestFull,
  onRevokeReview,
}: {
  view: SolverWorkPopoverView;
  busyAction?: string | null;
  actionNotice?: string | null;
  onOpenResults: () => void;
  onContinue: (hours: 2 | 6 | 24) => void;
  onRetry: () => void;
  onRequestFull: () => void;
  onRevokeReview: () => void;
}) {
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const resultAction = view.actions.find((action) => action.kind === "open-results");
  const adminActions = view.actions.filter((action) => action.adminOnly && action.kind !== "revoke-review");
  const revokeAction = view.actions.find((action) => action.kind === "revoke-review");
  return (
    <div style={{ width: "min(360px, calc(100vw - 24px))", display: "grid", gap: 10, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontFamily: MONO, fontSize: 13, color: C.text }}>{view.title}</strong>
        <StatePill state={view.visualState} label={view.stateLabel} />
      </div>
      {view.reviewedDisclosure && (
        <div data-testid="solver-work-reviewed-disclosure" style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted, lineHeight: 1.45, border: `1px solid ${C.stroke}`, background: C.panel2, borderRadius: 8, padding: "7px 8px" }}>
          {view.reviewedDisclosure}
        </div>
      )}
      {view.plain && <div style={{ fontSize: 12, color: C.text2, lineHeight: 1.45 }}>{view.plain}</div>}
      {view.gate && (
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted, lineHeight: 1.45, border: `1px solid ${C.stroke}`, background: C.panel3, borderRadius: 8, padding: "7px 8px" }}>
          <strong style={{ color: C.text }}>{view.gate.name}</strong> {view.gate.detail}
        </div>
      )}
      {view.coefficients.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {view.coefficients.map((item) => (
            <span key={item.label} style={{ fontFamily: MONO, fontSize: 10, color: C.muted, background: C.panel3, border: `1px solid ${C.stroke}`, borderRadius: 7, padding: "4px 7px" }}>
              <span style={{ color: C.dim }}>{item.label}</span> <span style={{ color: C.text }}>{item.value}</span>
            </span>
          ))}
          {view.provisionalNote && <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.amber }}>provisional means</span>}
        </div>
      )}
      {view.chain.length > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {view.chain.map((item, index) => (
            <span
              key={`${item.label}-${index}`}
              style={{
                fontFamily: MONO,
                fontSize: 9,
                color: item.style.color,
                border: `1px solid ${item.style.border}`,
                background: item.style.background,
                borderRadius: 999,
                padding: "2px 7px",
              }}
            >
              {item.label}
            </span>
          ))}
        </div>
      )}
      {(resultAction || adminActions.length > 0) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {resultAction && (
            <PopoverActionButton action={resultAction} busyAction={busyAction} onClick={onOpenResults} />
          )}
          {adminActions.map((action) => (
            <PopoverActionButton
              key={action.kind}
              action={action}
              busyAction={busyAction}
              onClick={() => {
                if (action.kind === "continue-2h") onContinue(2);
                else if (action.kind === "continue-6h") onContinue(6);
                else if (action.kind === "continue-24h") onContinue(24);
                else if (action.kind === "retry") onRetry();
                else if (action.kind === "request-full-tier") onRequestFull();
              }}
            />
          ))}
          {revokeAction && (
            <PopoverActionButton
              action={revokeAction}
              busyAction={busyAction}
              onClick={() => setConfirmRevoke(true)}
            />
          )}
        </div>
      )}
      {confirmRevoke && revokeAction && (
        <div data-testid="solver-work-revoke-confirm" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontFamily: MONO, fontSize: 10, color: C.amber }}>
          confirm revoke?
          <button
            type="button"
            disabled={!!busyAction}
            onClick={() => {
              setConfirmRevoke(false);
              onRevokeReview();
            }}
            style={{ ...smallBtn, color: C.redText, borderColor: "rgba(245,101,101,0.5)" }}
          >
            revoke
          </button>
          <button type="button" disabled={!!busyAction} onClick={() => setConfirmRevoke(false)} style={smallBtn}>
            cancel
          </button>
        </div>
      )}
      {actionNotice && <div style={{ fontFamily: MONO, fontSize: 10, color: C.amber, lineHeight: 1.4 }}>{actionNotice}</div>}
    </div>
  );
}

function PopoverActionButton({ action, busyAction, onClick }: { action: SolverWorkPopoverAction; busyAction?: string | null; onClick: () => void }) {
  const busy = busyAction === action.kind;
  const color = action.kind === "retry" || action.kind === "revoke-review" ? C.redText : action.kind === "request-full-tier" || action.kind.startsWith("continue") ? C.violet : C.teal;
  const borderColor = action.kind === "retry" || action.kind === "revoke-review" ? "rgba(245,101,101,0.5)" : action.kind === "request-full-tier" || action.kind.startsWith("continue") ? C.violetBorder : C.tealBorder;
  return (
    <button
      type="button"
      data-testid={`solver-work-action-${action.kind}`}
      disabled={!!busyAction}
      onClick={onClick}
      style={{ ...smallBtn, color, borderColor, opacity: busyAction ? 0.65 : 1 }}
    >
      {busy ? "queueing…" : action.label}
    </button>
  );
}

function EngineJobRow({ work }: { work: SolverWorkJob }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 12,
        padding: "12px 16px",
        borderBottom: `1px solid ${C.borderRow}`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          <span style={{ fontFamily: MONO, fontSize: 10, color: statusColor(work.status), border: `1px solid ${statusBorder(work.status)}`, borderRadius: 999, padding: "3px 8px" }}>
            {work.status}
          </span>
          <span style={{ fontWeight: 650, color: C.text }}>{work.kind === "urans-retry" ? "URANS retry" : "RANS sweep"}</span>
          {work.retryMode && <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>{work.retryMode.replaceAll("-", " ")}</span>}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, lineHeight: 1.55 }}>
          α {formatAoas(work)} · {work.completedCases}/{work.totalCases} cases
          {work.reynolds ? ` · Re ${formatReynolds(work.reynolds)}` : ""}
          {work.mach != null ? ` · M ${formatCompactNumber(work.mach, 3)}` : ""}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, lineHeight: 1.55 }}>
          solved {work.solvedCount} · pending {work.pendingCount} · failed {work.failedCount}
          {work.acceptedRansCount || work.rejectedRansCount
            ? ` · RANS accepted ${work.acceptedRansCount}, rejected ${work.rejectedRansCount}`
            : ""}
          {work.uransAttemptCount ? ` · URANS attempts ${work.uransAttemptCount}` : ""}
        </div>
        {work.error && <div style={{ fontFamily: MONO, fontSize: 10, color: C.redText, marginTop: 5 }}>{work.error}</div>}
      </div>
      <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 10, color: C.dimmest, whiteSpace: "nowrap" }}>
        wave {work.wave}
        <br />
        {work.engineState ?? "not submitted"}
      </div>
    </div>
  );
}

function formatAoas(work: SolverWorkJob) {
  if (work.aoas.length) return compactRanges(work.aoas);
  if (work.aoaMin != null && work.aoaMax != null) {
    return work.aoaMin === work.aoaMax ? `${work.aoaMin}°` : `${work.aoaMin}°…${work.aoaMax}°`;
  }
  return "—";
}

function compactRanges(values: number[]) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && Math.abs(sorted[i + 1] - end - 1) < 1e-9) {
      end = sorted[++i];
    }
    ranges.push(start === end ? `${start}°` : `${start}°…${end}°`);
  }
  return ranges.join(", ");
}

function statusColor(status: string) {
  if (status === "failed" || status === "cancelled") return C.redText;
  if (status === "running" || status === "submitted" || status === "ingesting") return C.teal;
  if (status === "done") return C.muted;
  return C.amber;
}

function statusBorder(status: string) {
  if (status === "failed" || status === "cancelled") return "rgba(239,68,68,0.45)";
  if (status === "running" || status === "submitted" || status === "ingesting") return C.tealBorder;
  if (status === "done") return C.stroke;
  return "rgba(245,158,11,0.45)";
}

function popoverPosition(rect: DOMRect): CSSProperties {
  const width = 360;
  const estimatedHeight = 280;
  const gutter = 12;
  const left = Math.max(gutter, Math.min(window.innerWidth - width - gutter, rect.left + rect.width / 2 - width / 2));
  const below = rect.bottom + 10;
  const top = below + estimatedHeight > window.innerHeight - gutter ? Math.max(gutter, rect.top - estimatedHeight - 10) : below;
  return {
    position: "fixed",
    left,
    top,
    zIndex: 60,
    background: C.popover,
    border: `1px solid ${C.stroke}`,
    borderRadius: 10,
    boxShadow: `0 18px 45px ${C.shadow}`,
    padding: 12,
  };
}
