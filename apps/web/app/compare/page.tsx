import { CompareView } from "@/components/compare/CompareView";
import { AppShell } from "@/components/shell/AppShell";
import { loadComparisonData } from "@/lib/compare-loading";
import { parseCompareSelection } from "@/lib/compare-selection";
import { metricConditionParam } from "@/lib/metric-condition";
import { C, MONO } from "@/lib/tokens";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default function ComparePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense
      fallback={
        <AppShell active="compare">
          <main style={{ padding: 24 }}>
            <h1>Compare</h1>
            <p role="status">Loading selected profiles…</p>
          </main>
        </AppShell>
      }
    >
      <CompareContent {...props} />
    </Suspense>
  );
}

async function CompareContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const selection = parseCompareSelection(query.airfoil);
  const conditionKey = metricConditionParam(query.condition);
  const initial = await loadComparisonData(selection, conditionKey);
  return (
    <AppShell active="compare">
      <div
        style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 22px 56px" }}
      >
        <h1
          style={{
            margin: "0 0 4px",
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: "-0.01em",
          }}
        >
          Compare
        </h1>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 12,
            color: C.muted,
            marginBottom: 18,
          }}
        >
          Compare airfoils at the same flow condition.
        </div>
        <CompareView
          key={selection?.join("|") ?? "default"}
          items={initial.items}
          initialSelection={initial.selection}
          initialDetails={initial.details}
          initialUnavailable={initial.unavailable}
          initialConditionKey={conditionKey}
        />
      </div>
    </AppShell>
  );
}
