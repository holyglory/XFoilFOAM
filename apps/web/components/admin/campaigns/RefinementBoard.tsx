"use client";

// Refinement board (spec §11): summary pills as filters, windowed lanes with
// objective + truthful state chips (incl. converged_provisional /
// converged_window ± observed window / converged_stale / stalled with
// Continue +N / symmetric_definition / insufficient_evidence with lane-scoped
// requeue), and an expanded per-lane iteration table (predicted α → solved
// point by resultId → new fit target → Δ) from the lane-steps evidence.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type AdminCampaignConditionSummary,
  type AdminCampaignLane,
  type AdminCampaignLaneDetail,
  type CampaignObjectiveKey,
  continueLane,
  getCampaignFailures,
  getCampaignLaneDetail,
  getCampaignLanes,
  requeueCampaignFailed,
} from "@/lib/admin";
import { collapseLaneSteps } from "@/lib/lane-steps";
import { C, MONO } from "@/lib/tokens";
import { f, fCount, formatRe, ghostBtn, inputStyle } from "./ui";

const ROW_H = 44;
const EXPANDED_H = 292;
const VIEWPORT_H = 420;
const OVERSCAN = 4;
const PAGE_LIMIT = 100;

const OBJECTIVE_LABEL: Record<string, string> = {
  ld_max: "max L/D",
  cl_zero: "α₀ (Cl = 0)",
  cl_max: "Cl_max",
};

const STATE_META: Record<
  string,
  { label: string; color: string; border: string }
> = {
  awaiting_seed: {
    label: "awaiting seed sweep",
    color: "var(--aero-dim)",
    border: "var(--aero-stroke)",
  },
  iterating: {
    label: "iterating",
    color: "var(--aero-teal)",
    border: "var(--aero-teal-border)",
  },
  converged_final: {
    label: "converged",
    color: "var(--aero-teal)",
    border: "var(--aero-teal-border)",
  },
  converged_provisional: {
    label: "converged · provisional",
    color: "var(--aero-amber)",
    border: "rgba(245,158,11,0.45)",
  },
  converged_window: {
    label: "converged · window",
    color: "var(--aero-amber)",
    border: "rgba(245,158,11,0.45)",
  },
  converged_stale: {
    label: "converged · stale fit",
    color: "var(--aero-amber)",
    border: "rgba(245,158,11,0.45)",
  },
  stalled: {
    label: "stalled",
    color: "var(--aero-red-text)",
    border: "rgba(245,101,101,0.5)",
  },
  insufficient_evidence: {
    label: "insufficient evidence",
    color: "var(--aero-red-text)",
    border: "rgba(245,101,101,0.5)",
  },
  failed: {
    label: "failed",
    color: "var(--aero-red-text)",
    border: "rgba(245,101,101,0.5)",
  },
  symmetric_definition: {
    label: "α₀ = 0° by definition",
    color: "var(--aero-dim)",
    border: "var(--aero-stroke)",
  },
};

function laneKeyOf(lane: AdminCampaignLane): string {
  return `${lane.airfoilId}~${lane.conditionId}~${lane.objective}`;
}

