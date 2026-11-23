import type {
  AirfoilDetailPayload,
  AirfoilSummary,
  CategoryNode,
  EvidenceArtifactDTO,
  FieldId,
  FieldTrackPoint,
  HashtagDTO,
  PolarMetricCondition,
  SimulationDetail,
} from "@aerodb/core";
import type { SolverWorkPayload } from "./solver-work";
import { airfoilGlyphPath } from "./airfoil-glyph";

const SERVER_BASE = process.env.API_URL ?? "http://localhost:4000";
const CLIENT_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type ApiFetchInit = RequestInit & {
  next?: { revalidate?: number; tags?: string[] };
};

/** API origin: server-side uses the internal URL, browser uses the public one. */
export function apiBase(): string {
  return typeof window === "undefined" ? SERVER_BASE : CLIENT_BASE;
}

/** Absolute URL for media/coordinate links rendered in the browser. */
export function browserUrl(path: string): string {
  return path.startsWith("http") ? path : `${CLIENT_BASE}${path}`;
}

/** Connection-level failure (server not up / refused), as opposed to an HTTP error status. */
function isConnError(err: unknown): boolean {
  // Node/undici and browsers both surface refused/aborted connections as TypeError.
  return err instanceof TypeError;
}

/**
 * fetch against the API that retries connection failures with short backoff.
 * SSR fires the instant a page is requested; if the API process is still booting
 * (common right after a dev restart) a single attempt would throw and crash the
 * render. Retrying briefly lets the page wait it out instead. HTTP error statuses
 * are NOT retried — only refused/dropped connections.
 */
async function apiFetch(
  path: string,
  init?: ApiFetchInit,
  retries = 4,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(`${apiBase()}${path}`, init as RequestInit);
    } catch (err) {
      lastErr = err;
      if (!isConnError(err) || attempt === retries) break;
      await new Promise((r) =>
        setTimeout(r, Math.min(250 * 2 ** attempt, 2000)),
      );
    }
  }
  throw lastErr;
}

