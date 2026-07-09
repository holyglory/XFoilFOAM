import { type AirfoilSummary, f1, f2, f4 } from "@aerodb/core";

type Dir = "asc" | "desc";

export type SearchObjectiveKey = "maxLD" | "maxClmax" | "minCdmin";

export interface SearchObjective {
  key: SearchObjectiveKey;
  label: string;
  dir: Dir;
  get: (airfoil: AirfoilSummary) => number | null | undefined;
  fmt: (x: number) => string;
  sec: (airfoil: AirfoilSummary) => [string, string][];
}

export interface SearchConstraints {
  clmaxOn: boolean;
  clmaxMin: number;
  cdminOn: boolean;
  cdminMax: number;
  tcOn: boolean;
  tcMax: number;
}

export interface RankedSearchItem {
  airfoil: AirfoilSummary;
  value: number;
}

export const SEARCH_OBJECTIVES: SearchObjective[] = [
  {
    key: "maxLD",
    label: "Maximize (L/D)max",
    dir: "desc",
    get: (a) => a.ldmax,
    fmt: f1,
    sec: (a) => [["Cl,max", metricText(a.clmax, f2)], ["fit", fitText(a)]],
  },
  {
    key: "maxClmax",
    label: "Maximize Cl,max",
    dir: "desc",
    get: (a) => a.clmax,
    fmt: f2,
    sec: (a) => [["(L/D)max", metricText(a.ldmax, f1)], ["fit", fitText(a)]],
  },
  {
    key: "minCdmin",
    label: "Minimize Cd,min",
    dir: "asc",
    get: (a) => a.cdmin,
    fmt: f4,
    sec: (a) => [["(L/D)max", metricText(a.ldmax, f1)], ["Cl,max", metricText(a.clmax, f2)]],
  },
];

export function findSearchObjective(key: string): SearchObjective {
  return SEARCH_OBJECTIVES.find((objective) => objective.key === key) ?? SEARCH_OBJECTIVES[0];
}

export function rankSearchItems(items: AirfoilSummary[], objectiveKey: string, constraints: SearchConstraints): RankedSearchItem[] {
  const objective = findSearchObjective(objectiveKey);
  const ranked = items.flatMap((airfoil) => {
    const value = objective.get(airfoil);
    if (airfoil.polarCount <= 0 || !isFiniteMetric(value)) return [];
    if (!passesConstraints(airfoil, constraints)) return [];
    return [{ airfoil, value }];
  });
  ranked.sort((x, y) => (objective.dir === "asc" ? x.value - y.value : y.value - x.value));
  return ranked;
}

function passesConstraints(airfoil: AirfoilSummary, constraints: SearchConstraints): boolean {
  if (constraints.clmaxOn && (!isFiniteMetric(airfoil.clmax) || airfoil.clmax < constraints.clmaxMin)) return false;
  if (constraints.cdminOn && (!isFiniteMetric(airfoil.cdmin) || airfoil.cdmin > constraints.cdminMax)) return false;
  if (constraints.tcOn && (!isFiniteMetric(airfoil.thicknessPct) || airfoil.thicknessPct > constraints.tcMax)) return false;
  return true;
}

function isFiniteMetric(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function metricText(value: number | null | undefined, fmt: (value: number) => string): string {
  return isFiniteMetric(value) ? fmt(value) : "-";
}

function fitText(airfoil: AirfoilSummary): string {
  const status = airfoil.fitStatus ?? "cached";
  return `${status} · ${airfoil.polarCount}`;
}
