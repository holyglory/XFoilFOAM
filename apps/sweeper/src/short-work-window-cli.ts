import { parseArgs } from "node:util";
import { createClient } from "@aerodb/db/client";
import { analysisContentHash } from "@aerodb/db/analysis-target";
import {
  enableShortWork,
  endShortWork,
  previewShortWork,
  shortWorkStatus,
} from "./short-work-window";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      solver: { type: "string" },
      work: { type: "string" },
      pool: { type: "string" },
      slots: { type: "string" },
      "max-active-seconds": { type: "string" },
      until: { type: "string" },
      "expect-sha256": { type: "string" },
      window: { type: "string" },
    },
  });
  const [action] = positionals;
  if (
    positionals.length !== 1 ||
    !action ||
    !["preview", "enable", "status", "end"].includes(action) ||
    !values.solver
  )
    throw new Error(
      "Usage: short-work-window preview|enable|status|end --solver ID (preview/enable: --work ID --pool KEY [--slots N] --max-active-seconds N; enable: --expect-sha256 SHA --until UTC; end: --window ID)",
    );
  const client = createClient();
  try {
    const selection = {
      solverId: values.solver,
      workId: values.work ?? "",
      pool: values.pool ?? "",
      slots: values.slots === undefined ? undefined : Number(values.slots),
      maxActiveSeconds: Number(values["max-active-seconds"]),
    };
    let result;
    switch (action) {
      case "preview": {
        const plan = await client.db.transaction(
          (tx) =>
            previewShortWork(tx as unknown as typeof client.db, selection),
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
        result = plan
          ? { plan, planSha256: analysisContentHash(plan) }
          : {
              plan: null,
              reason: "No complete compatible short group at the selected work",
            };
        break;
      }
      case "enable": {
        if (!values.until || !values.until.endsWith("Z"))
          throw new Error("An absolute UTC deadline ending in Z is required");
        result = await enableShortWork(
          client.db,
          selection,
          values["expect-sha256"] ?? "",
          new Date(values.until),
        );
        break;
      }
      case "end":
        result = await endShortWork(
          client.db,
          selection.solverId,
          values.window ?? "",
        );
        break;
      case "status":
        result = await shortWorkStatus(client.db, selection.solverId);
        break;
    }
    console.log(JSON.stringify(result));
  } finally {
    await client.sql.end({ timeout: 5 });
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
