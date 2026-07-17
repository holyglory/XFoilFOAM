import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { makeContext } from "./config";
import {
  admitOneSuccessor,
  productionSuccessorAdmissionDependencies,
  type SuccessorAdmissionTarget,
} from "./successor-continuation-once";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredUuid(name: string, value: string | undefined): string {
  if (!value || !UUID.test(value))
    throw new Error(`--${name} must be an exact UUID`);
  return value.toLowerCase();
}

export function parseSuccessorAdmissionArgs(
  argv: string[],
): SuccessorAdmissionTarget {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      "campaign-id": { type: "string" },
      "canary-attestation-id": { type: "string" },
      "target-plan-revision-id": { type: "string" },
      "target-generation": { type: "string" },
    },
  });
  if (positionals.length)
    throw new Error(`unexpected positional argument: ${positionals[0]}`);
  const generationText = values["target-generation"];
  const targetGeneration = Number(generationText);
  if (
    !generationText ||
    !/^[1-9][0-9]*$/.test(generationText) ||
    !Number.isSafeInteger(targetGeneration)
  )
    throw new Error("--target-generation must be a positive integer");
  return {
    campaignId: requiredUuid("campaign-id", values["campaign-id"]),
    canaryAttestationId: requiredUuid(
      "canary-attestation-id",
      values["canary-attestation-id"],
    ),
    targetPlanRevisionId: requiredUuid(
      "target-plan-revision-id",
      values["target-plan-revision-id"],
    ),
    targetGeneration,
  };
}

/**
 * The deployment wrapper treats stdout as a machine-readable, single-JSON
 * receipt.  The normal sweeper submit path logs successful engine admission
 * with console.log, so route every operational log to stderr while the
 * one-shot admission runs and restore the process console before returning.
 */
export async function withOperationalLogsOnStderr<T>(
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
  const target = parseSuccessorAdmissionArgs(process.argv.slice(2));
  const { db, sql, engine } = makeContext();
  try {
    const receipt = await withOperationalLogsOnStderr(() =>
      admitOneSuccessor(
        target,
        productionSuccessorAdmissionDependencies(db, engine),
      ),
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await sql.end();
  }
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
