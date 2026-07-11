import { CompareView } from "@/components/compare/CompareView";
import { AppShell } from "@/components/shell/AppShell";
import { listAirfoils } from "@/lib/api";
import { C, MONO } from "@/lib/tokens";

export const dynamic = "force-dynamic";

export default async function ComparePage() {
  const items = await listAirfoils({ sort: "ldmax", dir: "desc" });
  return (
    <AppShell active="compare">
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 22px 56px" }}>
        <h1 style={{ margin: "0 0 4px", fontSize: 26, fontWeight: 700, letterSpacing: "-0.01em" }}>Compare</h1>
        <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted, marginBottom: 18 }}>
          Overlay polars and cached fit metrics for up to four airfoils at one operating condition.
        </div>
        <CompareView items={items} />
      </div>
    </AppShell>
  );
}
