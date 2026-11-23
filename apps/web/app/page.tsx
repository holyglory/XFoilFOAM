import { Suspense } from "react";
import { CatalogContent } from "@/components/browse/CatalogContent";
import { AppShell } from "@/components/shell/AppShell";
import { metricConditionParam } from "@/lib/metric-condition";

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
  return (
    <CatalogContent
      conditionKey={metricConditionParam((await searchParams).condition)}
    />
  );
}