export function RefinementBoard({
  campaignId,
  lanesSummary,
  conditions,
  pollKey,
  onOpenCell,
  onChanged,
}: {
  campaignId: string;
  lanesSummary: Record<string, Record<string, number>>;
  conditions: AdminCampaignConditionSummary[];
  pollKey: number;
  onOpenCell: (lane: AdminCampaignLane) => void;
  onChanged: () => void;
}) {
  const [objective, setObjective] = useState<CampaignObjectiveKey | "">("");
  const [stateFilter, setStateFilter] = useState<string>("");
  const [lanes, setLanes] = useState<AdminCampaignLane[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminCampaignLaneDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [extraRounds, setExtraRounds] = useState(1);
  const [actionBusy, setActionBusy] = useState(false);
  const [requeueState, setRequeueState] = useState<{
    key: string;
    count: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const objectives = Object.keys(lanesSummary).sort();
  const stateCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const [obj, states] of Object.entries(lanesSummary)) {
      if (objective && obj !== objective) continue;
      for (const [state, n] of Object.entries(states))
        out.set(state, (out.get(state) ?? 0) + n);
    }
    return out;
  }, [lanesSummary, objective]);
  const totalLanes = [...stateCounts.values()].reduce((s, n) => s + n, 0);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await getCampaignLanes(campaignId, {
        objective: objective || undefined,
        state: stateFilter || undefined,
        limit: PAGE_LIMIT,
      });
      setLanes(page.items);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [campaignId, objective, stateFilter]);

  useEffect(() => {
    setExpandedKey(null);
    setDetail(null);
    void loadFirst();
  }, [loadFirst]);

  // poll: refresh the first page in place (state chips move as lanes advance);
  // the mount-time load already happened via the filter effect above.
  const seenPollKey = useRef<number | null>(null);
  useEffect(() => {
    if (seenPollKey.current == null) {
      seenPollKey.current = pollKey;
      return;
    }
    if (pollKey === seenPollKey.current) return;
    seenPollKey.current = pollKey;
    void loadFirst();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || nextCursor == null) return;
    loadingRef.current = true;
    try {
      const page = await getCampaignLanes(campaignId, {
        objective: objective || undefined,
        state: stateFilter || undefined,
        cursor: nextCursor,
        limit: PAGE_LIMIT,
      });
      setLanes((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      loadingRef.current = false;
    }
  }, [campaignId, objective, stateFilter, nextCursor]);

  // ---- expanded lane detail ----
  const expandedLane = expandedKey
    ? (lanes.find((l) => laneKeyOf(l) === expandedKey) ?? null)
    : null;
  useEffect(() => {
    if (!expandedLane) return;
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    getCampaignLaneDetail(
      campaignId,
      expandedLane.airfoilId,
      expandedLane.conditionId,
      expandedLane.objective as CampaignObjectiveKey,
    )
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setDetailError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, expandedKey]);

  // ---- windowing (single expanded row of fixed extra height) ----
  const expandedIndex = expandedKey
    ? lanes.findIndex((l) => laneKeyOf(l) === expandedKey)
    : -1;
  const extra = expandedIndex >= 0 ? EXPANDED_H : 0;
  const totalHeight = lanes.length * ROW_H + extra;
  const rowTop = (i: number) =>
    i * ROW_H + (expandedIndex >= 0 && i > expandedIndex ? extra : 0);
  let start = Math.floor(scrollTop / ROW_H);
  if (expandedIndex >= 0 && rowTop(start) > scrollTop)
    start = Math.max(0, Math.floor((scrollTop - extra) / ROW_H));
  start = Math.max(0, start - OVERSCAN);
  const end = Math.min(
    lanes.length,
    start + Math.ceil(VIEWPORT_H / ROW_H) + OVERSCAN * 2,
  );

  useEffect(() => {
    if (nextCursor != null && end >= lanes.length - OVERSCAN) void loadMore();
  }, [end, lanes.length, nextCursor, loadMore]);

  const conditionById = useMemo(
    () => new Map(conditions.map((c) => [c.id, c])),
    [conditions],
  );

  const doContinue = async (lane: AdminCampaignLane) => {
    setActionBusy(true);
    setNotice(null);
    try {
      await continueLane(
        campaignId,
        {
          airfoilId: lane.airfoilId,
          conditionId: lane.conditionId,
          objective: lane.objective as CampaignObjectiveKey,
        },
        extraRounds,
      );
      setNotice(
        `granted +${extraRounds} round${extraRounds === 1 ? "" : "s"} — the lane resumes on the next tick`,
      );
      await loadFirst();
      onChanged();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setActionBusy(false);
    }
  };

  const laneRequeue = async (lane: AdminCampaignLane) => {
    const key = laneKeyOf(lane);
    setActionBusy(true);
    setNotice(null);
    try {
      if (requeueState?.key !== key) {
        const scoped = await getCampaignFailures(campaignId, {
          conditionId: lane.conditionId,
          airfoilId: lane.airfoilId,
        });
        if (scoped.retryableTotal === 0) {
          setNotice(
            scoped.total > 0
              ? "solver failures in this lane are not eligible for an unchanged retry — open the cell for their automatic-recovery state"
              : "no retryable solver failures in this lane's cell — the fit is missing evidence for another reason (see the cell panel)",
          );
          setRequeueState(null);
        } else {
          setRequeueState({ key, count: scoped.retryableTotal });
        }
        return;
      }
      const res = await requeueCampaignFailed(campaignId, {
        conditionId: lane.conditionId,
        airfoilId: lane.airfoilId,
        expectedCount: requeueState.count,
      });
      setNotice(
        `requeued ${res.requeued} retryable solver failure${res.requeued === 1 ? "" : "s"} for this lane`,
      );
      setRequeueState(null);
      onChanged();
    } catch (e) {
      setNotice((e as Error).message);
      setRequeueState(null);
    } finally {
      setActionBusy(false);
    }
  };

  const stateChip = (state: string) => {
    const meta = STATE_META[state] ?? {
      label: state,
      color: C.muted,
      border: C.stroke,
    };
    return (
      <span
        style={{
          fontFamily: MONO,
          fontSize: 9.5,
          color: meta.color,
          border: `1px solid ${meta.border}`,
          borderRadius: 999,
          padding: "3px 8px",
          whiteSpace: "nowrap",
        }}
      >
        {meta.label}
      </span>
    );
  };

  const windowHalf = useMemo(() => {
    if (!detail || expandedLane?.state !== "converged_window") return null;
    const preds = detail.steps.map((s) => s.predictedAlpha).slice(-3);
    if (preds.length < 2) return null;
    return (Math.max(...preds) - Math.min(...preds)) / 2;
  }, [detail, expandedLane?.state]);

  if (totalLanes === 0) return null;

  return (
    <div
      data-testid="refinement-board"
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          padding: "10px 12px",
          borderBottom: `1px solid ${C.borderSoft}`,
        }}
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: "0.1em",
            color: C.dim,
          }}
        >
          REFINEMENT
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>
          {fCount(totalLanes)} lanes
        </span>
        {objectives.length > 1 && (
          <span style={{ display: "flex", gap: 4 }}>
            {["", ...objectives].map((obj) => (
              <button
                key={obj || "all"}
                type="button"
                onClick={() => setObjective(obj as CampaignObjectiveKey | "")}
                style={{
                  ...ghostBtn,
                  padding: "4px 9px",
                  fontSize: 10,
                  color: objective === obj ? C.teal : C.muted,
                  borderColor: objective === obj ? C.tealBorder : C.stroke,
                }}
              >
                {obj ? (OBJECTIVE_LABEL[obj] ?? obj) : "all objectives"}
              </button>
            ))}
          </span>
        )}
        <span
          style={{
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
            marginLeft: "auto",
          }}
        >
          {[...stateCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([state, n]) => {
              const on = stateFilter === state;
              const meta = STATE_META[state] ?? {
                label: state,
                color: C.muted,
                border: C.stroke,
              };
              return (
                <button
                  key={state}
                  type="button"
                  data-testid={`lane-pill-${state}`}
                  onClick={() => setStateFilter(on ? "" : state)}
                  style={{
                    fontFamily: MONO,
                    fontSize: 9.5,
                    color: meta.color,
                    background: on ? C.panel3 : "transparent",
                    border: `1px solid ${on ? meta.color : meta.border}`,
                    borderRadius: 999,
                    padding: "3px 8px",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {meta.label} · {fCount(n)}
                </button>
              );
            })}
        </span>
      </div>

      {notice && (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            color: C.amber,
            padding: "7px 12px",
          }}
        >
          {notice}
        </div>
      )}
      {error && (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            color: C.red,
            padding: "7px 12px",
          }}
        >
          {error}
        </div>
      )}
      {loading && lanes.length === 0 && (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            color: C.dim,
            padding: "10px 12px",
          }}
        >
          loading lanes…
        </div>
      )}
      {!loading && lanes.length === 0 && !error && (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            color: C.dim,
            padding: "10px 12px",
          }}
        >
          no lanes match this filter
        </div>
      )}

      {lanes.length > 0 && (
        <div
          data-testid="lane-scroll"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          style={{
            height: Math.min(VIEWPORT_H, totalHeight),
            overflowY: "auto",
            position: "relative",
          }}
        >
          <div style={{ height: totalHeight, position: "relative" }}>
            {lanes.slice(start, end).map((lane, sliceIdx) => {
              const i = start + sliceIdx;
              const key = laneKeyOf(lane);
              const expanded = expandedKey === key;
              const cond = conditionById.get(lane.conditionId);
              return (
                <div
                  key={key}
                  style={{
                    position: "absolute",
                    top: rowTop(i),
                    left: 0,
                    right: 0,
                    borderBottom: `1px solid ${C.borderRow}`,
                  }}
                >
                  <button
                    type="button"
                    data-testid={`lane-row-${lane.airfoilSlug}-${lane.conditionOrd}-${lane.objective}`}
                    aria-expanded={expanded}
                    onClick={() => setExpandedKey(expanded ? null : key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      height: ROW_H,
                      background: expanded ? C.rowActive : "transparent",
                      border: "none",
                      padding: "0 12px",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 11,
                        color: C.text,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: "32%",
                      }}
                    >
                      {lane.airfoilName}
                    </span>
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        color: C.dim,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Re {formatRe(lane.reynolds)}
                    </span>
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 9.5,
                        color: C.muted,
                        border: `1px solid ${C.stroke}`,
                        borderRadius: 999,
                        padding: "3px 8px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {OBJECTIVE_LABEL[lane.objective] ?? lane.objective}
                    </span>
                    {stateChip(lane.state)}
                    <span
                      style={{
                        marginLeft: "auto",
                        fontFamily: MONO,
                        fontSize: 9.5,
                        color: C.dim,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {lane.currentTargetAlpha != null && (
                        <>α* {f(lane.currentTargetAlpha, 2)}° · </>
                      )}
                      {lane.iterationCount} iter
                      {lane.extraRoundsGranted > 0
                        ? ` (+${lane.extraRoundsGranted})`
                        : ""}
                    </span>
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 9,
                        color: C.dimmest,
                      }}
                    >
                      {expanded ? "▾" : "▸"}
                    </span>
                  </button>
                  {expanded && (
                    <div
                      style={{
                        height: EXPANDED_H - ROW_H,
                        overflowY: "auto",
                        padding: "4px 12px 10px",
                        display: "grid",
                        gap: 8,
                        alignContent: "start",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        {lane.state === "converged_window" &&
                          windowHalf != null && (
                            <span
                              style={{
                                fontFamily: MONO,
                                fontSize: 10,
                                color: C.amber,
                              }}
                            >
                              reported as α* {f(lane.currentTargetAlpha, 2)}° ±{" "}
                              {f(windowHalf, 2)}° (observed prediction window)
                            </span>
                          )}
                        {lane.state === "converged_stale" && (
                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 10,
                              color: C.amber,
                            }}
                          >
                            witness fit was replaced within tolerance — pending
                            re-confirmation
                          </span>
                        )}
                        {lane.state === "symmetric_definition" && (
                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 10,
                              color: C.dim,
                            }}
                          >
                            symmetric airfoil: α₀ = 0° by definition — no solve
                            needed
                          </span>
                        )}
                        {lane.state === "stalled" && (
                          <span
                            style={{
                              display: "flex",
                              gap: 6,
                              alignItems: "center",
                            }}
                          >
                            <input
                              type="number"
                              min={1}
                              max={50}
                              value={extraRounds}
                              aria-label="extra rounds"
                              onChange={(e) =>
                                setExtraRounds(
                                  Math.max(
                                    1,
                                    Math.min(
                                      50,
                                      Math.round(Number(e.target.value) || 1),
                                    ),
                                  ),
                                )
                              }
                              style={{
                                ...inputStyle,
                                width: 64,
                                padding: "5px 8px",
                                fontSize: 11,
                              }}
                            />
                            <button
                              type="button"
                              data-testid="lane-continue"
                              disabled={actionBusy}
                              onClick={() => void doContinue(lane)}
                              style={{
                                ...ghostBtn,
                                padding: "5px 10px",
                                fontSize: 10,
                                color: C.teal,
                                borderColor: C.tealBorder,
                                opacity: actionBusy ? 0.6 : 1,
                              }}
                            >
                              {actionBusy
                                ? "granting…"
                                : `Continue +${extraRounds}`}
                            </button>
                          </span>
                        )}
                        {lane.state === "insufficient_evidence" && (
                          <button
                            type="button"
                            data-testid="lane-requeue"
                            disabled={actionBusy}
                            onClick={() => void laneRequeue(lane)}
                            style={{
                              ...ghostBtn,
                              padding: "5px 10px",
                              fontSize: 10,
                              color: C.amber,
                              opacity: actionBusy ? 0.6 : 1,
                            }}
                          >
                            {requeueState?.key === key
                              ? `confirm requeue ${requeueState.count}`
                              : "requeue failed for this lane"}
                          </button>
                        )}
                        <button
                          type="button"
                          data-testid="lane-open-cell"
                          onClick={() => onOpenCell(lane)}
                          style={{
                            ...ghostBtn,
                            padding: "5px 10px",
                            fontSize: 10,
                            marginLeft: "auto",
                          }}
                        >
                          open cell evidence
                          {cond ? ` · Re ${formatRe(cond.reynolds)}` : ""}
                        </button>
                      </div>

                      {detailError && (
                        <span
                          style={{
                            fontFamily: MONO,
                            fontSize: 10,
                            color: C.red,
                          }}
                        >
                          {detailError}
                        </span>
                      )}
                      {!detail && !detailError && (
                        <span
                          style={{
                            fontFamily: MONO,
                            fontSize: 10,
                            color: C.dim,
                          }}
                        >
                          loading iterations…
                        </span>
                      )}
                      {detail && detail.steps.length === 0 && (
                        <span
                          style={{
                            fontFamily: MONO,
                            fontSize: 10,
                            color: C.dim,
                          }}
                        >
                          no iterations recorded yet
                        </span>
                      )}
                      {detail && detail.steps.length > 0 && (
                        <div style={{ overflowX: "auto" }}>
                          <table
                            data-testid="lane-iteration-table"
                            style={{
                              borderCollapse: "collapse",
                              fontFamily: MONO,
                              fontSize: 10,
                              minWidth: 520,
                            }}
                          >
                            <thead>
                              <tr style={{ color: C.dim, textAlign: "left" }}>
                                <th
                                  style={{
                                    padding: "4px 10px 4px 0",
                                    fontWeight: 400,
                                  }}
                                >
                                  #
                                </th>
                                <th
                                  style={{
                                    padding: "4px 10px 4px 0",
                                    fontWeight: 400,
                                  }}
                                >
                                  predicted α
                                </th>
                                <th
                                  style={{
                                    padding: "4px 10px 4px 0",
                                    fontWeight: 400,
                                  }}
                                >
                                  solved point
                                </th>
                                <th
                                  style={{
                                    padding: "4px 10px 4px 0",
                                    fontWeight: 400,
                                  }}
                                >
                                  new fit target
                                </th>
                                <th
                                  style={{
                                    padding: "4px 10px 4px 0",
                                    fontWeight: 400,
                                  }}
                                >
                                  Δ
                                </th>
                                <th
                                  style={{ padding: "4px 0", fontWeight: 400 }}
                                >
                                  outcome
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {collapseLaneSteps(detail.steps).map(
                                (row, idx, rows) => {
                                  const s = row.step;
                                  const nextTarget =
                                    rows[idx + 1]?.step.predictedAlpha ?? null;
                                  const delta =
                                    nextTarget != null
                                      ? nextTarget - s.predictedAlpha
                                      : null;
                                  const ld =
                                    s.solved &&
                                    s.solved.cl != null &&
                                    s.solved.cd
                                      ? s.solved.cl / s.solved.cd
                                      : null;
                                  return (
                                    <tr
                                      key={s.iteration}
                                      style={{
                                        color: C.muted,
                                        borderTop: `1px solid ${C.borderRow}`,
                                      }}
                                    >
                                      <td
                                        style={{
                                          padding: "4px 10px 4px 0",
                                          color: C.dimmest,
                                        }}
                                      >
                                        {row.repeats > 1
                                          ? `${row.firstIteration}–${s.iteration}`
                                          : s.iteration}
                                      </td>
                                      <td
                                        style={{
                                          padding: "4px 10px 4px 0",
                                          color: C.text,
                                        }}
                                      >
                                        {f(s.predictedAlpha, 2)}°
                                      </td>
                                      <td style={{ padding: "4px 10px 4px 0" }}>
                                        {s.solvedResultId && s.solved ? (
                                          <button
                                            type="button"
                                            title={`open cell evidence (result ${s.solvedResultId.slice(0, 8)})`}
                                            onClick={() => onOpenCell(lane)}
                                            style={{
                                              background: "transparent",
                                              border: "none",
                                              padding: 0,
                                              cursor: "pointer",
                                              fontFamily: MONO,
                                              fontSize: 10,
                                              color: C.teal,
                                              textDecoration:
                                                "underline dotted",
                                            }}
                                          >
                                            Cl{" "}
                                            {s.solved.cl != null
                                              ? f(s.solved.cl, 3)
                                              : "—"}{" "}
                                            · Cd{" "}
                                            {s.solved.cd != null
                                              ? f(s.solved.cd, 5)
                                              : "—"}{" "}
                                            · L/D {ld != null ? f(ld, 1) : "—"}
                                          </button>
                                        ) : (
                                          <span style={{ color: C.dimmest }}>
                                            {s.outcome === "predicted"
                                              ? "solving…"
                                              : "—"}
                                          </span>
                                        )}
                                      </td>
                                      <td style={{ padding: "4px 10px 4px 0" }}>
                                        {nextTarget != null
                                          ? `${f(nextTarget, 2)}°`
                                          : "—"}
                                      </td>
                                      <td
                                        style={{
                                          padding: "4px 10px 4px 0",
                                          color:
                                            delta != null &&
                                            Math.abs(delta) < 1e-9
                                              ? C.teal
                                              : C.muted,
                                        }}
                                      >
                                        {delta != null
                                          ? `${delta >= 0 ? "+" : ""}${f(delta, 2)}°`
                                          : "—"}
                                      </td>
                                      <td
                                        style={{
                                          padding: "4px 0",
                                          color:
                                            s.outcome === "superseded"
                                              ? C.amber
                                              : s.outcome === "released"
                                                ? C.dimmest
                                                : C.dim,
                                        }}
                                        title={
                                          s.outcome === "superseded"
                                            ? "the best fit was re-derived from newer evidence and the target angle moved before this point was solved"
                                            : undefined
                                        }
                                      >
                                        {s.outcome}
                                        {row.repeats > 1 ? (
                                          <span style={{ color: C.dimmest }}>
                                            {" "}
                                            ×{row.repeats} fit refreshes
                                          </span>
                                        ) : null}
                                      </td>
                                    </tr>
                                  );
                                },
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
