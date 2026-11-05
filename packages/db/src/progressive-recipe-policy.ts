import { sql, type SQL } from "drizzle-orm";

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

export function progressiveBenchmarkAttemptSql(attemptId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM result_attempts benchmark_raw
    JOIN progressive_cfd_attempts benchmark_attempt
      ON benchmark_attempt.sim_job_id = benchmark_raw.sim_job_id
    JOIN progressive_cfd_units benchmark_unit
      ON benchmark_unit.id = benchmark_attempt.unit_id
      AND benchmark_unit.aoa_deg = benchmark_raw.aoa_deg
    JOIN progressive_work benchmark_work ON benchmark_work.id = benchmark_unit.work_id
    JOIN progressive_generations benchmark_generation
      ON benchmark_generation.id = benchmark_work.generation_id
    JOIN progressive_generation_targets benchmark_scope
      ON benchmark_scope.generation_id = benchmark_generation.id
      AND benchmark_scope.target_id = benchmark_work.target_id
    WHERE benchmark_raw.id = ${attemptId}
      AND (benchmark_generation.benchmark_only OR (benchmark_work.stage = 2
        AND benchmark_scope.recipes->'fast'->>'publication' = ${PROGRESSIVE_BENCHMARK_PUBLICATION}))
  )`;
}

export function progressiveRevisionHasBenchmarkSql(
  airfoilId: SQL,
  revisionId: SQL,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM results benchmark_result
    WHERE benchmark_result.airfoil_id = ${airfoilId}
      AND benchmark_result.simulation_preset_revision_id = ${revisionId}
      AND ${progressiveBenchmarkAttemptSql(sql`benchmark_result.current_result_attempt_id`)}
  )`;
}
