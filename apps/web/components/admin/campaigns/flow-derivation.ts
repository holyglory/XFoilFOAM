// Client-side Re/Mach derivation for the condition preview (spec §11/§12:
// derived values only where fully determined). Mirrors the derivation used by
// the preset editor's flow panel in AdminConsole.tsx (dynamicViscosity +
// previewFlow, un-exported there) — same viscosity models, same ideal-gas
// density correction — so wizard previews match the library's derived chips.

import type { MediumDTO } from "@aerodb/core";

export function mediumDynamicViscosity(medium: MediumDTO, tempK: number): number {
  if (medium.viscosityModel === "constant") return medium.constantDynamicViscosity ?? medium.dynamicViscosity;
  if (medium.viscosityModel === "sutherland") {
    const muRef = medium.sutherlandMuRef ?? medium.dynamicViscosity;
    const tRef = medium.sutherlandTRef ?? medium.refTemperatureK;
    const s = medium.sutherlandS ?? 110.4;
    return muRef * Math.pow(tempK / tRef, 1.5) * ((tRef + s) / (tempK + s));
  }
  const rows = [...medium.viscosityTable].sort((a, b) => a.temperatureK - b.temperatureK);
  const temps = rows.map((p) => p.temperatureK);
  const mus = rows.map((p) => p.dynamicViscosity);
  if (!temps.length) return medium.dynamicViscosity;
  if (tempK <= temps[0]) return mus[0];
  if (tempK >= temps[temps.length - 1]) return mus[mus.length - 1];
  for (let i = 0; i < temps.length - 1; i++) {
    if (tempK >= temps[i] && tempK <= temps[i + 1]) {
      const t = (tempK - temps[i]) / (temps[i + 1] - temps[i]);
      return mus[i] + (mus[i + 1] - mus[i]) * t;
    }
  }
  return mus[mus.length - 1];
}

export interface DerivedFlow {
  density: number;
  dynamicViscosity: number;
  kinematicViscosity: number;
  reynolds: number;
  /** null when the medium has no speed of sound — never invented (spec §12). */
  mach: number | null;
}

export function deriveFlow(
  medium: MediumDTO,
  temperatureK: number,
  pressurePa: number,
  speedMps: number,
  chordM: number,
): DerivedFlow {
  const mu = mediumDynamicViscosity(medium, temperatureK);
  const density =
    medium.phase === "gas"
      ? medium.density * (pressurePa / medium.refPressurePa) * (medium.refTemperatureK / temperatureK)
      : medium.density;
  const kinematicViscosity = mu / density;
  const reynolds = (speedMps * chordM) / kinematicViscosity;
  const mach = medium.speedOfSound ? speedMps / medium.speedOfSound : null;
  return { density, dynamicViscosity: mu, kinematicViscosity, reynolds, mach };
}
