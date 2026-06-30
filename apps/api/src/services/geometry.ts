import { type AirfoilGeometry, deriveGeometry, nacaGeometry, type Point } from "@aerodb/core";
import type { Airfoil } from "@aerodb/db";

/** Reconstruct full geometry (contour + camber line + metrics) from a stored row. */
export function geometryFor(a: Airfoil): AirfoilGeometry {
  if (a.nacaT != null && a.nacaM != null && a.nacaP != null) {
    return nacaGeometry({ t: a.nacaT, m: a.nacaM, p: a.nacaP });
  }
  return deriveGeometry(a.points as Point[]);
}

/** Thickness/camber fractions used to synthesize polars. */
export function thicknessCamber(a: Airfoil): { t: number; m: number } {
  return { t: (a.thicknessPct ?? 0) / 100, m: (a.camberPct ?? 0) / 100 };
}
