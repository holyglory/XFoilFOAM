import type { NacaParams } from "./types";

/** Parse a NACA 4-digit designation ("2412") into fractional t/m/p. */
export function parseNaca4(digits: string): NacaParams {
  const d = digits.replace(/[^0-9]/g, "");
  if (d.length !== 4) throw new Error(`not a 4-digit NACA designation: ${digits}`);
  const m = parseInt(d[0], 10) / 100;
  const p = parseInt(d[1], 10) / 10;
  const t = parseInt(d.slice(2), 10) / 100;
  return { t, m, p };
}

export function naca4Name(digits: string): string {
  return "NACA " + digits.replace(/[^0-9]/g, "");
}
