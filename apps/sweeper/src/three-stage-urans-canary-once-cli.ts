import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { makeContext } from "./config";
import {
  productionThreeStageUransCanaryDependencies,
  runThreeStageUransCanaryOnce,
  type ThreeStageUransCanaryTarget,
} from "./three-stage-urans-canary-once";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export const THREE_STAGE_URANS_CANARY_USAGE = `Usage:
  pnpm --filter @aerodb/sweeper urans-canary:admit-once -- \\
    --campaign-id UUID --condition-id UUID \\
    --expected-campaign-generation INTEGER --parent-job-id UUID \\
    --airfoil-id UUID --revision-id UUID --aoa-deg DECIMAL \\
    --source-result-id UUID --source-result-attempt-id UUID \\
    --precalc-obligation-id UUID --expected-engine-build-id BUILD_ID \\
    --expected-mesh-recovery-version INTEGER \\
    --expected-urans-recovery-version INTEGER

The command admits or observes one exact RANS → preliminary URANS → final
URANS chain. Operational logs use stderr; a successful invocation writes one
JSON receipt to stdout.
`;

function requiredUuid(name: string, value: string | undefined): string {
  if (!value || !UUID.test(value))
    throw new Error(`--${name} must be an exact UUID`);
  return value.toLowerCase();
}

function requiredVersion(name: string, value: string | undefined): number {
  if (!value || !/^[0-9]+$/.test(value))
    throw new Error(`--${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647)
    throw new Error(`--${name} exceeds the durable integer range`);
  return parsed;
}

export function parseThreeStageUransCanaryArgs(
  argv: string[],
): ThreeStageUransCanaryTarget {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      "campaign-id": { type: "string" },
      "condition-id": { type: "string" },
      "expected-campaign-generation": { type: "string" },
      "parent-job-id": { type: "string" },
      "airfoil-id": { type: "string" },
      "revision-id": { type: "string" },
      "aoa-deg": { type: "string" },
      "source-result-id": { type: "string" },
      "source-result-attempt-id": { type: "string" },
      "precalc-obligation-id": { type: "string" },
      "expected-engine-build-id": { type: "string" },
      "expected-mesh-recovery-version": { type: "string" },
      "expected-urans-recovery-version": { type: "string" },
    },
  });
  if (positionals.length)
    throw new Error(`unexpected positional argument: ${positionals[0]}`);
  const aoaText = values["aoa-deg"];
  const aoaDeg = Number(aoaText);
  if (
    !aoaText ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(aoaText) ||
    !Number.isFinite(aoaDeg)
  ) {
    throw new Error("--aoa-deg must be an exact finite decimal number");
  }
  const expectedEngineBuildId = values["expected-engine-build-id"];
  if (!expectedEngineBuildId || !BUILD_ID.test(expectedEngineBuildId))
    throw new Error(
      "--expected-engine-build-id must be a nonempty safe build identifier",
    );
  const expectedUransRecoveryVersion = requiredVersion(
    "expected-urans-recovery-version",
    values["expected-urans-recovery-version"],
  );
  if (expectedUransRecoveryVersion < 2)
    throw new Error(
      "--expected-urans-recovery-version must be at least 2 for durable continuation",
    );
  const expectedCampaignGeneration = requiredVersion(
    "expected-campaign-generation",
    values["expected-campaign-generation"],
  );
  if (expectedCampaignGeneration < 1)
    throw new Error("--expected-campaign-generation must be at least 1");
  return {
    campaignId: requiredUuid("campaign-id", values["campaign-id"]),
    conditionId: requiredUuid("condition-id", values["condition-id"]),
    expectedCampaignGeneration,
    parentJobId: requiredUuid("parent-job-id", values["parent-job-id"]),
    airfoilId: requiredUuid("airfoil-id", values["airfoil-id"]),
    revisionId: requiredUuid("revision-id", values["revision-id"]),
    aoaDeg: Object.is(aoaDeg, -0) ? 0 : aoaDeg,
    sourceResultId: requiredUuid(
      "source-result-id",
      values["source-result-id"],
    ),
    sourceResultAttemptId: requiredUuid(
      "source-result-attempt-id",
      values["source-result-attempt-id"],
    ),
    precalcObligationId: requiredUuid(
      "precalc-obligation-id",
      values["precalc-obligation-id"],
    ),
    expectedEngineBuildId,
    expectedMeshRecoveryVersion: requiredVersion(
      "expected-mesh-recovery-version",
      values["expected-mesh-recovery-version"],
    ),
    expectedUransRecoveryVersion,
  };
}

/** Keep stdout reserved for one machine-readable receipt. */
export async function withThreeStageCanaryLogsOnStderr<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await operation();
  } finally {
    console.log = originalLog;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(THREE_STAGE_URANS_CANARY_USAGE);
    return;
  }
  const target = parseThreeStageUransCanaryArgs(argv);
  const result = await withThreeStageCanaryLogsOnStderr(async () => {
    const { db, sql, engine } = makeContext();
    try {
      return await runThreeStageUransCanaryOnce(
        target,
        productionThreeStageUransCanaryDependencies(db, engine, sql),
      );
    } finally {
      await sql.end();
    }
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
