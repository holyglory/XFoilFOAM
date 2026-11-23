import {
  assertRegisteredPage,
  requireReportProof,
  type HubReportLink,
} from "./registered-worker-report-read";
import type { SourceKey } from "./registered-worker-report-hub";
export type ReaderProof = {
  signature: string;
  generation: string;
  sha256: string;
  byteSize: number;
  at: string;
};
type Endpoint = (
  operation: string,
  data: Record<string, unknown>,
) => Promise<any>;
interface PageConnections {
  hub: Endpoint;
  api: Endpoint;
  worker: Endpoint;
  write: Endpoint;
}
export const sourceKey = (l: HubReportLink): SourceKey => ({
  executionId: l.pin.executionId,
  sequence: l.pin.sequence,
  signature: l.pin.signature,
});
const held = new Set([
  "source_open",
  "other_storage",
  "source_ineligible",
  "science_not_settled",
]);

// Each remote writer owns the shared deployment lock for just one bounded
// prefix. Finish the remainder in a new session after the preceding one exits.
async function writeAll(
  links: HubReportLink[],
  call: (offset: number) => Promise<unknown>,
  allowed: string[],
) {
  const result: string[] = [];
  while (result.length < links.length) {
    const response = await call(result.length);
    requireReportProof(
      Array.isArray(response) &&
        response.length > 0 &&
        response.length <= links.length - result.length &&
        response.every(
          (x) => typeof x === "string" && (held.has(x) || allowed.includes(x)),
        ),
      "Invalid bounded native write response",
    );
    result.push(...response);
  }
  return result;
}
function checkReads(links: HubReportLink[], reads: ReaderProof[]) {
  requireReportProof(
    Array.isArray(reads) && reads.length === links.length,
    "Incomplete normal reader confirmations",
  );
  for (const [i, l] of links.entries()) {
    const r = reads[i];
    requireReportProof(
      r &&
        r.signature === l.pin.signature &&
        r.generation === l.pin.generation &&
        r.sha256 === l.pin.reportSha256 &&
        r.byteSize === l.pin.reportByteSize,
      "Registered page consumer differs",
    );
  }
}
export async function applyRegisteredPage(
  peers: PageConnections,
  links: HubReportLink[],
  account: string,
  confirm: (
    link: HubReportLink,
    cloudAt: string,
    api: ReaderProof,
    sweeper: ReaderProof,
  ) => Promise<void>,
) {
  assertRegisteredPage(links);
  const present = await peers.worker("volume_present", { links });
  requireReportProof(
    typeof present === "boolean",
    "Invalid worker volume presence",
  );
  // Presence is only a transfer hint. The hub always reopens the original
  // generation. HZ authenticates its compressed file and every selected member.
  const cloud = await peers.hub("restore_page", {
    links,
    account,
    needBytes: !present,
  });
  requireReportProof(
    cloud &&
      cloud.sha === links[0]!.pin.storedSha256 &&
      typeof cloud.at === "string" &&
      (present ? cloud.packed === null : typeof cloud.packed === "string"),
    "Fresh registered generation unavailable",
  );
  const statuses = await writeAll(
    links,
    (i) =>
      peers.write("stage_page", {
        links: links.slice(i),
        bytes: i ? null : cloud.packed,
        cloudAt: cloud.at,
      }),
    ["staged", "already_retired"],
  );
  const staged = links.filter((_, i) =>
    ["staged", "already_retired"].includes(statuses[i]!),
  );
  if (!staged.length) return statuses;
  async function read(ready: HubReportLink[], committed: boolean) {
    const params = { links: ready, committed };
    const [a, s] = await Promise.all([
      peers.api("read_page", { ...params, reader: "api" }),
      peers.worker("read_page", { ...params, reader: "sweeper" }),
    ]);
    checkReads(ready, a);
    checkReads(ready, s);
    return { api: a as ReaderProof[], sweeper: s as ReaderProof[] };
  }
  const before = await read(staged, false);
  const retired = await writeAll(
    staged,
    (i) =>
      peers.write("retire_page", {
        links: staged.slice(i),
        cloudAt: cloud.at,
        api: before.api.slice(i),
        sweeper: before.sweeper.slice(i),
      }),
    ["retired", "already_retired"],
  );
  const bySeq = new Map(staged.map((l, i) => [l.pin.sequence, retired[i]!]));
  const cold = staged.filter((_, i) =>
    ["retired", "already_retired"].includes(retired[i]!),
  );
  if (cold.length) {
    const after = await read(cold, true);
    for (const [i, l] of cold.entries())
      await confirm(l, cloud.at, after.api[i]!, after.sweeper[i]!);
  }
  return links.map((l, i) => bySeq.get(l.pin.sequence) ?? statuses[i]!);
}
