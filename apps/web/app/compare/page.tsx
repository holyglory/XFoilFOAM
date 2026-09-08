import { CompareView } from "@/components/compare/CompareView";
import { AppShell } from "@/components/shell/AppShell";
import { getAirfoilDetail, listAirfoils } from "@/lib/api";
import { parseCompareSelection } from "@/lib/compare-selection";
import { C, MONO } from "@/lib/tokens";

export const dynamic = "force-dynamic";

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const selection = parseCompareSelection((await searchParams).airfoil);
  const [items, requestedDetails] = await Promise.all([
    listAirfoils({ sort: "ldmax", dir: "desc" }),
    Promise.all(
      (selection ?? []).map(async (slug) => ({
        slug,
        detail: await getAirfoilDetail(slug),
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
          Overlay polars and cached fit metrics for up to four airfoils at one
          operating condition.
        </div>
        <CompareView
          key={selection?.join("|") ?? "default"}
          items={items}
          initialSelection={selection}
          initialDetails={initialDetails}
          initialUnavailable={unavailable}
        />
      </div>
    </AppShell>
  );
}
