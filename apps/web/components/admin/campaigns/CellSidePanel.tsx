"use client";

// Campaign matrix cell side panel (spec §11): the pinned-revision PolarViewer
// comes FIRST (stored artifact before controls), then status chips, the real
// failed list with scoped requeue, and a provenance disclosure. Evidence
// click-through opens SimModal by resultId; derived-by-symmetry points open
// the +α SOURCE result with the mirrored flag (spec §9.3).

import {
  type AirfoilDetailPayload,
  type ChartDomain,
  type ChartPointVM,
  type ChartType,
  derivedBySymmetryInfo,
  f1,
  type FieldId,
  type FieldTrackPoint,
  projectChart,
  type SimulationDetail,
} from "@aerodb/core";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type AdminCampaignConditionSummary,
  type AdminCampaignFailureGroup,
  type AdminCampaignPreliminaryOutcomes,
  type AdminUransRequest,
  type AdminUransVerifyItem,
  type CampaignProgressTotals,
  getCampaignFailures,
  getCampaignPreliminaryOutcomes,
  getUransRequests,
  isAdminApiError,
  requestUrans,
  requeueCampaignFailed,
} from "@/lib/admin";
import { getAirfoilDetail, getFieldTrack, getSim } from "@/lib/api";
import { airfoilDetailHref } from "@/lib/detail-links";
import { disagreedDeltaLabel, verifyPointsSearch } from "@/lib/point-history";
import {
  initialSeriesVisibility,
  toggleSeriesVisibility,
} from "@/lib/polar-series";
import { C, MONO } from "@/lib/tokens";
import { useModalLayer } from "@/lib/use-modal-layer";
import { AirfoilGlyph } from "../../AirfoilGlyph";
import { AirfoilProfilePlot } from "../../AirfoilProfilePlot";
import type { HoverState } from "../../detail/DetailIsland";
import { PolarViewer } from "../../detail/PolarViewer";
import { SimModal } from "../../detail/SimModal";
import { PreliminaryOutcomePanel } from "./PreliminaryOutcomePanel";
import { fCount, formatRe, ghostBtn } from "./ui";

export interface CellPanelAirfoil {
  airfoilId: string;
  slug: string;
  name: string;
  isSymmetric?: boolean;
}

const chip = (color: string, border: string) => ({
  fontFamily: MONO,
  fontSize: 10,
  color,
  border: `1px solid ${border}`,
  borderRadius: 999,
  padding: "4px 9px",
  whiteSpace: "nowrap" as const,
});

