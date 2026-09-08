export function parseCompareSelection(
  value: string | string[] | undefined,
): string[] | null {
  if (value === undefined) return null;
  return [
    ...new Set(
      (Array.isArray(value) ? value : [value])
        .map((slug) => slug.trim())
        .filter(
          (slug) =>
            slug.length > 0 &&
            slug.length <= 200 &&
            !/[\u0000-\u001f/\\]/.test(slug) &&
            slug !== "." &&
            slug !== "..",
        ),
    ),
  ].slice(0, 4);
}

export function comparisonHref(slugs: string[], search = ""): string {
  const params = new URLSearchParams(search);
  params.delete("airfoil");
  const selection = parseCompareSelection(slugs)!;
  for (const slug of selection) params.append("airfoil", slug);
  if (!selection.length) params.set("airfoil", "");
  return `/compare?${params.toString()}`;
}
