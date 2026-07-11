import {
  derivedBySymmetryInfo,
  type AirfoilDetailPayload,
  type Polar,
  type PolarPointData,
  type ProjectChartInput,
} from "@aerodb/core";

export type SeriesVisibility = Record<string, boolean>;

export function initialSeriesVisibility(
  polars: Pick<Polar, "seriesId">[],
): SeriesVisibility {
  // The public payload contains evidence-backed series only (plus the one
  // explicit empty pinned scope). Never hide solved public polars by a legacy
  // Reynolds preference: users should see every available curve immediately.
  return Object.fromEntries(polars.map((polar) => [polar.seriesId, true]));
}

export function toggleSeriesVisibility(
  visibility: SeriesVisibility,
  seriesId: string,
): SeriesVisibility {
  return { ...visibility, [seriesId]: !visibility[seriesId] };
}

export interface PolarLegendItem {
  seriesId: string;
  label: string;
  color: string;
  pointCount: number;
  visible: boolean;
}

/** One public solved point per real AoA represented on the chart. Exact
 * duplicates stay one point, alternates never inflate coverage, and an
 * unresolved conflict-only AoA still counts once instead of producing a false
 * zero/waiting state while its stored evidence is visibly plotted. */
export function publicSolvedPointCount(points: PolarPointData[]): number {
  return new Set(
    points
      .filter(
        (point) =>
          point.source === "solved" &&
          !derivedBySymmetryInfo(point).derived &&
          point.evidenceRole !== "alternate",
      )
      .map((point) => Math.round(point.a * 100) / 100),
  ).size;
}

/** Primary evidence is the only evidence allowed to define a public polar
 * curve or a Compare marker. Conflict and alternate rows remain Detail-only
 * evidence affordances. */
export function primaryPolarEvidencePoints(
  points: PolarPointData[],
): PolarPointData[] {
  return points.filter(
    (point) =>
      point.source === "solved" &&
      (point.evidenceRole == null || point.evidenceRole === "primary"),
  );
}

/** Canonical public AoA display without throwing away stored hundredths. */
export function formatPolarAoa(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** A projected marker can represent several results and, on Cl-Cd, several
 * AoAs. Never claim one angle in the chooser heading unless all choices share
 * it; every row still displays its own exact angle. */
export function storedResultsHeading(points: PolarPointData[]): string {
  const aoas = new Set(points.map((point) => formatPolarAoa(point.a)));
  if (aoas.size === 1) {
    return `Stored results at α ${[...aoas][0]}°`;
  }
  return "Stored results at this chart point";
}

export function polarLegendItems(
  polars: ProjectChartInput["polars"],
  visibility: SeriesVisibility,
): PolarLegendItem[] {
  return polars.map((polar) => ({
    seriesId: polar.seriesId,
    label: polar.label,
    color: polar.color,
    pointCount: publicSolvedPointCount(polar.points),
    visible: Boolean(visibility[polar.seriesId]),
  }));
}

export interface PolarSeriesOption {
  seriesId: string;
  label: string;
  re: number;
  coverage: number;
}

const CONDITION_SUFFIX = / · condition \d+$/i;

function baseConditionLabel(label: string): string {
  return label.replace(CONDITION_SUFFIX, "");
}

/** Public comparison choices are the union of compatible series available on
 * the selected airfoils. A missing series on one airfoil stays an honest gap. */
export function polarSeriesOptions(
  details: Array<AirfoilDetailPayload | null | undefined>,
): PolarSeriesOption[] {
  const byId = new Map<string, PolarSeriesOption>();
  for (const detail of details) {
    const seenInDetail = new Set<string>();
    for (const polar of detail?.polars ?? []) {
      if (!byId.has(polar.seriesId)) {
        byId.set(polar.seriesId, {
          seriesId: polar.seriesId,
          label: polar.label,
          re: polar.re,
          coverage: 0,
        });
      }
      if (!seenInDetail.has(polar.seriesId)) {
        byId.get(polar.seriesId)!.coverage += 1;
        seenInDetail.add(polar.seriesId);
      }
    }
  }
  const options = [...byId.values()].sort(
    (a, b) =>
      a.re - b.re ||
      a.label.localeCompare(b.label) ||
      a.seriesId.localeCompare(b.seriesId),
  );

  // A series can be unique inside each individual airfoil payload yet collide
  // with another series after Compare unions several payloads. Re-disambiguate
  // that union with neutral public condition ordinals, never internal names.
  const byBaseLabel = new Map<string, PolarSeriesOption[]>();
  for (const option of options) {
    const base = baseConditionLabel(option.label);
    const collisions = byBaseLabel.get(base) ?? [];
    collisions.push(option);
    byBaseLabel.set(base, collisions);
  }
  for (const [base, collisions] of byBaseLabel) {
    if (collisions.length < 2) continue;
    collisions.sort((a, b) => a.seriesId.localeCompare(b.seriesId));
    collisions.forEach((option, index) => {
      option.label = `${base} · condition ${index + 1}`;
    });
  }
  return options.sort(
    (a, b) =>
      a.re - b.re ||
      a.label.localeCompare(b.label) ||
      a.seriesId.localeCompare(b.seriesId),
  );
}

/** Keep a user's valid choice. Automatic selection maximizes how many selected
 * airfoils can actually be compared; the historical 300k preference breaks a
 * coverage tie, then the stable option order is the final tie-break. */
export function activePolarSeriesId(
  options: PolarSeriesOption[],
  requestedSeriesId: string | null,
  preferredRe = 300000,
): string | null {
  if (
    requestedSeriesId &&
    options.some((option) => option.seriesId === requestedSeriesId)
  ) {
    return requestedSeriesId;
  }
  let best: PolarSeriesOption | null = null;
  for (const option of options) {
    if (
      !best ||
      option.coverage > best.coverage ||
      (option.coverage === best.coverage &&
        option.re === preferredRe &&
        best.re !== preferredRe)
    ) {
      best = option;
    }
  }
  return best?.seriesId ?? null;
}

/** Mach display for the chart toolbar, derived only from visible public
 * series. Multiple values render as an honest range instead of borrowing the
 * first series' Mach for the whole chart. */
export function visibleMachDisplay(
  polars: Pick<Polar, "seriesId" | "mach">[],
  visibility: SeriesVisibility,
): string {
  const values = [
    ...new Set(
      polars
        .filter((polar) => visibility[polar.seriesId] && polar.mach != null)
        .map((polar) => polar.mach!.toFixed(2)),
    ),
  ].sort((a, b) => Number(a) - Number(b));
  if (values.length === 0) return "—";
  if (values.length === 1) return values[0];
  return `${values[0]}–${values[values.length - 1]}`;
}
