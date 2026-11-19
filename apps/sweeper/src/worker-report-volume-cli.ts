import { configuredDeploymentRole } from "./config";
import { storeWorkerReportVolume } from "./worker-report-volume";
const [command, storedSha256, rawSize, ...extra] = process.argv.slice(2);
if (
  configuredDeploymentRole() !== "remote-solver" ||
  command !== "store" ||
  !storedSha256 ||
  !rawSize ||
  !/^[1-9][0-9]*$/.test(rawSize) ||
  extra.length
)
  throw new Error("Expected store SHA256 BYTE_SIZE on the source worker");
const identity = { storedSha256, storedByteSize: Number(rawSize) };
await storeWorkerReportVolume(process.stdin, identity);
console.log(JSON.stringify({ ...identity, verified: true }));
