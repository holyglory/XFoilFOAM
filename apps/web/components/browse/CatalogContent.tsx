import { BrowseView } from "@/components/browse/BrowseView";
import { AppShell } from "@/components/shell/AppShell";
import {
  getCategoriesTree,
  getHashtags,
  getPolarMetricConditions,
  INITIAL_BROWSE_ROWS,
  listAirfoilPage,
} from "@/lib/api";
import { C, MONO } from "@/lib/tokens";

export async function CatalogContent({
  conditionKey,
}: {
  conditionKey: string;
}) {
  const [page, categories, hashtags, conditions] = await Promise.all([
    listAirfoilPage({
      sort: "ldmax",
      dir: "desc",
      includeSubcategories: true,
      metricConditionKey: conditionKey || undefined,
      limit: INITIAL_BROWSE_ROWS,
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
            {page.total} profiles
          </span>
        </div>
        <BrowseView
          initialItems={page.items}
          initialTotal={page.total}
          initialRankingId={page.rankingId}
          categories={categories}
          hashtags={hashtags}
          conditions={conditions}
          initialConditionKey={conditionKey}
        />
      </div>
    </AppShell>
  );
}
