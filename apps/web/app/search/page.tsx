import { SearchView } from "@/components/search/SearchView";
import { AppShell } from "@/components/shell/AppShell";
import { getPolarMetricConditions, listAirfoils } from "@/lib/api";
import { metricConditionParam } from "@/lib/metric-condition";
import { C, MONO } from "@/lib/tokens";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const conditionKey = metricConditionParam((await searchParams).condition);
  const [items, conditions] = await Promise.all([
    listAirfoils({
      includePoints: false,
      metricConditionKey: conditionKey || undefined,
    }),
    getPolarMetricConditions(),
  ]);
  return (
    <AppShell active="search">
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
          Search
        </h1>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 12,
            color: C.muted,
            marginBottom: 18,
          }}
        >
          Rank the catalog by aerodynamic objective under your constraints.
        </div>
        <SearchView
          items={items}
          conditions={conditions}
          conditionKey={conditionKey}
        />
      </div>
    </AppShell>
  );
}