export async function getAirfoilDetail(
  slug: string,
  revisionId?: string | null,
  signal?: AbortSignal,
  view: "curves" | "compare" | "full" = "full",
): Promise<AirfoilDetailPayload | null> {
  const query = new URLSearchParams();
  if (revisionId) query.set("revisionId", revisionId);
  if (view === "curves" || view === "compare") query.set("view", view);
  const qs = query.size ? `?${query}` : "";
  const res = await apiFetch(`/api/airfoils/${encodeURIComponent(slug)}${qs}`, {
    ...(view === "curves" && !revisionId
      ? { cache: "force-cache" as const, next: { revalidate: 5 } }
      : { cache: "no-store" as const }),
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/airfoils/${slug} → ${res.status}`);
  return res.json();
}

export function getAirfoilCurveDetail(slug: string, signal?: AbortSignal) {
  return getAirfoilDetail(slug, null, signal, "curves");
}

export function getAirfoilCompareDetail(slug: string, signal?: AbortSignal) {
  return getAirfoilDetail(slug, null, signal, "compare");
}

export const INITIAL_BROWSE_ROWS = 40;

export type AirfoilListParams = {
  q?: string;
  category?: string;
  includeSubcategories?: boolean;
  sort?: string;
  metricConditionKey?: string;
  dir?: "asc" | "desc";
  includePoints?: boolean;
  limit?: number;
  offset?: number;
  hashtags?: string[];
  thicknessMin?: number;
  thicknessMax?: number;
  areaMin?: number;
  areaMax?: number;
  upperAreaMin?: number;
  upperAreaMax?: number;
  upperPositiveMin?: number;
  upperPositiveMax?: number;
  upperNegativeMin?: number;
  upperNegativeMax?: number;
  lowerAreaMin?: number;
  lowerAreaMax?: number;
  lowerPositiveMin?: number;
  lowerPositiveMax?: number;
  lowerNegativeMin?: number;
  lowerNegativeMax?: number;
  camberAreaMin?: number;
  camberAreaMax?: number;
  camberPositiveMin?: number;
  camberPositiveMax?: number;
  camberNegativeMin?: number;
  camberNegativeMax?: number;
};

type CatalogRequest = AirfoilListParams & {
  includeTotal?: boolean;
  keysOnly?: boolean;
  retainSlug?: string;
};

type AirfoilKey = Pick<AirfoilSummary, "id" | "slug">;
export type CatalogRow = Omit<AirfoilSummary, "points"> & {
  glyphPath: string | null;
};

// The table only displays the projected contour. Its larger preview and the
// coordinate downloads already use the exact geometry from the detail endpoint.
function catalogRow({ points, ...metadata }: AirfoilSummary): CatalogRow {
  return { ...metadata, glyphPath: airfoilGlyphPath(points) };
}

async function fetchCatalogRows<T>(
  params: CatalogRequest,
  signal?: AbortSignal,
): Promise<{
  items: T[];
  total?: number;
  retained?: AirfoilSummary | null;
  rankingId?: string;
}> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v) && v.length) qs.set(k, v.join(","));
    else if (v !== undefined && v !== "" && v !== null) qs.set(k, String(v));
  }
  const res = await apiFetch(`/api/airfoils?${qs.toString()}`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`GET /api/airfoils → ${res.status}`);
  return res.json();
}

export async function listAirfoils(
  params: AirfoilListParams = {},
  signal?: AbortSignal,
): Promise<AirfoilSummary[]> {
  return (await fetchCatalogRows<AirfoilSummary>(params, signal)).items;
}

export async function listAirfoilPage(
  params: AirfoilListParams & { limit: number; retainSlug?: string },
  signal?: AbortSignal,
) {
  if (params.limit > 10_000)
    throw new RangeError("A catalog page can contain at most 10,000 profiles.");
  const page = await fetchCatalogRows<AirfoilSummary>(
    { ...params, includeTotal: true },
    signal,
  );
  if (
    typeof page.total === "number" &&
    Number.isSafeInteger(page.total) &&
    page.total >= 0
  )
    return {
      items: page.items.map(catalogRow),
      total: page.total,
      retained: page.retained ? catalogRow(page.retained) : null,
      rankingId: page.rankingId,
    };

  // Older API installations return only items during a rolling deployment.
  const { limit, offset = 0, retainSlug, ...filter } = params;
  const all =
    offset === 0 && page.items.length < limit
      ? page.items
      : await listAirfoils(filter, signal);
  const retained = retainSlug
    ? all.find((item) => item.slug === retainSlug)
    : undefined;
  return {
    items: all.slice(offset, offset + limit).map(catalogRow),
    total: all.length,
    retained: retained ? catalogRow(retained) : null,
    rankingId: undefined,
  };
}

export async function listAirfoilPrefix(
  filter: AirfoilListParams,
  count: number,
  retainSlug?: string,
  signal?: AbortSignal,
) {
  const first = await listAirfoilPage(
    { ...filter, retainSlug, limit: Math.min(count, 10_000) },
    signal,
  );
  const rows = [...first.items];
  const seen = new Set(rows.map((row) => row.id));
  const end = Math.min(first.total, count);
  while (rows.length < end) {
    const part = await listAirfoilPage(
      {
        ...filter,
        offset: rows.length,
        limit: Math.min(10_000, end - rows.length),
      },
      signal,
    );
    if (
      !part.items.length ||
      part.total !== first.total ||
      part.rankingId !== first.rankingId ||
      part.items.some((row) => seen.has(row.id))
    )
      throw new Error("The catalog changed while loading. Please try again.");
    for (const row of part.items) {
      seen.add(row.id);
      rows.push(row);
    }
  }
  return { ...first, items: rows };
}

export async function listAirfoilKeys(
  params: AirfoilListParams,
  signal?: AbortSignal,
): Promise<AirfoilKey[]> {
  // An explicit bulk selection needs every matching identity, but no ranking or geometry.
  const result = await fetchCatalogRows<AirfoilKey>(
    {
      ...params,
      sort: "name",
      dir: "asc",
      keysOnly: true,
      includeTotal: true,
      includePoints: false,
      limit: undefined,
      offset: undefined,
    },
    signal,
  );
  const keys = new Map(result.items.map(({ id, slug }) => [id, { id, slug }]));
  if (
    keys.size !== result.items.length ||
    (result.total !== undefined && keys.size !== result.total)
  )
    throw new Error("The profile selection changed. Please select again.");
  return [...keys.values()];
}

export async function getPolarMetricConditions(): Promise<
  PolarMetricCondition[]
> {
  const response = await apiFetch("/api/polar-conditions", {
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(`GET /api/polar-conditions → ${response.status}`);
  return (await response.json()).items;
}

export async function getCategoriesTree(): Promise<CategoryNode[]> {
  const res = await apiFetch(`/api/categories/tree`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /api/categories/tree → ${res.status}`);
  return res.json();
}

export async function getHashtags(): Promise<HashtagDTO[]> {
  const res = await apiFetch(`/api/hashtags`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /api/hashtags → ${res.status}`);
  return (await res.json()).items as HashtagDTO[];
}

const SIM_DETAIL_CACHE_TTL_MS = 2 * 60_000;
const SIM_DETAIL_CACHE_LIMIT = 96;
type SimDetailCacheEntry = {
  value?: SimulationDetail;
  promise?: Promise<SimulationDetail>;
  expiresAt: number;
};
const simDetailCache = new Map<string, SimDetailCacheEntry>();
const simMediaPreloads = new Map<string, HTMLImageElement>();

function simDetailKey(
  slug: string,
  re: number,
  aoa: number,
  resultId?: string | null,
  resultAttemptId?: string | null,
): string {
  return resultId
    ? `result:${resultId}${resultAttemptId ? `:attempt:${resultAttemptId}` : ""}`
    : `point:${slug}:${re}:${aoa}`;
}

function trimSimDetailCache(): void {
  while (simDetailCache.size > SIM_DETAIL_CACHE_LIMIT) {
    const oldest = simDetailCache.keys().next().value as string | undefined;
    if (!oldest) break;
    simDetailCache.delete(oldest);
  }
}

export function getCachedSim(
  slug: string,
  re: number,
  aoa: number,
  resultId?: string | null,
  resultAttemptId?: string | null,
): SimulationDetail | null {
  const key = simDetailKey(slug, re, aoa, resultId, resultAttemptId);
  const entry = simDetailCache.get(key);
  if (!entry?.value || entry.expiresAt <= Date.now()) return null;
  simDetailCache.delete(key);
  simDetailCache.set(key, entry);
  return entry.value;
}

export async function getSim(
  slug: string,
  re: number,
  aoa: number,
  resultId?: string | null,
  resultAttemptId?: string | null,
): Promise<SimulationDetail> {
  const key = simDetailKey(slug, re, aoa, resultId, resultAttemptId);
  const cached = getCachedSim(slug, re, aoa, resultId, resultAttemptId);
  if (cached) return cached;
  const inFlight = simDetailCache.get(key)?.promise;
  if (inFlight) return inFlight;

  const qs = new URLSearchParams({ re: String(re), aoa: String(aoa) });
  if (resultId) qs.set("resultId", resultId);
  if (resultAttemptId) qs.set("resultAttemptId", resultAttemptId);
  const promise = (async () => {
    const res = await apiFetch(
      `/api/airfoils/${encodeURIComponent(slug)}/sim?${qs.toString()}`,
      { cache: "no-store" },
    );
    if (!res.ok) throw new Error(`GET sim → ${res.status}`);
    const value = (await res.json()) as SimulationDetail;
    // Bridge mixed-version deploys: older API instances did not echo this id.
    if (!value.resultId && resultId) value.resultId = resultId;
    simDetailCache.delete(key);
    simDetailCache.set(key, {
      value,
      expiresAt: Date.now() + SIM_DETAIL_CACHE_TTL_MS,
    });
    trimSimDetailCache();
    return value;
  })();
  simDetailCache.set(key, {
    promise,
    expiresAt: Date.now() + SIM_DETAIL_CACHE_TTL_MS,
  });
  trimSimDetailCache();
  try {
    return await promise;
  } catch (error) {
    if (simDetailCache.get(key)?.promise === promise)
      simDetailCache.delete(key);
    throw error;
  }
}

export interface SimDetailPrefetchTarget {
  slug: string;
  re: number;
  aoa: number;
  resultId?: string | null;
}

function preloadSimField(
  detail: SimulationDetail,
  preferredField?: FieldId,
): void {
  if (typeof window === "undefined" || typeof Image === "undefined") return;
  const field =
    preferredField && detail.availableFields.includes(preferredField)
      ? preferredField
      : detail.availableFields[0];
  if (!field) return;
  const media = detail.media?.[field];
  const url = media?.imageUrl ?? (media?.kind === "image" ? media.url : null);
  if (!url) return;
  const absoluteUrl = browserUrl(url);
  if (simMediaPreloads.has(absoluteUrl)) return;
  const image = new Image();
  image.decoding = "async";
  image.src = absoluteUrl;
  simMediaPreloads.set(absoluteUrl, image);
  while (simMediaPreloads.size > SIM_DETAIL_CACHE_LIMIT) {
    const oldest = simMediaPreloads.keys().next().value as string | undefined;
    if (!oldest) break;
    simMediaPreloads.delete(oldest);
  }
}

/** Warm immutable sibling evidence with bounded concurrency so AoA slider
 *  navigation can switch detail JSON and the selected field image instantly. */
export function prefetchSimDetails(
  targets: SimDetailPrefetchTarget[],
  preferredField?: FieldId,
): void {
  if (typeof window === "undefined" || targets.length === 0) return;
  const unique = Array.from(
    new Map(
      targets.map((target) => [
        simDetailKey(target.slug, target.re, target.aoa, target.resultId),
        target,
      ]),
    ).values(),
  );
  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      const target = unique[cursor++];
      try {
        const detail = await getSim(
          target.slug,
          target.re,
          target.aoa,
          target.resultId,
        );
        preloadSimField(detail, preferredField);
      } catch {
        // Prefetch is opportunistic; the selected-point request owns errors.
      }
    }
  };
  void Promise.all(
    Array.from({ length: Math.min(4, unique.length) }, () => worker()),
  );
}

export async function getFieldTrack(
  slug: string,
  revisionId?: string | null,
): Promise<FieldTrackPoint[]> {
  const qs = new URLSearchParams();
  if (revisionId) qs.set("revisionId", revisionId);
  const res = await apiFetch(
    `/api/airfoils/${encodeURIComponent(slug)}/field-track?${qs.toString()}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GET field-track → ${res.status}`);
  return (await res.json()).items as FieldTrackPoint[];
}

export async function getSolverWork(
  slug: string,
  revisionId?: string | null,
): Promise<SolverWorkPayload> {
  const qs = new URLSearchParams();
  if (revisionId) qs.set("revision", revisionId);
  const suffix = qs.toString();
  const res = await apiFetch(
    `/api/airfoils/${encodeURIComponent(slug)}/solver-work${suffix ? `?${suffix}` : ""}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GET solver-work → ${res.status}`);
  return res.json();
}

export async function getResultEvidence(
  resultId: string,
): Promise<{ artifacts: EvidenceArtifactDTO[] }> {
  const res = await apiFetch(
    `/api/results/${encodeURIComponent(resultId)}/evidence`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GET evidence → ${res.status}`);
  return res.json();
}

export async function renderResultField(
  resultId: string,
  body: {
    field: FieldId;
    role: "instantaneous" | "mean";
    scaleMode?: "track" | "auto" | "manual";
    zoomChords: number;
    colormap?: string | null;
    levels?: number;
    vmin?: number | null;
    vmax?: number | null;
    frameIndex?: number | null;
    widthPx?: number;
    heightPx?: number;
  },
): Promise<{
  id: string;
  cached: boolean;
  field: FieldId;
  role: string;
  url: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  paramsHash: string;
}> {
  const res = await apiFetch(
    `/api/results/${encodeURIComponent(resultId)}/render`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `POST render → ${res.status}`);
  }
  return res.json();
}

export interface CategoryListItem {
  id: string;
  slug: string;
  name: string;
  path: string;
  depth: number;
}

export async function getCategories(): Promise<CategoryListItem[]> {
  const res = await apiFetch(`/api/categories`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /api/categories → ${res.status}`);
  return (await res.json()).items as CategoryListItem[];
}

export interface CreateAirfoilBody {
  name?: string;
  categorySlug?: string;
  naca?: { t: number; m: number; p: number };
  coordinates?: string;
}

export async function createAirfoil(
  body: CreateAirfoilBody,
): Promise<AirfoilSummary> {
  const res = await fetch(`${apiBase()}/api/airfoils`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error || `create failed (${res.status})`);
  }
  return res.json();
}

export interface BulkResult {
  created: AirfoilSummary[];
  errors: { name: string; error: string }[];
}

export async function bulkCreateAirfoils(
  items: { name?: string; coordinates: string }[],
  categorySlug?: string,
): Promise<BulkResult> {
  const res = await fetch(`${apiBase()}/api/airfoils/bulk`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, categorySlug }),
  });
  if (!res.ok) throw new Error(`bulk create failed (${res.status})`);
  return res.json();
}
