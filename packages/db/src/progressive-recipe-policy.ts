export const PROGRESSIVE_FAST_V2_BENCHMARK_RECIPE_ID =
  "openfoam-fast-v2-benchmark" as const;
export const PROGRESSIVE_BENCHMARK_PUBLICATION = "benchmark_only" as const;

export type ProgressiveFastRecipeVariant = "current" | "fast-v2-benchmark";

export type ProgressiveRecipeOptions =
  | {
      fastRecipeVariant?: "current";
      benchmarkCohort?: never;
    }
  | {
      fastRecipeVariant: "fast-v2-benchmark";
      benchmarkCohort: "low-mach";
    };

export function isLowMachBenchmarkMach(mach: number | null): boolean {
  return mach !== null && Number.isFinite(mach) && mach >= 0 && mach < 1;
}

export function progressiveRecipeIsPublicationEligible(
  recipe: Record<string, unknown>,
): boolean {
  return recipe.publication !== PROGRESSIVE_BENCHMARK_PUBLICATION;
}
