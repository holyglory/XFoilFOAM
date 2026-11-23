import { checkLegacyHzFence } from "./hz-attempt-controller-fence";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import {
  HistoryMessages,
  HistoryOperationError,
} from "@aerodb/core/point-history-protocol";
import { HistorySshEndpoint } from "./hz-point-history-relay";
import {
  type OriginalPin,
  type OriginalRow,
  type PriorityMatch,
  type SourceBinding,
  type VerifiedOriginal,
  type PreparedOriginal,
  checkOriginalPage,
  checkOriginalBudget,
  checkPin,
  samePin,
} from "./hz-attempt-originals";

export interface OriginalEndpoints {
  worker(r: Record<string, unknown>, write?: boolean): Promise<any>;
  hub(r: Record<string, unknown>): Promise<any>;
}
export async function inventoryOriginalPage(
  relay: OriginalEndpoints,
  b: SourceBinding,
  selection: { ids: string[] } | { after: string; high: string; limit: number },
) {
  const rows: OriginalRow[] = await relay.worker({
    operation: "inventory",
    binding: b,
    selection,
  });
  const candidates = rows.filter((x) => x.ack && x.sha && x.history > 0);
  const mapped: PriorityMatch[] = candidates.length
    ? await relay.hub({ operation: "mapping", binding: b, rows: candidates })
    : [];
  const byId = new Map(mapped.map((x) => [x.id, x]));
  return rows.map((row) => ({ ...row, match: byId.get(row.id) ?? null }));
}
export async function uploadOriginalPage(
  relay: OriginalEndpoints,
  b: SourceBinding,
  pins: OriginalPin[],
  budget: number,
) {
  checkOriginalPage(pins.length);
  checkOriginalBudget(budget);
  pins.forEach(checkPin);
  const { items, deferred } = (await relay.worker({
    operation: "prepare",
    binding: b,
    pins,
    budget,
  })) as { items: PreparedOriginal[]; deferred: string[] };
  const requested = new Map(pins.map((p) => [p.id, p]));
  if (
    new Set([...deferred, ...items.map((x) => x.pin.id)]).size !==
      pins.length ||
    deferred.length + items.length !== pins.length ||
    deferred.some((x) => !requested.has(x)) ||
    items.some(
      (x) =>
        !requested.has(x.pin.id) || !samePin(requested.get(x.pin.id)!, x.pin),
    )
  )
    throw Error("Incomplete prepared original page");
  if (!items.length) return { uploads: [], deferred };
  const verified: VerifiedOriginal[] = await relay.hub({
    operation: "objects",
    binding: b,
    budget,
    items,
  });
  if (
    verified.length !== items.length ||
    verified.some(
      (v, k) =>
        !samePin(v.pin, items[k]!.pin) ||
        v.identity.sourceInstance !== b.instance ||
        v.identity.attemptId !== v.pin.id ||
        v.identity.resultId !== v.pin.result ||
        v.identity.simJobId !== v.pin.job ||
        v.identity.sourceSha256 !== v.pin.sha ||
        v.identity.sourceByteSize !== v.pin.bytes,
    )
  )
    throw Error("Hub returned a different HZ owner");
  return {
    uploads: verified.map(({ pin, identity }) => ({ pin, identity })),
    deferred,
  };
}
export async function registerOriginalPage(
  relay: OriginalEndpoints,
  b: SourceBinding,
  uploads: Pick<VerifiedOriginal, "pin" | "identity">[],
  budget: number,
) {
  checkOriginalPage(uploads.length);
  checkOriginalBudget(budget);
  uploads.forEach((x) => checkPin(x.pin));
  if (uploads.reduce((n, x) => n + x.pin.bytes, 0) > budget)
    throw Error("Original registration page exceeds budget");
  const verified: VerifiedOriginal[] = await relay.hub({
    operation: "objects",
    binding: b,
    budget,
    items: uploads,
  });
  if (
    verified.length !== uploads.length ||
    verified.some(
      (x, k) =>
        !samePin(x.pin, uploads[k]!.pin) ||
        x.identity.generation !== uploads[k]!.identity.generation ||
        x.identity.objectKey !== uploads[k]!.identity.objectKey ||
        x.identity.sourceInstance !== b.instance ||
        x.identity.storedSha256 !== uploads[k]!.identity.storedSha256,
    )
  )
    throw Error("Pinned original changed");
  const receipts = (await relay.worker(
    { operation: "register", binding: b, budget, items: verified },
    true,
  )) as Array<{
    id: string;
    archive: string;
    generation: string;
    sha: string;
    sourceBytes: number;
    historyBytes: number;
    packedBytes: number;
    created: boolean;
  }>;
  if (
    receipts.length !== verified.length ||
    receipts.some(
      (r, k) =>
        r.id !== verified[k]!.pin.id ||
        r.generation !== verified[k]!.identity.generation ||
        r.sha !== verified[k]!.pin.sha ||
        r.sourceBytes !== verified[k]!.pin.bytes ||
        r.historyBytes !== verified[k]!.pin.history ||
        r.packedBytes !== verified[k]!.identity.storedByteSize,
    )
  )
    throw Error("Incomplete HZ registration");
  return receipts;
}
/** The private controller receives metadata only. Packed bodies stay in a
 * bounded relay page and travel over the two independent SSH aliases. */
