import type {
  AirfoilDetailPayload,
  AirfoilSummary,
  CategoryNode,
  EvidenceArtifactDTO,
  FieldId,
  FieldTrackPoint,
  HashtagDTO,
  SimulationDetail,
} from "@aerodb/core";
import type { SolverWorkPayload } from "./solver-work";

const SERVER_BASE = process.env.API_URL ?? "http://localhost:4000";
const CLIENT_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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
async function apiFetch(path: string, init?: RequestInit, retries = 4): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(`${apiBase()}${path}`, init);
    } catch (err) {
      lastErr = err;
      if (!isConnError(err) || attempt === retries) break;
      await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** attempt, 2000)));
    }
  }
  throw lastErr;
}

export async function getAirfoilDetail(slug: string, revisionId?: string | null): Promise<AirfoilDetailPayload | null> {
  const qs = revisionId ? `?revisionId=${encodeURIComponent(revisionId)}` : "";
  const res = await apiFetch(`/api/airfoils/${encodeURIComponent(slug)}${qs}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/airfoils/${slug} → ${res.status}`);
  return res.json();
}

export async function listAirfoils(params: {
  q?: string;
  category?: string;
  includeSubcategories?: boolean;
  sort?: string;
  dir?: "asc" | "desc";
  includePoints?: boolean;
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
} = {}): Promise<AirfoilSummary[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v) && v.length) qs.set(k, v.join(","));
    else if (v !== undefined && v !== "" && v !== null) qs.set(k, String(v));
  }
  const res = await apiFetch(`/api/airfoils?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /api/airfoils → ${res.status}`);
  return (await res.json()).items as AirfoilSummary[];
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
): string {
  return resultId ? `result:${resultId}` : `point:${slug}:${re}:${aoa}`;
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
): SimulationDetail | null {
  const key = simDetailKey(slug, re, aoa, resultId);
  const entry = simDetailCache.get(key);
  if (!entry?.value || entry.expiresAt <= Date.now()) return null;
  simDetailCache.delete(key);
  simDetailCache.set(key, entry);
  return entry.value;
}

export async function getSim(slug: string, re: number, aoa: number, resultId?: string | null): Promise<SimulationDetail> {
  const key = simDetailKey(slug, re, aoa, resultId);
  const cached = getCachedSim(slug, re, aoa, resultId);
  if (cached) return cached;
  const inFlight = simDetailCache.get(key)?.promise;
  if (inFlight) return inFlight;

  const qs = new URLSearchParams({ re: String(re), aoa: String(aoa) });
  if (resultId) qs.set("resultId", resultId);
  const promise = (async () => {
    const res = await apiFetch(`/api/airfoils/${encodeURIComponent(slug)}/sim?${qs.toString()}`, { cache: "no-store" });
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
    if (simDetailCache.get(key)?.promise === promise) simDetailCache.delete(key);
    throw error;
  }
}

export interface SimDetailPrefetchTarget {
  slug: string;
  re: number;
  aoa: number;
  resultId?: string | null;
}

function preloadSimField(detail: SimulationDetail, preferredField?: FieldId): void {
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

export async function getFieldTrack(slug: string, revisionId?: string | null): Promise<FieldTrackPoint[]> {
  const qs = new URLSearchParams();
  if (revisionId) qs.set("revisionId", revisionId);
  const res = await apiFetch(`/api/airfoils/${encodeURIComponent(slug)}/field-track?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET field-track → ${res.status}`);
  return (await res.json()).items as FieldTrackPoint[];
}

export async function getSolverWork(slug: string, revisionId?: string | null): Promise<SolverWorkPayload> {
  const qs = new URLSearchParams();
  if (revisionId) qs.set("revision", revisionId);
  const suffix = qs.toString();
  const res = await apiFetch(`/api/airfoils/${encodeURIComponent(slug)}/solver-work${suffix ? `?${suffix}` : ""}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET solver-work → ${res.status}`);
  return res.json();
}

export async function getResultEvidence(resultId: string): Promise<{ artifacts: EvidenceArtifactDTO[] }> {
  const res = await apiFetch(`/api/results/${encodeURIComponent(resultId)}/evidence`, { cache: "no-store" });
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
): Promise<{ id: string; cached: boolean; field: FieldId; role: string; url: string; mimeType: string; sha256: string; byteSize: number; paramsHash: string }> {
  const res = await apiFetch(`/api/results/${encodeURIComponent(resultId)}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

export async function createAirfoil(body: CreateAirfoilBody): Promise<AirfoilSummary> {
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
