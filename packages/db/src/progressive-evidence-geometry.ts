import type { AnalysisPhysical } from "./analysis-target";

export const SOURCE_GEOMETRY_MESH_VERSION = 3;
export const SOURCE_GEOMETRY_POLICY_VERSION = 1;

export function geometryRequiresPreservation(
  geometry: AnalysisPhysical["geometry"],
): boolean {
  if (
    geometry.length < 3 ||
    geometry.some(
      (point) => point.length !== 2 || !point.every(Number.isFinite),
    )
  )
    throw new Error("A polar requires finite source geometry");
  const first = geometry[0];
  const last = geometry[geometry.length - 1];
  const leading = geometry.reduce((previous, point) =>
    point[0] < previous[0] ? point : previous,
  );
  const chord = Math.hypot(
    (first[0] + last[0]) / 2 - leading[0],
    (first[1] + last[1]) / 2 - leading[1],
  );
  if (!(chord > 0)) throw new Error("Source geometry has no chord length");
  return Math.hypot(first[0] - last[0], first[1] - last[1]) > chord * 1e-10;
}

export function progressiveEvidencePreservesGeometry(
  physical: Pick<AnalysisPhysical, "geometry">,
  payload: Record<string, unknown>,
): boolean {
  if (!geometryRequiresPreservation(physical.geometry)) return true;
  const version = payload.mesh_recovery_version;
  return (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= SOURCE_GEOMETRY_MESH_VERSION &&
    version <= 2_147_483_647
  );
}
