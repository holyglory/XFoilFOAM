import { getAirfoilCompareDetail, listAirfoils } from "./api";

export async function loadComparisonData(
  selection: string[] | null,
  conditionKey: string,
) {
  const items =
    selection === null
      ? await listAirfoils({
          sort: "ldmax",
          dir: "desc",
          metricConditionKey: conditionKey || undefined,
          includePoints: false,
          limit: 2,
        })
      : [];
  const selected = selection ?? items.map((item) => item.slug);
  const requested = await Promise.all(
    selected.map(async (slug) => ({
      slug,
      detail: await getAirfoilCompareDetail(slug),
    })),
  );
  return {
    items,
    selection: selected,
    details: Object.fromEntries(
      requested.flatMap(({ slug, detail }) => (detail ? [[slug, detail]] : [])),
    ),
    unavailable: requested
      .filter(({ detail }) => !detail)
      .map(({ slug }) => slug),
  };
}
