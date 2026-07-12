"use client";

// Campaign condition summary strip (spec §11): one card per condition with
// Re label, real progress counters, failed count, next-up marker from the
// real candidate order, ⚑ kept badge, red blocked badge and the neutral
// "retired · complete" state. Released conditions appear only when they
// gained evidence after release (restore affordance) — the full released set
// lives behind the matrix "Show released" toggle.

import type { CSSProperties } from "react";

import type { AdminCampaignConditionSummary } from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { f, fCount, formatRe, fPressure, fSpeed, fTemp } from "./ui";

export type ConditionDisplayState =
  | "active"
  | "kept"
  | "blocked"
  | "retired"
  | "released";

/** §6.3 display state from the truthful status + counters. */
export function conditionDisplayState(
  c: AdminCampaignConditionSummary,
): ConditionDisplayState {
  const blocked = c.counters.blocked ?? 0;
  if (c.status === "released") return "released";
  if (c.status === "kept") {
    if (c.counters.remaining === 0 && (c.counters.failed > 0 || blocked > 0))
      return "blocked";
    if (c.counters.remaining === 0 && c.counters.failed === 0 && blocked === 0)
      return "retired";
    return "kept";
  }
  return "active";
}

/** Real candidate order within one campaign: the scheduler emits
 *  effectivePriority DESC (constant inside a campaign), reynolds ASC, slug
 *  ASC, aoa ASC — so the next condition to receive work is the open active
 *  condition with the lowest Reynolds (ties by ord). */
export function nextUpConditionId(
  conditions: AdminCampaignConditionSummary[],
  schedulable: boolean,
): string | null {
  if (!schedulable) return null;
  let best: AdminCampaignConditionSummary | null = null;
  for (const c of conditions) {
    if (c.status !== "active" || c.counters.remaining <= 0) continue;
    if (
      !best ||
      c.reynolds < best.reynolds ||
      (c.reynolds === best.reynolds && c.ord < best.ord)
    )
      best = c;
  }
  return best?.id ?? null;
}

const badge = (
  color: string,
  borderColor: string,
  bg = "transparent",
): CSSProperties => ({
  fontFamily: MONO,
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: "0.04em",
  color,
  border: `1px solid ${borderColor}`,
  background: bg,
  borderRadius: 999,
  padding: "2px 7px",
  whiteSpace: "nowrap",
});

