import { makeContext } from "./config";
import { repairMissingPredictions } from "./repair-missing-predictions";

const [campaignId, maximum] = process.argv.slice(2);
if (
  process.argv.length !== 4 ||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
    campaignId,
  )
)
  throw new Error("Specify the exact campaign UUID and maximum repair count");
const { db, sql, engine } = makeContext();
try {
  console.log(
    JSON.stringify(
      await repairMissingPredictions(db, engine, campaignId, Number(maximum)),
    ),
  );
} finally {
  await sql.end();
}
