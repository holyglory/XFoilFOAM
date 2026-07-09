export interface UransMeshNumerics {
  uransMeshProfileId?: string | null;
  uransPrecalcMeshProfileId?: string | null;
}

export interface MeshProfileLabelRow {
  id: string;
  name: string;
}

export function normalizeUransMeshId(id: string | null | undefined): string | null {
  return id?.trim() ? id : null;
}

export function withUransMeshDefaults<T extends UransMeshNumerics>(numerics: T): T & {
  uransMeshProfileId: string | null;
  uransPrecalcMeshProfileId: string | null;
} {
  return {
    ...numerics,
    uransMeshProfileId: normalizeUransMeshId(numerics.uransMeshProfileId),
    uransPrecalcMeshProfileId: normalizeUransMeshId(numerics.uransPrecalcMeshProfileId),
  };
}

function meshLabel(id: string | null | undefined, meshProfiles: MeshProfileLabelRow[]): string {
  const normalized = normalizeUransMeshId(id);
  if (!normalized) return "Derived";
  return meshProfiles.find((row) => row.id === normalized)?.name ?? "unavailable profile";
}

export function formatUransMeshReviewSummary(numerics: UransMeshNumerics, meshProfiles: MeshProfileLabelRow[]): string {
  const fullId = normalizeUransMeshId(numerics.uransMeshProfileId);
  const precalcId = normalizeUransMeshId(numerics.uransPrecalcMeshProfileId);
  if (!fullId && !precalcId) return "Derived";
  return `Full: ${meshLabel(fullId, meshProfiles)} · Precalc: ${meshLabel(precalcId, meshProfiles)}`;
}

export function formatUransMeshDisclosureValue(numerics: UransMeshNumerics, meshProfiles: MeshProfileLabelRow[]): string {
  const fullId = normalizeUransMeshId(numerics.uransMeshProfileId);
  const precalcId = normalizeUransMeshId(numerics.uransPrecalcMeshProfileId);
  if (!fullId && !precalcId) return "Derived (default)";
  return formatUransMeshReviewSummary(numerics, meshProfiles);
}
