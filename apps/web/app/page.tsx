import { BrowseView } from "@/components/browse/BrowseView";
import { AppShell } from "@/components/shell/AppShell";
import { getCategoriesTree, getHashtags, listAirfoils } from "@/lib/api";
import { C, MONO } from "@/lib/tokens";

export const dynamic = "force-dynamic";

export default async function BrowsePage() {
  const [items, categories, hashtags] = await Promise.all([
    listAirfoils({ sort: "ldmax", dir: "desc", includeSubcategories: true }),
    getCategoriesTree(),
    getHashtags(),
  ]);
  return (
    <AppShell active="browse">
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 22px 56px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: "-0.01em" }}>Airfoil database</h1>
          <span style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>{items.length} profiles</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted, marginBottom: 18 }}>
          Browse the Selig coordinate catalog by family, geometry, and tags.
        </div>
        <BrowseView initialItems={items} categories={categories} hashtags={hashtags} />
      </div>
    </AppShell>
  );
}