async function main() {
  const local = new HistoryMessages(process.stdin, process.stdout);
  const cfg = await local.read(),
    entry = "/app/apps/sweeper/src/hz-attempt-original-rpc.ts";
  const endpoint = (hub: boolean, write = false) =>
    new HistorySshEndpoint(
      hub ? cfg.hubHost : cfg.hzHost,
      hub ? cfg.hubContainer : cfg.hzContainer,
      entry,
      write,
    );
  let worker: HistorySshEndpoint | undefined,
    hub: HistorySshEndpoint | undefined;
  const reset = async () => {
    await Promise.allSettled([worker?.close(), hub?.close()]);
    worker = undefined;
    hub = undefined;
  };
  const account = cfg.accountFile
    ? (await readFile(cfg.accountFile, "utf8")).trim()
    : null;
  const relay: OriginalEndpoints = {
    async worker(r, write = false) {
      if (!write) {
        worker ??= endpoint(false);
        return worker.ask(r, 180000);
      }
      const locked = endpoint(false, true);
      try {
        return await locked.ask(r, 180000);
      } finally {
        await locked.close();
      }
    },
    async hub(r) {
      hub ??= endpoint(true);
      return hub.ask(
        r.operation === "objects" ? { ...r, account, bucket: cfg.bucket } : r,
        180000,
      );
    },
  };
  let binding: SourceBinding | undefined;
  try {
    for (;;) {
      let req;
      try {
        req = await local.read(240000);
      } catch (e) {
        if (local.ended) return;
        throw e;
      }
      try {
        let result;
        if (
          (req.operation === "upload" || req.operation === "register") &&
          cfg.apply &&
          req.binding
        ) {
          binding ??= await relay.worker({ operation: "bound" });
          if (
            !binding ||
            binding.instance !== req.binding.instance ||
            binding.solver !== req.binding.solver
          )
            throw new HistoryOperationError("worker_registration", "denied");
          if (binding.transfer_fence_protocol !== 1)
            await checkLegacyHzFence(cfg.hzHost, cfg.hzContainer, binding);
        }
        if (req.operation === "bound")
          result = binding = await relay.worker({ operation: "bound" });
        else if (req.operation === "inventory")
          result = await inventoryOriginalPage(
            relay,
            req.binding,
            req.selection,
          );
        else if (
          req.operation === "upload" &&
          cfg.apply === true &&
          cfg.bucket &&
          account
        )
          result = await uploadOriginalPage(
            relay,
            req.binding,
            req.pins,
            req.budget,
          );
        else if (
          req.operation === "register" &&
          cfg.apply === true &&
          cfg.bucket &&
          account
        )
          result = await registerOriginalPage(
            relay,
            req.binding,
            req.uploads,
            req.budget,
          );
        else throw Error("Invalid original relay operation");
        await local.send({ id: req.id, result });
      } catch (e) {
        await reset();
        await local.send({
          id: req.id,
          error: {
            operation:
              e instanceof HistoryOperationError
                ? e.operation
                : "original_page",
            category:
              e instanceof HistoryOperationError ? e.category : "integrity",
            retryable: e instanceof HistoryOperationError && e.retryable,
          },
        });
      }
    }
  } finally {
    await reset();
    local.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error("Original relay unavailable");
    process.exitCode = 1;
  });
