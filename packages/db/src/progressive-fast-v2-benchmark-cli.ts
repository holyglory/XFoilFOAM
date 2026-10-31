import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "./client";
import {
  buildFastV2BenchmarkPlan,
  buildFastV2BenchmarkReport,
  campaignCases,
  launchFastV2Benchmark,
  readFastV2BenchmarkReport,
  type FastV2BenchmarkCaseInput,
  type FastV2BenchmarkMeasurements,
} from "./progressive-fast-v2-benchmark";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function repeatedOption(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1)
    if (process.argv[index] === name && process.argv[index + 1])
      values.push(process.argv[index + 1]!);
  return values;
}

const benchmarkId = option("--benchmark-id");
const inputPath = option("--input");
const campaignId = option("--campaign-id");
const outputPath = option("--output");
const measurementsPath = option("--measurements");
const profileIds = repeatedOption("--profile-id");
const conditionIds = repeatedOption("--condition-id");
const sourceCampaignId = option("--source-campaign-id");
const benchmarkCampaignId = option("--benchmark-campaign-id");
const launch = process.argv.includes("--launch");
const reportOnly = process.argv.includes("--report");

async function writeReport(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

if (launch) {
  if (
    !benchmarkId ||
    !sourceCampaignId ||
    !outputPath ||
    !profileIds.length ||
    !conditionIds.length
  )
    throw new Error(
      "Usage: --launch --benchmark-id ID --source-campaign-id UUID --profile-id UUID --condition-id UUID [...] --output REPORT.json",
    );
  const { db, sql: client } = createClient({ max: 1 });
  try {
    const result = await launchFastV2Benchmark(db, {
      benchmarkId,
      sourceCampaignId,
      profileIds,
      conditionIds,
    });
    const report = await readFastV2BenchmarkReport(
      db,
      result.benchmarkCampaignId,
    );
    await writeReport(outputPath, { launch: result, report });
    console.log(
      JSON.stringify({
        output: outputPath,
        benchmarkCampaignId: result.benchmarkCampaignId,
        initializedFastUnits: result.initializedFastUnits,
        status: report.status,
      }),
    );
  } finally {
    await client.end();
  }
} else if (reportOnly) {
  if (!benchmarkCampaignId || !outputPath)
    throw new Error(
      "Usage: --report --benchmark-campaign-id UUID --output REPORT.json",
    );
  const { db, sql: client } = createClient({ max: 1 });
  try {
    const report = await readFastV2BenchmarkReport(db, benchmarkCampaignId);
    await writeReport(outputPath, report);
    console.log(JSON.stringify({ output: outputPath, status: report.status }));
  } finally {
    await client.end();
  }
} else {
  if (
    !benchmarkId ||
    !outputPath ||
    (inputPath && campaignId) ||
    (!inputPath && !campaignId)
  )
    throw new Error(
      "Usage: --benchmark-id ID --output REPORT.json (--input CASES.json | --campaign-id UUID --profile-id UUID --condition-id UUID [...]) [--measurements RUNS.json]",
    );

  let cases: FastV2BenchmarkCaseInput[];
  if (inputPath) {
    const input = JSON.parse(await readFile(inputPath, "utf8")) as {
      cases?: FastV2BenchmarkCaseInput[];
    };
    if (!Array.isArray(input.cases))
      throw new Error("Benchmark input must contain a cases array");
    cases = input.cases;
  } else {
    const { db, sql: client } = createClient({ max: 1 });
    try {
      cases = await campaignCases(db, campaignId!, profileIds, conditionIds);
    } finally {
      await client.end();
    }
  }

  const plan = buildFastV2BenchmarkPlan({ benchmarkId, cases });
  let measurements: FastV2BenchmarkMeasurements | null = null;
  if (measurementsPath)
    measurements = JSON.parse(
      await readFile(measurementsPath, "utf8"),
    ) as FastV2BenchmarkMeasurements;
  await writeReport(outputPath, buildFastV2BenchmarkReport(plan, measurements));
  console.log(
    JSON.stringify({
      output: outputPath,
      status: measurements ? "measured" : "plan_only",
    }),
  );
}
