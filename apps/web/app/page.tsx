import { BrowseView } from "@/components/browse/BrowseView";
import { AppShell } from "@/components/shell/AppShell";
import {
  getCategoriesTree,
  getHashtags,
  getPolarMetricConditions,
  listAirfoils,
} from "@/lib/api";
import { metricConditionParam } from "@/lib/metric-condition";
import { C, MONO } from "@/lib/tokens";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default function BrowsePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense
      fallback={
        <AppShell active="browse">
          <main style={{ padding: 24 }}>
            <h1>Airfoil catalog</h1>
            <p role="status">Loading profiles…</p>
          </main>
        </AppShell>
      }
    >
      <BrowseContent {...props} />
    </Suspense>
  );
}

async function BrowseContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const conditionKey = metricConditionParam((await searchParams).condition);
  const [items, categories, hashtags, conditions] = await Promise.all([
    listAirfoils({
      sort: "ldmax",
      dir: "desc",
      includeSubcategories: true,
      metricConditionKey: conditionKey || undefined,
    }),
    getCategoriesTree(),
    getHashtags(),
    getPolarMetricConditions(),
  ]);
  return (
    <AppShell active="browse">
      <div
        style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 22px 56px" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 12,
            marginBottom: 4,
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: "-0.01em",
            }}
          >
            Airfoil catalog
          </h1>
          <span style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>
            {items.length} profiles
          </span>
        </div>
        <BrowseView
          initialItems={items}
          categories={categories}
          hashtags={hashtags}
          conditions={conditions}
          initialConditionKey={conditionKey}
        />
      </div>
    </AppShell>
  );
}
