import { CompareView } from "@/components/compare/CompareView";
import { AppShell } from "@/components/shell/AppShell";
import { getAirfoilCurveDetail, listAirfoils } from "@/lib/api";
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
  const [items, requestedDetails] = await Promise.all([
    listAirfoils({
      sort: "ldmax",
      dir: "desc",
      metricConditionKey: conditionKey || undefined,
    }),
    Promise.all(
      (selection ?? []).map(async (slug) => ({
        slug,
        detail: await getAirfoilCurveDetail(slug),
      })),
    ),
  ]);
  const initialDetails = Object.fromEntries(
    requestedDetails.flatMap(({ slug, detail }) =>
      detail ? [[slug, detail]] : [],
    ),
  );
  const unavailable = requestedDetails
    .filter(({ detail }) => !detail)
    .map(({ slug }) => slug);
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
          items={items}
          initialSelection={selection}
          initialDetails={initialDetails}
          initialUnavailable={unavailable}
          initialConditionKey={conditionKey}
        />
      </div>
    </AppShell>
  );
}
