export type UnitDimension = "temperature" | "length" | "speed" | "pressure";

export interface UnitDefinition {
  key: string;
  label: string;
  fromSi: (value: number) => number;
  toSi: (value: number) => number;
}

const identity = (value: number) => value;

export const UNIT_DEFINITIONS: Record<UnitDimension, UnitDefinition[]> = {
  temperature: [
    { key: "K", label: "K", fromSi: identity, toSi: identity },
    { key: "C", label: "°C", fromSi: (value) => value - 273.15, toSi: (value) => value + 273.15 },
    { key: "F", label: "°F", fromSi: (value) => (value - 273.15) * (9 / 5) + 32, toSi: (value) => (value - 32) * (5 / 9) + 273.15 },
  ],
  length: [
    { key: "m", label: "m", fromSi: identity, toSi: identity },
    { key: "cm", label: "cm", fromSi: (value) => value * 100, toSi: (value) => value / 100 },
    { key: "mm", label: "mm", fromSi: (value) => value * 1000, toSi: (value) => value / 1000 },
    { key: "in", label: "in", fromSi: (value) => value / 0.0254, toSi: (value) => value * 0.0254 },
    { key: "ft", label: "ft", fromSi: (value) => value / 0.3048, toSi: (value) => value * 0.3048 },
  ],
  speed: [
    { key: "mps", label: "m/s", fromSi: identity, toSi: identity },
    { key: "kmh", label: "km/h", fromSi: (value) => value * 3.6, toSi: (value) => value / 3.6 },
    { key: "mph", label: "mph", fromSi: (value) => value / 0.44704, toSi: (value) => value * 0.44704 },
    { key: "kt", label: "kt", fromSi: (value) => value / 0.514444444, toSi: (value) => value * 0.514444444 },
  ],
  pressure: [
    { key: "Pa", label: "Pa", fromSi: identity, toSi: identity },
    { key: "kPa", label: "kPa", fromSi: (value) => value / 1000, toSi: (value) => value * 1000 },
    { key: "bar", label: "bar", fromSi: (value) => value / 100000, toSi: (value) => value * 100000 },
    { key: "atm", label: "atm", fromSi: (value) => value / 101325, toSi: (value) => value * 101325 },
    { key: "psi", label: "psi", fromSi: (value) => value / 6894.757293168, toSi: (value) => value * 6894.757293168 },
  ],
};

export function unitFor(dimension: UnitDimension, key?: string): UnitDefinition {
  const units = UNIT_DEFINITIONS[dimension];
  return units.find((unit) => unit.key === key) ?? units[0];
}

export function parseUnitNumber(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function formatUnitNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 1000) return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, "");
  if (Math.abs(value) >= 100) return value.toFixed(3).replace(/\.?0+$/, "");
  if (Math.abs(value) >= 10) return value.toFixed(4).replace(/\.?0+$/, "");
  if (Math.abs(value) >= 1) return value.toFixed(5).replace(/\.?0+$/, "");
  if (value === 0) return "0";
  return value.toPrecision(6).replace(/\.?0+$/, "");
}

export function siToUnit(valueSi: number, dimension: UnitDimension, unitKey?: string): number {
  return unitFor(dimension, unitKey).fromSi(valueSi);
}

export function unitToSi(value: number, dimension: UnitDimension, unitKey?: string): number {
  return unitFor(dimension, unitKey).toSi(value);
}
