import { registeredWorkerArchiveOwner, type DB } from "@aerodb/db";
import { readRegisteredArchive, registeredArchiveAdmissionDelay } from "@aerodb/core/registered-archive-read";

export class ArchiveAdmissionBusy extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Registered archive admission remains busy (HTTP 503)");
  }
}

// The historical catalogue lives on the registered hub. Both point-level and
// job-level removal must defer to it until the original native reader changes ownership.
export async function assertOrdinaryRegisteredCustody(db: DB, id: string, signal: AbortSignal) {
  const {baseUrl,authToken,envelope} = await registeredWorkerArchiveOwner(db,id);
  const res = await readRegisteredArchive(`${baseUrl}/progressive-executions/${id}/historical-raw-archives/retention-owner`,
    authToken,signal,"application/json");
  const busy = await registeredArchiveAdmissionDelay(res);
  if (busy !== null) {
    await res.body?.cancel();
    throw new ArchiveAdmissionBusy(busy);
  }
  if (res.status !== 200 || !res.body || res.headers.get("content-type")?.split(";")[0] !== "application/json") {
    await res.body?.cancel();
    throw Error(`Registered retention owner unavailable (HTTP ${res.status})`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += part.length;
    if (size > 1024) throw Error("Registered retention owner exceeded its byte bound");
    chunks.push(Buffer.from(part));
  }
  const owner = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (owner?.version !== 1 || owner.executionId !== id || owner.solverId !== envelope.solverId ||
      owner.promiseId !== envelope.promiseId || owner.assignmentSignature !== envelope.contentSignature ||
      typeof owner.historicalRaw !== "boolean") throw Error("Registered retention owner changed or was ambiguous");
  if (owner.historicalRaw) throw Error("Historical raw gateway owns this execution");
  return envelope.contentSignature;
}

