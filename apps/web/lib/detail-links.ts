// Pinned-revision detail links (campaign spec §11 "pinned-detail admin
// journey"): admin evidence surfaces (finished/active job cards, campaign
// cell side panel) deep-link to the PUBLIC /airfoils/<slug> page. The public
// page shows enabled-preset evidence only — campaign presets are disabled by
// design — so an evidence link must pin the job's preset revision via
// ?revision=<uuid> or the reader lands on a page with zero polar groups.
//
// Pure module (no React, no path aliases) so the node vitest suite can
// exercise the href contract directly (apps/web/test/detail-links.test.ts).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Search-param name the public detail page reads for the pinned scope. */
export const PINNED_REVISION_PARAM = "revision";

export function isUuidLike(value: string): boolean {
  return UUID_RE.test(value);
}

/** Validates the raw ?revision= search param (Next may hand string[]).
 *  Anything that is not a single UUID-shaped string is ignored → null. */
export function parsePinnedRevisionParam(value: string | string[] | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return isUuidLike(value) ? value.toLowerCase() : null;
}

/** Href for an airfoil detail page; pins the setup revision when one is
 *  known. Multi-revision batched jobs pass null (no single pinned view). */
export function airfoilDetailHref(slug: string, revisionId?: string | null): string {
  const base = `/airfoils/${encodeURIComponent(slug)}`;
  if (!revisionId || !isUuidLike(revisionId)) return base;
  return `${base}?${PINNED_REVISION_PARAM}=${encodeURIComponent(revisionId)}`;
}