export function ConditionStrip({
  conditions,
  nextUpId,
  busyConditionId,
  onForceRelease,
  onRestore,
}: {
  conditions: AdminCampaignConditionSummary[];
  nextUpId: string | null;
  busyConditionId: string | null;
  onForceRelease: (condition: AdminCampaignConditionSummary) => void;
  onRestore: (condition: AdminCampaignConditionSummary) => void;
}) {
  const visible = conditions.filter(
    (c) => c.status !== "released" || c.gainedEvidenceAfterRelease,
  );
  if (visible.length === 0) return null;
  return (
    <div
      data-testid="campaign-condition-strip"
      style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}
    >
      {visible.map((c) => {
        const state = conditionDisplayState(c);
        const blocked = c.counters.blocked ?? 0;
        const dimmed = state === "released";
        const solvedish = c.counters.solved + c.counters.derived;
        const frac =
          c.counters.requested > 0 ? solvedish / c.counters.requested : 0;
        const busy = busyConditionId === c.id;
        return (
          <div
            key={c.id}
            data-testid={`condition-card-${c.ord}`}
            style={{
              flex: "0 0 auto",
              width: 216,
              background: C.panel,
              border: `1px solid ${state === "blocked" ? (blocked > 0 ? "rgba(245,158,11,0.45)" : "rgba(245,101,101,0.45)") : state === "kept" ? "rgba(245,158,11,0.4)" : C.border}`,
              borderRadius: 10,
              padding: "10px 12px",
              opacity: dimmed ? 0.62 : 1,
              display: "grid",
              gap: 7,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  fontWeight: 700,
                  color: C.text,
                }}
              >
                Re {formatRe(c.reynolds)}
              </span>
              {c.mach != null && (
                <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
                  M {f(c.mach, 3)}
                </span>
              )}
              {c.id === nextUpId && (
                <span style={badge(C.teal, C.tealBorder, C.tealFill)}>
                  next up
                </span>
              )}
              {state === "kept" && (
                <span
                  style={badge(C.amber, "rgba(245,158,11,0.45)")}
                  title="Kept to finish — removed from the plan after gaining results; its solved angles finish for all campaign airfoils."
                >
                  ⚑ kept
                </span>
              )}
              {state === "blocked" && (
                <span
                  style={
                    blocked > 0
                      ? badge(
                          C.amber,
                          "rgba(245,158,11,0.45)",
                          "rgba(245,158,11,0.08)",
                        )
                      : badge(
                          C.redText,
                          "rgba(245,101,101,0.5)",
                          "rgba(245,101,101,0.08)",
                        )
                  }
                >
                  blocked
                </span>
              )}
              {state === "retired" && (
                <span style={badge(C.muted, C.stroke)}>retired · complete</span>
              )}
              {state === "released" && (
                <span style={badge(C.muted, C.stroke)}>released</span>
              )}
              {c.drift && (
                <span
                  style={badge(C.amber, "rgba(245,158,11,0.45)")}
                  title="A newer revision of this preset exists — this campaign stays pinned to the revision shown."
                >
                  drift
                </span>
              )}
            </div>
            <div
              style={{
                fontFamily: MONO,
                fontSize: 9.5,
                color: C.dim,
                lineHeight: 1.5,
              }}
            >
              {fTemp(c.temperatureK)} · {fPressure(c.pressurePa)}
              <br />
              {fSpeed(c.speedMps)} ·{" "}
              {c.chordM != null ? `${f(c.chordM, 4)} m chord` : "—"}
            </div>
            <div
              style={{
                height: 5,
                background: C.panel3,
                borderRadius: 3,
                overflow: "hidden",
                display: "flex",
              }}
            >
              <span
                style={{
                  width: `${Math.min(100, frac * 100)}%`,
                  background: C.teal,
                  display: "block",
                }}
              />
              {c.counters.failed > 0 && c.counters.requested > 0 && (
                <span
                  style={{
                    width: `${Math.min(100, (c.counters.failed / c.counters.requested) * 100)}%`,
                    background: C.red,
                    display: "block",
                  }}
                />
              )}
              {blocked > 0 && c.counters.requested > 0 && (
                <span
                  style={{
                    width: `${Math.min(100, (blocked / c.counters.requested) * 100)}%`,
                    background: C.amber,
                    display: "block",
                  }}
                />
              )}
            </div>
            <div
              style={{
                fontFamily: MONO,
                fontSize: 9.5,
                color: C.muted,
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span>
                {fCount(solvedish)}/{fCount(c.counters.requested)}
              </span>
              {c.counters.derived > 0 && (
                <span style={{ color: C.dim }} title="derived by symmetry">
                  ◌ {fCount(c.counters.derived)}
                </span>
              )}
              {c.counters.running > 0 && (
                <span style={{ color: C.amber }}>
                  {fCount(c.counters.running)} running
                </span>
              )}
              {c.counters.failed > 0 && (
                <span style={{ color: C.redText }}>
                  {fCount(c.counters.failed)} failed
                </span>
              )}
              {blocked > 0 && (
                <span style={{ color: C.amber }}>
                  {fCount(blocked)} blocked
                </span>
              )}
            </div>
            {state === "blocked" && (
              <button
                type="button"
                disabled={busy}
                data-testid={`condition-force-release-${c.ord}`}
                onClick={() => onForceRelease(c)}
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.redText,
                  background: "transparent",
                  border: "1px solid rgba(245,101,101,0.45)",
                  borderRadius: 7,
                  padding: "5px 8px",
                  cursor: busy ? "not-allowed" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy ? "releasing…" : "force-release…"}
              </button>
            )}
            {state === "released" && c.gainedEvidenceAfterRelease && (
              <button
                type="button"
                disabled={busy}
                data-testid={`condition-restore-${c.ord}`}
                onClick={() => onRestore(c)}
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.teal,
                  background: "transparent",
                  border: `1px solid ${C.tealBorder}`,
                  borderRadius: 7,
                  padding: "5px 8px",
                  cursor: busy ? "not-allowed" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy ? "restoring…" : "restore — gained evidence"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
