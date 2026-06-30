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

export async function getAirfoilDetail(slug: string): Promise<AirfoilDetailPayload | null> {
  const res = await apiFetch(`/api/airfoils/${encodeURIComponent(slug)}`, {
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

export async function getSim(slug: string, re: number, aoa: number, resultId?: string | null): Promise<SimulationDetail> {
  const qs = new URLSearchParams({ re: String(re), aoa: String(aoa) });
  if (resultId) qs.set("resultId", resultId);
  const res = await apiFetch(`/api/airfoils/${encodeURIComponent(slug)}/sim?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET sim → ${res.status}`);
  return res.json();
}

export async function getFieldTrack(slug: string, revisionId?: string | null): Promise<FieldTrackPoint[]> {
  const qs = new URLSearchParams();
  if (revisionId) qs.set("revisionId", revisionId);
  const res = await apiFetch(`/api/airfoils/${encodeURIComponent(slug)}/field-track?${qs.toString()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET field-track → ${res.status}`);
  return (await res.json()).items as FieldTrackPoint[];
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
