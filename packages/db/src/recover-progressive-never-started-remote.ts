import { readFile } from "node:fs/promises";
import { createClient } from "./client";
import {
  recoverOperatorVerifiedNeverStartedRemoteDispatches,
  type OperatorStaleRemoteDispatch,
} from "./progressive-cfd-settlement";

const [solverId, operator, dispatchFile, expectedCountText, mode = "--dry-run"] =
  process.argv.slice(2);
const expectedCount = Number(expectedCountText);
if (
  !solverId ||
  !operator ||
  !dispatchFile ||
  !Number.isSafeInteger(expectedCount) ||
  !["--dry-run", "--apply"].includes(mode) ||
  process.argv.length > 7
)
  throw new Error(
    "Usage: recover-progressive-never-started-remote SOLVER_UUID OPERATOR DISPATCH_JSON EXPECTED_COUNT [--dry-run|--apply]",
  );

const dispatches = JSON.parse(await readFile(dispatchFile, "utf8")) as OperatorStaleRemoteDispatch[];
const { db, sql } = createClient({ max: 1 });
const rollback = new Error("never-started remote recovery dry-run rollback");
let result: Awaited<ReturnType<typeof recoverOperatorVerifiedNeverStartedRemoteDispatches>> | undefined;
try {
  await db
    .transaction(async (transaction) => {
      result = await recoverOperatorVerifiedNeverStartedRemoteDispatches(
        transaction as unknown as typeof db,
        {
          solverId,
          operator,
          dispatches,
          expectedCount,
          crossHostAbsenceConfirmed: true,
        },
      );
      if (mode === "--dry-run") throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
  console.log(JSON.stringify({ mode, result }));
} finally {
  await sql.end();
}
