import { f1 } from "@aerodb/core";

import type { AdminCampaignPreliminaryOutcomes } from "@/lib/admin";
import { preliminaryOutcomeView } from "@/lib/preliminary-outcomes";
import { C, MONO } from "@/lib/tokens";
import { fCount } from "./ui";

export function PreliminaryOutcomePanel({
  outcomes,
  error,
}: {
  outcomes: AdminCampaignPreliminaryOutcomes | null;
  error: string | null;
}) {
  if (!error && outcomes?.total === 0) return null;

  return (
    <section
      data-testid="cell-preliminary-outcomes"
      aria-labelledby="cell-preliminary-outcomes-title"
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <style jsx>{`
        .preliminary-row {
          display: grid;
          grid-template-columns: 58px minmax(185px, 0.8fr) minmax(250px, 1.4fr);
          gap: 14px;
          align-items: start;
          padding: 10px 12px;
          border-top: 1px solid ${C.borderRow};
        }
        @media (max-width: 620px) {
          .preliminary-row {
            grid-template-columns: 52px minmax(0, 1fr);
          }
          .preliminary-evidence {
            grid-column: 2;
          }
        }
      `}</style>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          flexWrap: "wrap",
        }}
      >
        <span
          id="cell-preliminary-outcomes-title"
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: "0.1em",
            color: C.dim,
          }}
        >
          PRELIMINARY URANS
        </span>
        {outcomes && outcomes.recovering > 0 && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.violet }}>
            {fCount(outcomes.recovering)} recovering
          </span>
        )}
        {outcomes && outcomes.unavailable > 0 && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.amber }}>
            {fCount(outcomes.unavailable)} unavailable
          </span>
        )}
      </div>
      <div
        style={{
          padding: "0 12px 11px",
          fontFamily: MONO,
          fontSize: 10.5,
          lineHeight: 1.55,
          color: C.muted,
          maxWidth: 760,
        }}
      >
        RANS trouble normally hands the angle to preliminary URANS; it is not a
        terminal failure by itself. “Unavailable” below means that automatic
        path has finished without a publishable result. It is not a review task,
        and no user action is required.
      </div>
      {error && (
        <div
          style={{
            borderTop: `1px solid ${C.borderRow}`,
            padding: "10px 12px",
            fontFamily: MONO,
            fontSize: 10.5,
            color: C.red,
          }}
        >
          couldn&apos;t load preliminary recovery outcomes: {error}
        </div>
      )}
      {!outcomes && !error && (
        <div
          style={{
            borderTop: `1px solid ${C.borderRow}`,
            padding: "10px 12px",
            fontFamily: MONO,
            fontSize: 10.5,
            color: C.dim,
          }}
        >
          loading automatic recovery status…
        </div>
      )}
      {outcomes?.items.map((item) => {
        const view = preliminaryOutcomeView(item);
        return (
          <div
            key={item.aoaDeg}
            className="preliminary-row"
            data-testid={`cell-preliminary-outcome-${item.aoaDeg}`}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: 11,
                color: C.text,
                whiteSpace: "nowrap",
              }}
            >
              α {f1(item.aoaDeg)}°
              {item.affectedAoaDegs
                .filter((aoa) => aoa !== item.aoaDeg)
                .map((aoa) => (
                  <span
                    key={aoa}
                    style={{
                      display: "block",
                      marginTop: 3,
                      fontSize: 9,
                      color: C.dim,
                    }}
                  >
                    also α {f1(aoa)}° derived
                  </span>
                ))}
            </span>
            <div style={{ display: "grid", gap: 4 }}>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: item.state === "blocked" ? C.amber : C.violet,
                }}
              >
                {view.stateLabel}
              </span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  lineHeight: 1.45,
                  color: C.muted,
                }}
              >
                {view.stateDetail}
              </span>
            </div>
            <div
              className="preliminary-evidence"
              style={{ display: "grid", gap: 4 }}
            >
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.text,
                }}
              >
                {view.budgetLabel}
              </span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 9.5,
                  lineHeight: 1.45,
                  color: C.dim,
                }}
              >
                {view.evidenceLabel}
              </span>
              {view.diagnostics.map((diagnostic) => (
                <span
                  key={diagnostic}
                  style={{
                    fontFamily: MONO,
                    fontSize: 9.5,
                    lineHeight: 1.45,
                    color: C.dimmest,
                  }}
                >
                  {diagnostic}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
