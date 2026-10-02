import {
  createClient,
  rotateCalculationEpoch,
} from "../../packages/db/src/index.ts";

const argumentsList = process.argv.slice(2);
const reasonIndex = argumentsList.indexOf("--reason");
const authoritativeIdIndex = argumentsList.indexOf("--authoritative-id");
const reason = reasonIndex >= 0 ? argumentsList[reasonIndex + 1] : undefined;
const authoritativeId =
  authoritativeIdIndex >= 0
    ? argumentsList[authoritativeIdIndex + 1]
    : undefined;

if (!reason?.trim()) throw new Error("--reason is required");
if (
  authoritativeId !== undefined &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    authoritativeId,
  )
)
  throw new Error("--authoritative-id must be a UUID");

const { db, sql } = createClient();
try {
  const epochId = await rotateCalculationEpoch(db, reason, authoritativeId);
  console.log(JSON.stringify({ epochId, reason }));
} finally {
  await sql.end();
}
