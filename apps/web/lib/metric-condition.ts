import type { PolarMetricCondition } from "@aerodb/core";

export function metricConditionParam(
  value: string | string[] | undefined,
): string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : "";
}

export function conditionLabel(condition: PolarMetricCondition): string {
  const speed =
    condition.mach >= 1
      ? `Mach ${Number(condition.mach.toPrecision(3))}`
      : `${Number(condition.speedMps.toPrecision(5))} m/s`;
  return `${speed} · ${Number(condition.referenceLengthM.toPrecision(4))} m chord`;
}

export function withMetricCondition(path: string, key?: string | null): string {
  const url = new URL(path, "https://airfoils.invalid");
  if (key) url.searchParams.set("condition", key);
  else url.searchParams.delete("condition");
  return `${url.pathname}${url.search}${url.hash}`;
}