export function CellSidePanel({
  campaignId,
  airfoil,
  condition,
  cell,
  campaignCreatedAt,
  onClose,
  onChanged,
}: {
  campaignId: string;
  airfoil: CellPanelAirfoil;
  condition: AdminCampaignConditionSummary;
  cell: CampaignProgressTotals | null;
  campaignCreatedAt: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<AirfoilDetailPayload | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [chartType, setChartType] = useState<ChartType>("cla");
  const [profileActive, setProfileActive] = useState(false);
  const [visibleSeries, setVisibleSeries] = useState<Record<string, boolean>>(
    {},
  );
  const [hover, setHover] = useState<HoverState | null>(null);
  // zoom/pan window; null = zoom-to-fit (resets when the chart type switches)
  const [chartDomain, setChartDomain] = useState<ChartDomain | null>(null);
  const changeChartType = useCallback(
    (t: ChartType) => {
      setProfileActive(false);
      setHover(null);
      if (t !== chartType) setChartDomain(null);
      setChartType(t);
    },
    [chartType],
  );

  const [failures, setFailures] = useState<{
    total: number;
    retryableTotal: number;
    groups: AdminCampaignFailureGroup[];
  } | null>(null);
  const [failuresError, setFailuresError] = useState<string | null>(null);
  const [preliminaryOutcomes, setPreliminaryOutcomes] =
    useState<AdminCampaignPreliminaryOutcomes | null>(null);
  const [preliminaryOutcomesError, setPreliminaryOutcomesError] = useState<
    string | null
  >(null);
  // Fidelity ladder state for this cell: verify-queue items + open admin
  // request-URANS items (idempotent-aware whole-polar action).
  const [ladder, setLadder] = useState<{
    requests: AdminUransRequest[];
    verifyItems: AdminUransVerifyItem[];
  } | null>(null);
  const [ladderError, setLadderError] = useState<string | null>(null);
  const [uransBusy, setUransBusy] = useState(false);
  const [uransNotice, setUransNotice] = useState<string | null>(null);
  const [requeueBusy, setRequeueBusy] = useState(false);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [provenanceOpen, setProvenanceOpen] = useState(false);

  const [simOpen, setSimOpen] = useState(false);
  const [simCtx, setSimCtx] = useState<{
    re: number;
    aoa: number;
    resultId?: string | null;
    mirrored?: boolean;
    mirroredFromAoaDeg?: number | null;
  } | null>(null);
  const [simDetail, setSimDetail] = useState<SimulationDetail | null>(null);
  const [simMessage, setSimMessage] = useState<string | null>(null);
  const [simField, setSimField] = useState<FieldId>("vorticity");
  const [simTrack, setSimTrack] = useState<FieldTrackPoint[]>([]);
  const [playing, setPlaying] = useState(true);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const simTriggerRef = useRef<HTMLElement | null>(null);

  useModalLayer(true);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      const trigger = restoreFocusRef.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  // A stacked evidence modal owns Escape while it is present. Otherwise this
  // panel closes before any page-level Escape handler can race it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An unrelated modal stacked above this panel owns its own Escape.
      if (
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="dialog"][aria-modal="true"]',
          ),
        ).some((dialog) => dialog !== panelRef.current)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const trapPanelFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || simOpen) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        element.tabIndex >= 0 &&
        element.getClientRects().length > 0 &&
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true" &&
        !element.closest('[inert], [aria-hidden="true"]'),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // ---- pinned-revision detail payload ----
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    setProfileActive(false);
    getAirfoilDetail(airfoil.slug, condition.revisionId)
      .then((d) => {
        if (cancelled) return;
        if (!d) {
          setDetailError("airfoil not found");
          return;
        }
        setDetail(d);
        setVisibleSeries(initialSeriesVisibility(d.polars));
      })
      .catch((e) => {
        if (!cancelled) setDetailError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [airfoil.slug, condition.revisionId]);

  // ---- scoped failures ----
  const loadFailures = useCallback(async () => {
    setFailuresError(null);
    try {
      setFailures(
        await getCampaignFailures(campaignId, {
          conditionId: condition.id,
          airfoilId: airfoil.airfoilId,
        }),
      );
    } catch (e) {
      setFailuresError((e as Error).message);
    }
  }, [campaignId, condition.id, airfoil.airfoilId]);

  useEffect(() => {
    void loadFailures();
  }, [loadFailures]);

  const loadPreliminaryOutcomes = useCallback(async () => {
    setPreliminaryOutcomesError(null);
    try {
      setPreliminaryOutcomes(
        await getCampaignPreliminaryOutcomes(campaignId, {
          conditionId: condition.id,
          airfoilId: airfoil.airfoilId,
        }),
      );
    } catch (e) {
      setPreliminaryOutcomesError((e as Error).message);
    }
  }, [campaignId, condition.id, airfoil.airfoilId]);

  useEffect(() => {
    void loadPreliminaryOutcomes();
  }, [loadPreliminaryOutcomes]);

  // ---- fidelity ladder items for this cell ----
  const loadLadder = useCallback(async () => {
    setLadderError(null);
    try {
      setLadder(
        await getUransRequests(airfoil.airfoilId, condition.revisionId),
      );
    } catch (e) {
      setLadderError((e as Error).message);
    }
  }, [airfoil.airfoilId, condition.revisionId]);

  useEffect(() => {
    void loadLadder();
  }, [loadLadder]);

  const doRequestUrans = async (fidelity: "precalc" | "full") => {
    if (uransBusy) return;
    const budget =
      fidelity === "precalc"
        ? "half-resolution mesh, 3 shedding periods, 4 h budget per point"
        : "full mesh, 7 shedding periods, 12 h budget per point";
    if (
      !window.confirm(
        `Queue ${fidelity}-fidelity URANS solves for the WHOLE polar of ${airfoil.name} at Re ${formatRe(condition.reynolds)}? ${budget}. Work schedules after all RANS gaps, at precalc rank.`,
      )
    )
      return;
    setUransBusy(true);
    setUransNotice(null);
    try {
      const res = await requestUrans({
        airfoilId: airfoil.airfoilId,
        revisionId: condition.revisionId,
        fidelity,
      });
      setUransNotice(
        res.created
          ? `URANS ${fidelity} requested for the whole polar — scheduled after all RANS gaps`
          : `already requested — the open whole-polar ${fidelity} request is reused (${res.request.state})`,
      );
      await loadLadder();
      onChanged();
    } catch (e) {
      setUransNotice(isAdminApiError(e) ? e.message : (e as Error).message);
    } finally {
      setUransBusy(false);
    }
  };

  const chartPolars = useMemo(
    () =>
      detail
        ? detail.polars.map((p) => ({
            seriesId: p.seriesId,
            label: p.label,
            re: p.re,
            color: p.color,
            points: p.points,
            fit: p.fit,
          }))
        : [],
    [detail],
  );
  const projection = useMemo(
    () =>
      detail
        ? projectChart({
            chartType,
            polars: chartPolars,
            visibleSeries,
            hoverKey: hover?.key ?? null,
            domain: chartDomain,
          })
        : null,
    [detail, chartPolars, chartType, visibleSeries, hover?.key, chartDomain],
  );

  const solvedPointCount = useMemo(
    () =>
      detail
        ? detail.polars.reduce(
            (sum, p) =>
              sum +
              p.points.filter(
                (pt) =>
                  pt.source === "solved" && !derivedBySymmetryInfo(pt).derived,
              ).length,
            0,
          )
        : 0,
    [detail],
  );

  const onPointClick = useCallback((vm: ChartPointVM) => {
    if (vm.point.source !== "solved" || !vm.point.resultId) return;
    simTriggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : panelRef.current;
    const derived = derivedBySymmetryInfo(vm.point);
    setSimCtx({
      re: vm.re,
      aoa: vm.point.a,
      resultId: derived.derived
        ? (derived.derivedFromResultId ?? vm.point.resultId)
        : vm.point.resultId,
      mirrored: derived.derived,
      mirroredFromAoaDeg: derived.derivedFromAoaDeg,
    });
    setSimDetail(null);
    setSimMessage(null);
    setPlaying(true);
    setSimOpen(true);
  }, []);

  useEffect(() => {
    if (!simOpen || !simCtx) return;
    let cancelled = false;
    setSimMessage(null);
    getSim(airfoil.slug, simCtx.re, simCtx.aoa, simCtx.resultId)
      .then((d) => {
        if (cancelled) return;
        setSimDetail(d);
        setSimField((current) => {
          if (
            d.status !== "solved" ||
            d.availableFields.length === 0 ||
            d.availableFields.includes(current)
          )
            return current;
          return d.availableFields[0];
        });
      })
      .catch(() => {
        if (!cancelled) {
          setSimDetail(null);
          setSimMessage(
            "No solved OpenFOAM result is stored for this point yet.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [simOpen, simCtx, airfoil.slug]);

  useEffect(() => {
    if (!simOpen) return;
    let cancelled = false;
    getFieldTrack(airfoil.slug, condition.revisionId)
      .then((items) => {
        if (!cancelled) setSimTrack(items);
      })
      .catch(() => {
        if (!cancelled) setSimTrack([]);
      });
    return () => {
      cancelled = true;
    };
  }, [simOpen, airfoil.slug, condition.revisionId]);

  const requeue = async (
    key: string,
    errorClasses: AdminCampaignFailureGroup["errorClass"][] | undefined,
    expectedCount: number,
  ) => {
    if (confirmKey !== key) {
      setConfirmKey(key);
      return;
    }
    setRequeueBusy(true);
    setNotice(null);
    try {
      const res = await requeueCampaignFailed(campaignId, {
        errorClasses,
        conditionId: condition.id,
        airfoilId: airfoil.airfoilId,
        expectedCount,
      });
      setNotice(
        `requeued ${res.requeued} RANS interruption${res.requeued === 1 ? "" : "s"}`,
      );
      setConfirmKey(null);
      await loadFailures();
      onChanged();
    } catch (e) {
      // drift 409 → the server message carries the real counts; refresh the list
      setNotice((e as Error).message);
      setConfirmKey(null);
      await loadFailures();
    } finally {
      setRequeueBusy(false);
    }
  };

  const requeueButton = (
    key: string,
    count: number,
    errorClasses?: AdminCampaignFailureGroup["errorClass"][],
  ) => (
    <button
      type="button"
      disabled={requeueBusy}
      data-testid={`cell-requeue-${key}`}
      onClick={() => void requeue(key, errorClasses, count)}
      style={{
        ...ghostBtn,
        padding: "4px 9px",
        fontSize: 10,
        color: confirmKey === key ? C.tealInk : C.amber,
        background: confirmKey === key ? C.teal : C.panel3,
        borderColor: confirmKey === key ? C.teal : C.stroke,
        opacity: requeueBusy ? 0.6 : 1,
      }}
    >
      {requeueBusy && confirmKey === key
        ? "requeueing…"
        : confirmKey === key
          ? `confirm requeue ${count}`
          : `requeue ${count}`}
    </button>
  );

  const counters = cell ?? null;

  return (
    <>
      <div
        data-testid="cell-side-panel-backdrop"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 44,
          touchAction: "none",
        }}
        onClick={onClose}
        aria-hidden
      />
      <aside
        ref={panelRef}
        data-testid="cell-side-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cell-side-panel-title"
        aria-hidden={simOpen ? "true" : undefined}
        inert={simOpen}
        tabIndex={-1}
        onKeyDown={trapPanelFocus}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 45,
          width: "min(780px, 100vw)",
          height: "100dvh",
          maxHeight: "100dvh",
          minHeight: 0,
          boxSizing: "border-box",
          background: C.bg,
          borderLeft: `1px solid ${C.border}`,
          boxShadow: `-24px 0 60px ${C.shadow}`,
          overflowY: "auto",
          overscrollBehaviorY: "contain",
          touchAction: "pan-y",
          WebkitOverflowScrolling: "touch",
          padding: 16,
          display: "grid",
          gridAutoRows: "max-content",
          gap: 12,
          alignContent: "start",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              minWidth: 0,
            }}
          >
            <span
              data-testid="cell-airfoil-thumbnail"
              style={{
                width: 62,
                height: 30,
                flex: "0 0 auto",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: C.panel2,
                border: `1px solid ${C.borderSoft}`,
                borderRadius: 7,
              }}
            >
              <AirfoilGlyph
                points={detail?.geometry.contour ?? []}
                width={56}
                height={24}
              />
            </span>
            <span
              id="cell-side-panel-title"
              style={{
                fontWeight: 700,
                fontSize: 15,
                color: C.text,
                minWidth: 0,
              }}
            >
              {airfoil.name}
              <span
                style={{
                  position: "absolute",
                  width: 1,
                  height: 1,
                  padding: 0,
                  margin: -1,
                  overflow: "hidden",
                  clip: "rect(0, 0, 0, 0)",
                  whiteSpace: "nowrap",
                  border: 0,
                }}
              >
                {" "}
                at Re {formatRe(condition.reynolds)}
              </span>
            </span>
          </div>
          <span style={chip(C.muted, C.stroke)}>
            Re {formatRe(condition.reynolds)} · #{condition.ord}
          </span>
          {airfoil.isSymmetric && (
            <span style={chip(C.dim, C.stroke)}>symmetric</span>
          )}
          <a
            // Pinned to the cell's setup revision (spec §11 pinned-detail
            // journey): the public unpinned page hides campaign evidence
            // because campaign presets are disabled by design.
            href={airfoilDetailHref(airfoil.slug, condition.revisionId)}
            target="_blank"
            rel="noreferrer"
            data-testid="cell-open-detail-page"
            style={{ ...chip(C.teal, C.tealBorder), textDecoration: "none" }}
          >
            open detail page ↗
          </a>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close cell panel"
            onClick={onClose}
            style={{ ...ghostBtn, marginLeft: "auto", padding: "4px 10px" }}
          >
            ✕
          </button>
        </div>

        {/* stored artifact FIRST: the pinned-revision polar */}
        {detail && projection ? (
          <PolarViewer
            chartType={chartType}
            onChartType={changeChartType}
            projection={projection}
            polars={chartPolars}
            domain={chartDomain}
            onDomainChange={setChartDomain}
            visibleSeries={visibleSeries}
            onToggleSeries={(seriesId) =>
              setVisibleSeries((visibility) =>
                toggleSeriesVisibility(visibility, seriesId),
              )
            }
            solvedPointCount={solvedPointCount}
            machStr={
              condition.mach != null
                ? condition.mach.toFixed(2)
                : detail.mach.toFixed(2)
            }
            hover={hover}
            onHover={setHover}
            onPointClick={onPointClick}
            profileView={{
              active: profileActive,
              onActivate: () => {
                setProfileActive(true);
                setHover(null);
              },
              content: (
                <AirfoilProfilePlot
                  geometry={detail.geometry}
                  name={detail.name}
                  showMetrics
                />
              ),
            }}
          />
        ) : detailError ? (
          <div
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: C.red,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              padding: 14,
            }}
          >
            couldn&apos;t load the pinned-revision polar: {detailError}
          </div>
        ) : (
          <div
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: C.dim,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              padding: 14,
            }}
          >
            loading pinned-revision polar…
          </div>
        )}

        {/* status chips: real counters for this cell */}
        {counters && (
          <div
            data-testid="cell-status-chips"
            style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
          >
            <span style={chip(C.teal, C.tealBorder)}>
              {fCount(counters.solved)} solved
            </span>
            {counters.derived > 0 && (
              <span style={chip(C.dim, C.stroke)}>
                ◌ {fCount(counters.derived)} derived
              </span>
            )}
            {counters.running > 0 && (
              <span style={chip(C.amber, "rgba(245,158,11,0.45)")}>
                {fCount(counters.running)} running
              </span>
            )}
            {counters.failed > 0 && (
              <span style={chip(C.redText, "rgba(245,101,101,0.5)")}>
                {fCount(counters.failed)} failed
              </span>
            )}
            {(counters.blocked ?? 0) > 0 && (
              <span
                data-testid="cell-counter-blocked"
                title="Automatic preliminary recovery finished without a publishable result; no user action is required"
                style={chip(C.amber, "rgba(245,158,11,0.45)")}
              >
                {fCount(counters.blocked ?? 0)} results unavailable
              </span>
            )}
            <span style={chip(C.muted, C.stroke)}>
              {fCount(counters.remaining)} remaining of{" "}
              {fCount(counters.requested)}
            </span>
          </div>
        )}

        {notice && (
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.amber }}>
            {notice}
          </div>
        )}

        {/* fidelity ladder: verify-queue chips + whole-polar request-URANS */}
        <div
          data-testid="cell-fidelity-ladder"
          style={{
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 12px",
              borderBottom: `1px solid ${C.borderSoft}`,
              flexWrap: "wrap",
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
              URANS FIDELITY
            </span>
            {ladder &&
              (() => {
                const pending = ladder.verifyItems.filter(
                  (v) => v.state === "pending" || v.state === "running",
                );
                const done = ladder.verifyItems.filter(
                  (v) => v.state === "done",
                );
                const disagreed = ladder.verifyItems.filter(
                  (v) => v.state === "disagreed",
                );
                const blocked = ladder.verifyItems.filter(
                  (v) => v.state === "blocked",
                );
                if (
                  pending.length === 0 &&
                  done.length === 0 &&
                  disagreed.length === 0 &&
                  blocked.length === 0
                ) {
                  return (
                    <span
                      style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}
                    >
                      no verify-queue items for this cell
                    </span>
                  );
                }
                return (
                  <>
                    {pending.length > 0 && (
                      <a
                        href={`/admin${verifyPointsSearch(airfoil.slug, "pending")}`}
                        data-testid="cell-chip-verify-pending"
                        title="precalc URANS evidence awaiting the full-fidelity verification re-solve — open these points"
                        style={{
                          ...chip(C.amber, "rgba(245,158,11,0.45)"),
                          textDecoration: "none",
                        }}
                      >
                        {fCount(pending.length)} precalc · verify pending
                      </a>
                    )}
                    {done.length > 0 && (
                      <span
                        data-testid="cell-chip-verified"
                        style={chip(C.teal, C.tealBorder)}
                      >
                        {fCount(done.length)} verified
                      </span>
                    )}
                    {disagreed.length > 0 && (
                      <a
                        href={`/admin${verifyPointsSearch(airfoil.slug, "disagreed")}`}
                        data-testid="cell-chip-verify-disagreed"
                        title="Full-fidelity verification disagreed with the precalc solve — open these points' stories"
                        style={{
                          ...chip(C.redText, "rgba(245,101,101,0.5)"),
                          textDecoration: "none",
                        }}
                      >
                        {fCount(disagreed.length)} verify disagreed
                      </a>
                    )}
                    {blocked.length > 0 && (
                      <span
                        data-testid="cell-chip-verify-blocked"
                        title="The full-fidelity submit was rejected after its bounded automatic retry; accepted preliminary evidence is retained"
                        style={chip(C.amber, "rgba(245,158,11,0.5)")}
                      >
                        {fCount(blocked.length)} verify blocked
                      </span>
                    )}
                  </>
                );
              })()}
            {!ladder && !ladderError && (
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
                …
              </span>
            )}
            <span
              style={{
                marginLeft: "auto",
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>
                request URANS (whole polar)
              </span>
              {(["precalc", "full"] as const).map((fid) => {
                const open = ladder?.requests.find(
                  (r) =>
                    r.aoaDeg == null &&
                    r.fidelity === fid &&
                    (r.state === "pending" || r.state === "running"),
                );
                return (
                  <button
                    key={fid}
                    type="button"
                    data-testid={`cell-request-urans-${fid}`}
                    disabled={uransBusy || !!open}
                    title={
                      open
                        ? `An open whole-polar ${fid} request already exists (${open.state}) — requests are idempotent`
                        : fid === "precalc"
                          ? "Half-resolution mesh, 3 shedding periods, 4 h budget per point"
                          : "Full mesh, 7 shedding periods, 12 h budget per point"
                    }
                    onClick={() => void doRequestUrans(fid)}
                    style={{
                      ...ghostBtn,
                      padding: "4px 9px",
                      fontSize: 10,
                      color: open ? C.dim : C.teal,
                      borderColor: open ? C.stroke : C.tealBorder,
                      opacity: uransBusy ? 0.6 : 1,
                      cursor: uransBusy || open ? "not-allowed" : "pointer",
                    }}
                  >
                    {open ? `${fid} requested (${open.state})` : fid}
                  </button>
                );
              })}
            </span>
          </div>
          {ladderError && (
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10.5,
                color: C.red,
                padding: "8px 12px",
              }}
            >
              couldn&apos;t load the cell&apos;s fidelity-ladder items:{" "}
              {ladderError}
            </div>
          )}
          {uransNotice && (
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10.5,
                color: C.amber,
                padding: "8px 12px",
              }}
            >
              {uransNotice}
            </div>
          )}
          {ladder &&
            [
              ...ladder.verifyItems
                .filter((item) => item.state === "blocked")
                .map((item) => ({
                  key: `verify-${item.id}`,
                  label: `verify α ${f1(item.aoaDeg)}°`,
                  retry: item.submitRetry,
                })),
              ...ladder.requests
                .filter((item) => item.state === "blocked")
                .map((item) => ({
                  key: `request-${item.id}`,
                  label: `${item.fidelity} request${item.aoaDeg == null ? " · whole polar" : ` · α ${f1(item.aoaDeg)}°`}`,
                  retry: item.submitRetry,
                })),
            ].map(({ key, label, retry }) => (
              <div
                key={key}
                data-testid="cell-ladder-submit-blocked"
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  padding: "6px 12px",
                  borderTop: `1px solid ${C.borderSoft}`,
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.muted,
                }}
              >
                <span style={{ color: C.amber }}>{label} blocked</span>
                <span style={{ color: C.dimmest }}>
                  {retry?.lastHttpStatus
                    ? `HTTP ${retry.lastHttpStatus} · `
                    : ""}
                  {retry?.lastError ??
                    "engine rejected the full-fidelity submit"}
                </span>
              </div>
            ))}
          {ladder &&
            ladder.verifyItems.some((v) => v.state === "disagreed") && (
              <div style={{ display: "grid", gap: 2, padding: "6px 12px 9px" }}>
                {ladder.verifyItems
                  .filter((v) => v.state === "disagreed")
                  .map((v) => (
                    <div
                      key={v.id}
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "baseline",
                        fontFamily: MONO,
                        fontSize: 10,
                        color: C.muted,
                      }}
                    >
                      <span style={{ color: C.text, minWidth: 52 }}>
                        α {f1(v.aoaDeg)}°
                      </span>
                      <span style={{ color: C.redText }}>
                        {disagreedDeltaLabel({
                          state: v.state,
                          deltaCl: v.deltaCl,
                          deltaCd: v.deltaCd,
                          deltaCm: v.deltaCm,
                        }) || "deltas not recorded"}
                      </span>
                      <span style={{ color: C.dimmest }}>
                        classification stays on the verified row — flagged for
                        review
                      </span>
                    </div>
                  ))}
              </div>
            )}
        </div>

        <PreliminaryOutcomePanel
          outcomes={preliminaryOutcomes}
          error={preliminaryOutcomesError}
        />

        {/* Ordinary RANS interruptions only. PRECALC-owned terminal outcomes
            live in the separate preliminary panel above. */}
        {(failuresError || (failures && failures.total > 0)) && (
          <section
            aria-labelledby="cell-solver-interruptions-title"
            style={{
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                borderBottom: `1px solid ${C.borderSoft}`,
                flexWrap: "wrap",
              }}
            >
              <span
                id="cell-solver-interruptions-title"
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  color: C.dim,
                }}
              >
                RANS INTERRUPTIONS
              </span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: failures && failures.total > 0 ? C.redText : C.dim,
                }}
              >
                {failures ? fCount(failures.total) : "…"}
              </span>
              {failures && failures.retryableTotal > 0 && (
                <span style={{ marginLeft: "auto" }}>
                  {requeueButton("all", failures.retryableTotal)}
                </span>
              )}
            </div>
            <div
              style={{
                padding: "8px 12px",
                fontFamily: MONO,
                fontSize: 10,
                lineHeight: 1.5,
                color: C.muted,
                borderBottom: `1px solid ${C.borderRow}`,
              }}
            >
              These ordinary RANS runs ended before producing usable evidence
              and have not entered the preliminary URANS recovery ladder.
            </div>
            {failuresError && (
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 10.5,
                  color: C.red,
                  padding: "8px 12px",
                }}
              >
                {failuresError}
              </div>
            )}
            {failures?.groups.map((group) => (
              <div
                key={group.errorClass}
                style={{ borderBottom: `1px solid ${C.borderRow}` }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 12px",
                  }}
                >
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 10.5,
                      color: C.redText,
                      fontWeight: 600,
                    }}
                  >
                    RANS · {group.errorClass}
                  </span>
                  <span
                    style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}
                  >
                    {fCount(group.count)} point{group.count === 1 ? "" : "s"}
                  </span>
                  {group.retryableCount > 0 && (
                    <span style={{ marginLeft: "auto" }}>
                      {requeueButton(
                        `class-${group.errorClass}`,
                        group.retryableCount,
                        [group.errorClass],
                      )}
                    </span>
                  )}
                </div>
                <div style={{ display: "grid", gap: 5, padding: "0 12px 9px" }}>
                  {group.samples.map((sample) => (
                    <div
                      key={sample.resultId}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "52px minmax(130px, auto) 1fr",
                        gap: 10,
                        alignItems: "baseline",
                        fontFamily: MONO,
                        fontSize: 10,
                        color: C.muted,
                      }}
                    >
                      <span style={{ color: C.text }}>
                        α {f1(sample.aoaDeg)}°
                      </span>
                      <span style={{ color: C.dim }}>
                        {sample.attempts} solver evidence record
                        {sample.attempts === 1 ? "" : "s"}
                      </span>
                      <span
                        title={sample.error ?? undefined}
                        style={{
                          color: sample.retryable ? C.teal : C.amber,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {sample.retryable
                          ? "retry available"
                          : "unchanged automatic retry unavailable"}
                      </span>
                    </div>
                  ))}
                  {group.count > group.samples.length && (
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 9.5,
                        color: C.dimmest,
                      }}
                    >
                      + {fCount(group.count - group.samples.length)} more in
                      this class
                    </span>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* provenance disclosure */}
        <div>
          <button
            type="button"
            data-testid="cell-provenance-toggle"
            onClick={() => setProvenanceOpen((v) => !v)}
            style={{
              ...ghostBtn,
              padding: "5px 10px",
              fontSize: 10,
              color: provenanceOpen ? C.teal : C.muted,
            }}
          >
            {provenanceOpen ? "hide provenance" : "provenance"}
          </button>
          {provenanceOpen && (
            <div
              data-testid="cell-provenance"
              style={{
                marginTop: 8,
                display: "grid",
                gap: 5,
                background: C.panel2,
                border: `1px solid ${C.borderSoft}`,
                borderRadius: 8,
                padding: "9px 11px",
                fontFamily: MONO,
                fontSize: 10.5,
                color: C.muted,
                lineHeight: 1.55,
              }}
            >
              <span>
                preset{" "}
                <span style={{ color: C.text }}>{condition.presetName}</span> (
                {condition.presetSlug})
                {condition.presetOrigin === "campaign"
                  ? " · campaign-generated"
                  : ""}
              </span>
              <span>
                pinned revision{" "}
                <span style={{ color: C.text }}>
                  r{condition.revisionNumber}
                </span>{" "}
                · {condition.revisionId.slice(0, 8)}
                {condition.drift && (
                  <span
                    style={{
                      ...chip(C.amber, "rgba(245,158,11,0.45)"),
                      marginLeft: 8,
                    }}
                    title="A newer revision of this preset exists — this campaign stays on the pinned snapshot."
                  >
                    drift — newer revision exists
                  </span>
                )}
              </span>
              {campaignCreatedAt && (
                <span>
                  campaign launched{" "}
                  {new Date(campaignCreatedAt).toLocaleString()}
                </span>
              )}
              <span style={{ color: C.dimmest }}>
                display reads the pinned revision snapshot, never live registry
                rows
              </span>
            </div>
          )}
        </div>
      </aside>

      <SimModal
        open={simOpen}
        ctx={simCtx}
        sim={simDetail}
        name={airfoil.name}
        machStr={
          condition.mach != null
            ? condition.mach.toFixed(2)
            : (detail?.mach.toFixed(2) ?? "—")
        }
        contour={detail?.geometry.contour ?? []}
        field={simField}
        onField={setSimField}
        track={simTrack}
        onTrackPoint={(p) => {
          setSimCtx({ re: p.re, aoa: p.aoa, resultId: p.resultId });
          setSimDetail(null);
          setSimMessage(null);
          setPlaying(true);
        }}
        playing={playing}
        onTogglePlay={() => setPlaying((v) => !v)}
        onClose={() => setSimOpen(false)}
        restoreFocusTo={simTriggerRef.current}
        unavailableMessage={simMessage}
      />
    </>
  );
}
