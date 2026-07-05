// International Standard Atmosphere (ISA / ICAO 1993, identical to the
// US Standard Atmosphere 1976 below 47 km) — deterministic T/P from geopotential
// altitude for the wizard's "standard atmosphere at altitude…" helper.
//
// Exact constants (documented per task requirement):
//   T0 = 288.15 K      sea-level standard temperature
//   P0 = 101325 Pa     sea-level standard pressure
//   g0 = 9.80665 m/s²  standard gravity
//   R  = 287.05287 J/(kg·K)  specific gas constant of air (ICAO)
// Layers (base geopotential altitude m, lapse rate K/m):
//   0 m      → −0.0065      (troposphere)
//   11 000 m → 0            (tropopause)
//   20 000 m → +0.001       (stratosphere 1)
//   32 000 m → +0.0028      (stratosphere 2)
//   47 000 m  upper limit supported here
// Within a gradient layer: T = Tb + L·(h−hb); P = Pb·(T/Tb)^(−g0/(L·R)).
// Within an isothermal layer: P = Pb·exp(−g0·(h−hb)/(R·Tb)).

export const ISA_T0_K = 288.15;
export const ISA_P0_PA = 101325;
export const ISA_G0 = 9.80665;
export const ISA_R = 287.05287;
export const ISA_MAX_ALTITUDE_M = 47000;
export const ISA_MIN_ALTITUDE_M = -5000; // ICAO tables extend below sea level

interface IsaLayer {
  baseAltitudeM: number;
  lapseKPerM: number;
  topAltitudeM: number;
}

const LAYERS: IsaLayer[] = [
  { baseAltitudeM: ISA_MIN_ALTITUDE_M, lapseKPerM: -0.0065, topAltitudeM: 11000 },
  { baseAltitudeM: 11000, lapseKPerM: 0, topAltitudeM: 20000 },
  { baseAltitudeM: 20000, lapseKPerM: 0.001, topAltitudeM: 32000 },
  { baseAltitudeM: 32000, lapseKPerM: 0.0028, topAltitudeM: ISA_MAX_ALTITUDE_M },
];

export interface IsaState {
  altitudeM: number;
  temperatureK: number;
  pressurePa: number;
}

/** ISA temperature/pressure at a geopotential altitude in metres.
 *  Throws outside [-5000, 47000] m — the helper never extrapolates. */
export function isaAtmosphere(altitudeM: number): IsaState {
  if (!Number.isFinite(altitudeM)) throw new Error("altitude must be a finite number of metres");
  if (altitudeM < ISA_MIN_ALTITUDE_M || altitudeM > ISA_MAX_ALTITUDE_M) {
    throw new Error(`ISA helper supports ${ISA_MIN_ALTITUDE_M}…${ISA_MAX_ALTITUDE_M} m (got ${altitudeM} m)`);
  }
  // Sea-level anchor: integrate downward/upward from (0 m, T0, P0) through the
  // layer boundaries so h = 0 reproduces T0/P0 exactly.
  let baseT = ISA_T0_K;
  let baseP = ISA_P0_PA;
  let baseH = 0;
  const step = (layer: IsaLayer, fromH: number, fromT: number, fromP: number, toH: number): { t: number; p: number } => {
    const dh = toH - fromH;
    if (layer.lapseKPerM === 0) {
      return { t: fromT, p: fromP * Math.exp((-ISA_G0 * dh) / (ISA_R * fromT)) };
    }
    const t = fromT + layer.lapseKPerM * dh;
    const p = fromP * Math.pow(t / fromT, -ISA_G0 / (layer.lapseKPerM * ISA_R));
    return { t, p };
  };

  if (altitudeM >= 0) {
    for (const layer of LAYERS) {
      if (baseH >= altitudeM) break;
      const toH = Math.min(altitudeM, layer.topAltitudeM);
      if (toH <= baseH) continue;
      const { t, p } = step(layer, baseH, baseT, baseP, toH);
      baseT = t;
      baseP = p;
      baseH = toH;
    }
  } else {
    // Below sea level: still the troposphere gradient layer.
    const { t, p } = step(LAYERS[0], 0, baseT, baseP, altitudeM);
    baseT = t;
    baseP = p;
  }
  return { altitudeM, temperatureK: baseT, pressurePa: baseP };
}
