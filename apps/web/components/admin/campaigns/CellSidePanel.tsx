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
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type AdminCampaignConditionSummary,
  type AdminCampaignFailureGroup,
  type AdminUransRequest,
  type AdminUransVerifyItem,
  type CampaignProgressTotals,
  getCampaignFailures,
  getUransRequests,
  isAdminApiError,
  requestUrans,
  requeueCampaignFailed,
} from "@/lib/admin";
import { getAirfoilDetail, getFieldTrack, getSim } from "@/lib/api";
import { airfoilDetailHref } from "@/lib/detail-links";
import { disagreedDeltaLabel, verifyPointsSearch } from "@/lib/point-history";
import { initialSeriesVisibility, toggleSeriesVisibility } from "@/lib/polar-series";
import { C, MONO } from "@/lib/tokens";
import type { HoverState } from "../../detail/DetailIsland";
import { PolarViewer } from "../../detail/PolarViewer";
import { SimModal } from "../../detail/SimModal";
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
  const [visibleSeries, setVisibleSeries] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<HoverState | null>(null);
  // zoom/pan window; null = zoom-to-fit (resets when the chart type switches)
  const [chartDomain, setChartDomain] = useState<ChartDomain | null>(null);
  const changeChartType = useCallback((t: ChartType) => {
    setChartType(t);
    setChartDomain(null);
  }, []);

  const [failures, setFailures] = useState<{ total: number; groups: AdminCampaignFailureGroup[] } | null>(null);
  const [failuresError, setFailuresError] = useState<string | null>(null);
  // Fidelity ladder state for this cell: verify-queue items + open admin
  // request-URANS items (idempotent-aware whole-polar action).
  const [ladder, setLadder] = useState<{ requests: AdminUransRequest[]; verifyItems: AdminUransVerifyItem[] } | null>(null);
  const [ladderError, setLadderError] = useState<string | null>(null);
  const [uransBusy, setUransBusy] = useState(false);
  const [uransNotice, setUransNotice] = useState<string | null>(null);
  const [requeueBusy, setRequeueBusy] = useState(false);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [provenanceOpen, setProvenanceOpen] = useState(false);

  const [simOpen, setSimOpen] = useState(false);
  const [simCtx, setSimCtx] = useState<{ re: number; aoa: number; resultId?: string | null; mirrored?: boolean; mirroredFromAoaDeg?: number | null } | null>(null);
  const [simDetail, setSimDetail] = useState<SimulationDetail | null>(null);
  const [simMessage, setSimMessage] = useState<string | null>(null);
  const [simField, setSimField] = useState<FieldId>("vorticity");
  const [simTrack, setSimTrack] = useState<FieldTrackPoint[]>([]);
  const [playing, setPlaying] = useState(true);

  // Escape closes the evidence modal first, then the panel (spec §11 routing
  // order). Capture phase so the page-level Escape handler never races it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A modal dialog stacked above the panel wins its own Escape.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.stopPropagation();
      if (simOpen) setSimOpen(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [simOpen, onClose]);

  // ---- pinned-revision detail payload ----
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
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
      setFailures(await getCampaignFailures(campaignId, { conditionId: condition.id, airfoilId: airfoil.airfoilId }));
    } catch (e) {
      setFailuresError((e as Error).message);
    }
  }, [campaignId, condition.id, airfoil.airfoilId]);

  useEffect(() => {
    void loadFailures();
  }, [loadFailures]);

  // ---- fidelity ladder items for this cell ----
  const loadLadder = useCallback(async () => {
    setLadderError(null);
    try {
      setLadder(await getUransRequests(airfoil.airfoilId, condition.revisionId));
    } catch (e) {
      setLadderError((e as Error).message);
    }
  }, [airfoil.airfoilId, condition.revisionId]);

  useEffect(() => {
    void loadLadder();
  }, [loadLadder]);

  const doRequestUrans = async (fidelity: "precalc" | "full") => {
    if (uransBusy) return;
    const budget = fidelity === "precalc" ? "half-resolution mesh, 3 shedding periods, 4 h budget per point" : "full mesh, 7 shedding periods, 12 h budget per point";
    if (!window.confirm(`Queue ${fidelity}-fidelity URANS solves for the WHOLE polar of ${airfoil.name} at Re ${formatRe(condition.reynolds)}? ${budget}. Work schedules after all RANS gaps, at precalc rank.`)) return;
    setUransBusy(true);
    setUransNotice(null);
    try {
      const res = await requestUrans({ airfoilId: airfoil.airfoilId, revisionId: condition.revisionId, fidelity });
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
            (sum, p) => sum + p.points.filter((pt) => pt.source === "solved" && !derivedBySymmetryInfo(pt).derived).length,
            0,
          )
        : 0,
    [detail],
  );

  const onPointClick = useCallback((vm: ChartPointVM) => {
    if (vm.point.source !== "solved" || !vm.point.resultId) return;
    const derived = derivedBySymmetryInfo(vm.point);
    setSimCtx({
      re: vm.re,
      aoa: vm.point.a,
      resultId: derived.derived ? derived.derivedFromResultId ?? vm.point.resultId : vm.point.resultId,
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
          if (d.status !== "solved" || d.availableFields.length === 0 || d.availableFields.includes(current)) return current;
          return d.availableFields[0];
        });
      })
      .catch(() => {
        if (!cancelled) {
          setSimDetail(null);
          setSimMessage("No solved OpenFOAM result is stored for this point yet.");
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

  const requeue = async (key: string, errorClasses: AdminCampaignFailureGroup["errorClass"][] | undefined, expectedCount: number) => {
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
      setNotice(`requeued ${res.requeued} failed point${res.requeued === 1 ? "" : "s"}`);
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

  const requeueButton = (key: string, count: number, errorClasses?: AdminCampaignFailureGroup["errorClass"][]) => (
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
      {requeueBusy && confirmKey === key ? "requeueing…" : confirmKey === key ? `confirm requeue ${count}` : `requeue ${count}`}
    </button>
  );

  const counters = cell ?? null;

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 44 }} onClick={onClose} aria-hidden />
      <aside
        data-testid="cell-side-panel"
        aria-label={`${airfoil.name} at Re ${formatRe(condition.reynolds)}`}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 45,
          width: "min(780px, 100vw)",
          background: C.bg,
          borderLeft: `1px solid ${C.border}`,
          boxShadow: `-24px 0 60px ${C.shadow}`,
          overflowY: "auto",
          padding: 16,
          display: "grid",
          gap: 12,
          alignContent: "start",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{airfoil.name}</span>
          <span style={chip(C.muted, C.stroke)}>Re {formatRe(condition.reynolds)} · #{condition.ord}</span>
          {airfoil.isSymmetric && <span style={chip(C.dim, C.stroke)}>symmetric</span>}
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
          <button type="button" aria-label="Close cell panel" onClick={onClose} style={{ ...ghostBtn, marginLeft: "auto", padding: "4px 10px" }}>
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
              setVisibleSeries((visibility) => toggleSeriesVisibility(visibility, seriesId))
            }
            solvedPointCount={solvedPointCount}
            machStr={condition.mach != null ? condition.mach.toFixed(2) : detail.mach.toFixed(2)}
            hover={hover}
            onHover={setHover}
            onPointClick={onPointClick}
          />
        ) : detailError ? (
          <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
            couldn&apos;t load the pinned-revision polar: {detailError}
          </div>
        ) : (
          <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
            loading pinned-revision polar…
          </div>
        )}

        {/* status chips: real counters for this cell */}
        {counters && (
          <div data-testid="cell-status-chips" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span style={chip(C.teal, C.tealBorder)}>{fCount(counters.solved)} solved</span>
            {counters.derived > 0 && <span style={chip(C.dim, C.stroke)}>◌ {fCount(counters.derived)} derived</span>}
            {counters.running > 0 && <span style={chip(C.amber, "rgba(245,158,11,0.45)")}>{fCount(counters.running)} running</span>}
            {counters.failed > 0 && <span style={chip(C.redText, "rgba(245,101,101,0.5)")}>{fCount(counters.failed)} failed</span>}
            <span style={chip(C.muted, C.stroke)}>{fCount(counters.remaining)} remaining of {fCount(counters.requested)}</span>
          </div>
        )}

        {notice && <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.amber }}>{notice}</div>}

        {/* fidelity ladder: verify-queue chips + whole-polar request-URANS */}
        <div data-testid="cell-fidelity-ladder" style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: `1px solid ${C.borderSoft}`, flexWrap: "wrap" }}>
            <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.dim }}>URANS FIDELITY</span>
            {ladder && (() => {
              const pending = ladder.verifyItems.filter((v) => v.state === "pending" || v.state === "running");
              const done = ladder.verifyItems.filter((v) => v.state === "done");
              const disagreed = ladder.verifyItems.filter((v) => v.state === "disagreed");
              if (pending.length === 0 && done.length === 0 && disagreed.length === 0) {
                return <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>no verify-queue items for this cell</span>;
              }
              return (
                <>
                  {pending.length > 0 && (
                    <a
                      href={`/admin${verifyPointsSearch(airfoil.slug, "pending")}`}
                      data-testid="cell-chip-verify-pending"
                      title="precalc URANS evidence awaiting the full-fidelity verification re-solve — open these points"
                      style={{ ...chip(C.amber, "rgba(245,158,11,0.45)"), textDecoration: "none" }}
                    >
                      {fCount(pending.length)} precalc · verify pending
                    </a>
                  )}
                  {done.length > 0 && (
                    <span data-testid="cell-chip-verified" style={chip(C.teal, C.tealBorder)}>
                      {fCount(done.length)} verified
                    </span>
                  )}
                  {disagreed.length > 0 && (
                    <a
                      href={`/admin${verifyPointsSearch(airfoil.slug, "disagreed")}`}
                      data-testid="cell-chip-verify-disagreed"
                      title="Full-fidelity verification disagreed with the precalc solve — open these points' stories"
                      style={{ ...chip(C.redText, "rgba(245,101,101,0.5)"), textDecoration: "none" }}
                    >
                      {fCount(disagreed.length)} verify disagreed
                    </a>
                  )}
                </>
              );
            })()}
            {!ladder && !ladderError && <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>…</span>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>request URANS (whole polar)</span>
              {(["precalc", "full"] as const).map((fid) => {
                const open = ladder?.requests.find(
                  (r) => r.aoaDeg == null && r.fidelity === fid && (r.state === "pending" || r.state === "running"),
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
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.red, padding: "8px 12px" }}>
              couldn&apos;t load the cell&apos;s fidelity-ladder items: {ladderError}
            </div>
          )}
          {uransNotice && <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.amber, padding: "8px 12px" }}>{uransNotice}</div>}
          {ladder && ladder.verifyItems.some((v) => v.state === "disagreed") && (
            <div style={{ display: "grid", gap: 2, padding: "6px 12px 9px" }}>
              {ladder.verifyItems
                .filter((v) => v.state === "disagreed")
                .map((v) => (
                  <div key={v.id} style={{ display: "flex", gap: 10, alignItems: "baseline", fontFamily: MONO, fontSize: 10, color: C.muted }}>
                    <span style={{ color: C.text, minWidth: 52 }}>α {f1(v.aoaDeg)}°</span>
                    <span style={{ color: C.redText }}>
                      {disagreedDeltaLabel({ state: v.state, deltaCl: v.deltaCl, deltaCd: v.deltaCd, deltaCm: v.deltaCm }) || "deltas not recorded"}
                    </span>
                    <span style={{ color: C.dimmest }}>classification stays on the verified row — flagged for review</span>
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* failed list + scoped requeue */}
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: `1px solid ${C.borderSoft}` }}>
            <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.dim }}>FAILED POINTS</span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: failures && failures.total > 0 ? C.redText : C.dim }}>
              {failures ? fCount(failures.total) : "…"}
            </span>
            {failures && failures.total > 0 && <span style={{ marginLeft: "auto" }}>{requeueButton("all", failures.total)}</span>}
          </div>
          {failuresError && <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.red, padding: "8px 12px" }}>{failuresError}</div>}
          {failures && failures.total === 0 && !failuresError && (
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.dim, padding: "10px 12px" }}>no failed points in this cell</div>
          )}
          {failures?.groups.map((group) => (
            <div key={group.errorClass} style={{ borderBottom: `1px solid ${C.borderRow}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px" }}>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.redText, fontWeight: 600 }}>{group.errorClass}</span>
                <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>{fCount(group.count)} point{group.count === 1 ? "" : "s"}</span>
                <span style={{ marginLeft: "auto" }}>{requeueButton(`class-${group.errorClass}`, group.count, [group.errorClass])}</span>
              </div>
              <div style={{ display: "grid", gap: 2, padding: "0 12px 8px" }}>
                {group.samples.map((s) => (
                  <div key={s.resultId} style={{ display: "flex", gap: 10, alignItems: "baseline", fontFamily: MONO, fontSize: 10, color: C.muted }}>
                    <span style={{ color: C.text, minWidth: 52 }}>α {f1(s.aoaDeg)}°</span>
                    <span style={{ color: s.attempts >= 3 ? C.amber : C.dim }}>{s.attempts} attempt{s.attempts === 1 ? "" : "s"}</span>
                    {s.error && <span style={{ color: C.dimmest, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.error}</span>}
                  </div>
                ))}
                {group.count > group.samples.length && (
                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.dimmest }}>
                    + {fCount(group.count - group.samples.length)} more in this class
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* provenance disclosure */}
        <div>
          <button
            type="button"
            data-testid="cell-provenance-toggle"
            onClick={() => setProvenanceOpen((v) => !v)}
            style={{ ...ghostBtn, padding: "5px 10px", fontSize: 10, color: provenanceOpen ? C.teal : C.muted }}
          >
            {provenanceOpen ? "hide provenance" : "provenance"}
          </button>
          {provenanceOpen && (
            <div data-testid="cell-provenance" style={{ marginTop: 8, display: "grid", gap: 5, background: C.panel2, border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: "9px 11px", fontFamily: MONO, fontSize: 10.5, color: C.muted, lineHeight: 1.55 }}>
              <span>
                preset <span style={{ color: C.text }}>{condition.presetName}</span> ({condition.presetSlug})
                {condition.presetOrigin === "campaign" ? " · campaign-generated" : ""}
              </span>
              <span>
                pinned revision <span style={{ color: C.text }}>r{condition.revisionNumber}</span> · {condition.revisionId.slice(0, 8)}
                {condition.drift && (
                  <span style={{ ...chip(C.amber, "rgba(245,158,11,0.45)"), marginLeft: 8 }} title="A newer revision of this preset exists — this campaign stays on the pinned snapshot.">
                    drift — newer revision exists
                  </span>
                )}
              </span>
              {campaignCreatedAt && <span>campaign launched {new Date(campaignCreatedAt).toLocaleString()}</span>}
              <span style={{ color: C.dimmest }}>display reads the pinned revision snapshot, never live registry rows</span>
            </div>
          )}
        </div>
      </aside>

      <SimModal
        open={simOpen}
        ctx={simCtx}
        sim={simDetail}
        name={airfoil.name}
        machStr={condition.mach != null ? condition.mach.toFixed(2) : detail?.mach.toFixed(2) ?? "—"}
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
        unavailableMessage={simMessage}
      />
    </>
  );
}
