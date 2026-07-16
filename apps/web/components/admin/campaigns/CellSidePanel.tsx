"use client";

// Campaign matrix cell side panel (spec §11): the pinned-revision PolarViewer
// comes FIRST (stored artifact before controls), then one per-angle automatic
// solver flow and a provenance disclosure. Evidence click-through opens
// SimModal by resultId; derived-by-symmetry points open the +α SOURCE result
// with the mirrored flag (spec §9.3).

import {
  type AirfoilDetailPayload,
  type ChartDomain,
  type ChartPointVM,
  type ChartType,
  derivedBySymmetryInfo,
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
  type AdminCampaignPreliminaryOutcomes,
  type AdminUransRequest,
  type CampaignProgressTotals,
  getCampaignPreliminaryOutcomes,
  getUransRequests,
  isAdminApiError,
  requestUrans,
} from "@/lib/admin";
import { getAirfoilDetail, getFieldTrack, getSim } from "@/lib/api";
import { airfoilDetailHref } from "@/lib/detail-links";
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
import {
  PreliminaryOutcomePanel,
  type PreliminaryResultTarget,
} from "./PreliminaryOutcomePanel";
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

const PRELIMINARY_OUTCOMES_POLL_INTERVAL_MS = 2_000;
const PRELIMINARY_OUTCOMES_REQUEST_TIMEOUT_MS = 7_500;

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

  const [preliminaryOutcomes, setPreliminaryOutcomes] =
    useState<AdminCampaignPreliminaryOutcomes | null>(null);
  const [preliminaryOutcomesError, setPreliminaryOutcomesError] = useState<
    string | null
  >(null);
  // Idempotent whole-polar request state. Per-angle automatic ladder status is
  // rendered from the campaign-scoped preliminary outcome read model below.
  const [ladder, setLadder] = useState<{
    requests: AdminUransRequest[];
  } | null>(null);
  const [ladderError, setLadderError] = useState<string | null>(null);
  const [uransBusy, setUransBusy] = useState(false);
  const [uransNotice, setUransNotice] = useState<string | null>(null);
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

  // A point can move from queued → running → accepted/critical while this
  // panel remains open. Poll serially (next request is scheduled only after
  // the previous one settles), cap each request, pause in hidden tabs, and
  // abort on unmount so stale responses cannot overwrite a newly opened cell.
  // The first request is scheduled on the next task so React Strict Mode can
  // cancel its setup probe before that probe starts network work.
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let pollTimer: number | null = null;
    let timeoutTimer: number | null = null;
    let controller: AbortController | null = null;

    const clearPollTimer = () => {
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
    };
    const schedule = (
      delayMs = PRELIMINARY_OUTCOMES_POLL_INTERVAL_MS,
    ): void => {
      if (disposed) return;
      clearPollTimer();
      pollTimer = window.setTimeout(() => void poll(), delayMs);
    };
    const poll = async (): Promise<void> => {
      if (disposed || inFlight) return;
      if (document.hidden) {
        schedule();
        return;
      }

      inFlight = true;
      controller = new AbortController();
      timeoutTimer = window.setTimeout(
        () => controller?.abort(),
        PRELIMINARY_OUTCOMES_REQUEST_TIMEOUT_MS,
      );
      try {
        const next = await getCampaignPreliminaryOutcomes(campaignId, {
          conditionId: condition.id,
          airfoilId: airfoil.airfoilId,
          signal: controller.signal,
        });
        if (!disposed) {
          setPreliminaryOutcomes(next);
          setPreliminaryOutcomesError(null);
        }
      } catch (error) {
        if (!disposed) {
          setPreliminaryOutcomesError(
            error instanceof Error && error.name === "AbortError"
              ? "status refresh timed out"
              : (error as Error).message,
          );
        }
      } finally {
        if (timeoutTimer !== null) {
          window.clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        controller = null;
        inFlight = false;
        schedule();
      }
    };
    const onVisibility = () => {
      if (document.hidden || disposed || inFlight) return;
      clearPollTimer();
      void poll();
    };

    schedule(0);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearPollTimer();
      if (timeoutTimer !== null) window.clearTimeout(timeoutTimer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [campaignId, condition.id, airfoil.airfoilId]);

  // ---- optional whole-polar requests for this cell ----
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
    const tierLabel =
      fidelity === "precalc"
        ? "Preliminary URANS (fast)"
        : "Verified URANS (final)";
    const requestMeaning =
      fidelity === "precalc"
        ? "Fast results will be calculated for every angle."
        : "Missing fast results will be calculated first; final verification follows automatically.";
    if (
      !window.confirm(
        `Queue ${tierLabel} for the whole polar of ${airfoil.name} at Re ${formatRe(condition.reynolds)}? ${requestMeaning}`,
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
          ? `${tierLabel} requested for the whole polar.`
          : `${tierLabel} already ${res.request.state}; the existing request is reused.`,
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

  const onPreliminaryResultClick = useCallback(
    (target: PreliminaryResultTarget) => {
      simTriggerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : panelRef.current;
      const mirrored = target.aoaDeg !== target.sourceAoaDeg;
      setSimCtx({
        re: condition.reynolds,
        aoa: target.aoaDeg,
        resultId: target.resultId,
        mirrored,
        mirroredFromAoaDeg: mirrored ? target.sourceAoaDeg : null,
      });
      setSimDetail(null);
      setSimMessage(null);
      setPlaying(true);
      setSimOpen(true);
    },
    [condition.reynolds],
  );

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
            <span style={chip(C.muted, C.stroke)}>
              {fCount(counters.remaining)} remaining of{" "}
              {fCount(counters.requested)}
            </span>
          </div>
        )}

        <PreliminaryOutcomePanel
          outcomes={preliminaryOutcomes}
          error={preliminaryOutcomesError}
          onOpenResult={onPreliminaryResultClick}
        />

        <div
          data-testid="cell-urans-request-controls"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 6,
            flexWrap: "wrap",
            minHeight: 34,
          }}
        >
          <span
            style={{
              marginRight: 2,
              fontFamily: MONO,
              fontSize: 9.5,
              color: C.dim,
            }}
          >
            Whole-polar request
          </span>
          {(["precalc", "full"] as const).map((fidelity) => {
            const open = ladder?.requests.find(
              (request) =>
                request.aoaDeg == null &&
                request.fidelity === fidelity &&
                (request.state === "pending" || request.state === "running"),
            );
            const label = fidelity === "precalc" ? "Fast URANS" : "Final URANS";
            return (
              <button
                key={fidelity}
                type="button"
                data-testid={`cell-request-urans-${fidelity}`}
                disabled={uransBusy || !!open}
                title={
                  open
                    ? `${label} whole-polar request is ${open.state}.`
                    : fidelity === "precalc"
                      ? "Request fast preliminary URANS for every angle."
                      : "Request final verified URANS for every angle."
                }
                onClick={() => void doRequestUrans(fidelity)}
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
                {open ? `${label} · ${open.state}` : label}
              </button>
            );
          })}
          {!ladder && !ladderError && (
            <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
              …
            </span>
          )}
          {ladderError && (
            <span
              role="alert"
              style={{ fontFamily: MONO, fontSize: 10, color: C.red }}
            >
              Couldn&apos;t load request state.
            </span>
          )}
          {uransNotice && (
            <span
              role="status"
              style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}
            >
              {uransNotice}
            </span>
          )}
        </div>

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
