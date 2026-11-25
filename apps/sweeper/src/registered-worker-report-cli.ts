import {
  applyRegisteredPage,
  sourceKey,
  type ReaderProof,
} from "./registered-worker-report-page";
import {
  assertRegisteredPage,
  maxRegisteredPageMembers,
  maxRegisteredPageBytes,
} from "./registered-worker-report-read";
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
import {
  assertLegacyScope,
  type LegacyReportScope,
} from "@aerodb/db/legacy-report-storage";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { HistorySshEndpoint } from "./hz-point-history-relay";
import { atomicJson, lockDirectory } from "./hz-point-history-relay-service";
import {
  assertSourceKey,
  type SourceKey,
} from "./registered-worker-report-hub";
import {
  requireReportProof,
  type HubReportLink,
} from "./registered-worker-report-read";
import { registeredReaderBuild } from "./registered-worker-report-rpc";

const zero = { job: "00000000-0000-0000-0000-000000000000", seq: 0 };
const rpc = "/app/apps/sweeper/src/registered-worker-report-rpc.ts";
type Cursor = typeof zero;
type Pending = { key: SourceKey; link: HubReportLink; advance: boolean };
type Progress = {
  version: 1 | 2;
  group?: { links: HubReportLink[]; advance: boolean; checksum: string };
  binding: string;
  after: Cursor;
  cycle: number;
  pending: Pending | null;
};
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function readOptional<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
type Endpoint = Pick<HistorySshEndpoint, "ask" | "close">;
export type ReportConnector = (
  host: string,
  container: string,
  write?: boolean,
) => Endpoint;
export async function runRegisteredReportCli(
  args = process.argv.slice(2),
  connect: ReportConnector = (host, container, write) =>
    new HistorySshEndpoint(host, container, rpc, write),
) {
  const { values: v, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      directory: { type: "string" },
      scope: { type: "string" },
      "hub-account-file": { type: "string" },
      "hz-host": { type: "string" },
      "hub-host": { type: "string" },
      "hz-api": { type: "string" },
      "hz-sweeper": { type: "string" },
      "hub-sweeper": { type: "string" },
      job: { type: "string" },
      seq: { type: "string" },
      signature: { type: "string" },
      apply: { type: "boolean" },
      "max-pages": { type: "string" },
      "bundle-members": { type: "string", default: "1" },
      "keys-file": { type: "string" },
      timing: { type: "boolean" },
    },
  });
  const mode = positionals[0];
  requireReportProof(
    positionals.length === 1 &&
      ["one", "pass", "watch", "selected"].includes(mode!) &&
      v.directory &&
      isAbsolute(v.directory) &&
      v.scope &&
      v["hub-account-file"] &&
      v["hz-host"] &&
      v["hub-host"] &&
      v["hz-host"] !== v["hub-host"] &&
      v["hz-api"] &&
      v["hz-sweeper"] &&
      v["hz-api"] !== v["hz-sweeper"] &&
      v["hub-sweeper"],
    "Expected operator mode, private state, frozen scope and SSH endpoints",
  );
  const pageLimit = Number(v["max-pages"] ?? (mode === "watch" ? Infinity : 1));
  requireReportProof(
    (Number.isSafeInteger(pageLimit) && pageLimit >= 1) ||
      (!v["max-pages"] && mode === "watch"),
    "Invalid page limit",
  );
  requireReportProof(
    mode === "one" || v.apply,
    "Automatic coverage requires apply",
  );
  const requested =
    mode === "one"
      ? {
          executionId: v.job!,
          sequence: Number(v.seq),
          signature: v.signature!,
        }
      : null;
  if (requested) assertSourceKey(requested);
  else
    requireReportProof(
      !v.job && !v.seq && !v.signature,
      "Exact source filters require one",
    );
  const memberLimit = Number(v["bundle-members"]);
  requireReportProof(
    Number.isSafeInteger(memberLimit) &&
      memberLimit >= 1 &&
      memberLimit <= maxRegisteredPageMembers,
    "Invalid registered object page limit",
  );
  requireReportProof(
    (mode === "selected") === Boolean(v["keys-file"]),
    "Selected reports require a private key list",
  );
  let selected: SourceKey[] | undefined;
  if (v["keys-file"]) {
    const file = await import("node:fs/promises").then((fs) =>
      fs.open(v["keys-file"]!, "r"),
    );
    try {
      requireReportProof(
        (await file.stat()).isFile() && (await file.stat()).size <= 16384,
        "Oversize selected key list",
      );
      const data = Buffer.alloc(16385);
      const read = await file.read(data, 0, data.length, 0);
      requireReportProof(read.bytesRead <= 16384, "Oversize selected key list");
      selected = JSON.parse(data.subarray(0, read.bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
    requireReportProof(
      Array.isArray(selected) &&
        selected.length > 0 &&
        selected.length <= maxRegisteredPageMembers,
      "Invalid selected keys",
    );
    selected.forEach((k, i) => {
      assertSourceKey(k);
      requireReportProof(
        !i ||
          (k.executionId === selected![0]!.executionId &&
            k.sequence > selected![i - 1]!.sequence),
        "Selected keys must be in one ordered execution",
      );
    });
  }
  const dir = v.directory;
  const scope: LegacyReportScope = JSON.parse(await readFile(v.scope, "utf8"));
  assertLegacyScope(scope);
  const frozen = new Map(scope.executions.map((e) => [e.executionId, e]));
  const outside = (k: SourceKey) => {
    const f = frozen.get(k.executionId);
    return (
      !f || k.sequence <= (f.reportAfter ?? 0) || k.sequence > f.reportHighWater
    );
  };
  requireReportProof(
    !requested || outside(requested),
    "Selected source belongs to frozen operator",
  );
  const account = (await readFile(v["hub-account-file"], "utf8")).trim();
  const unlock = await lockDirectory(dir);
  const stop = new AbortController();
  const halt = () => stop.abort();
  process.once("SIGTERM", halt);
  process.once("SIGINT", halt);
  try {
    const build = await registeredReaderBuild();
    let pages = 0,
      failures = 0;
    const path = join(dir, "registered-report-progress.json");
    while (!stop.signal.aborted && pages < pageLimit) {
      const sessions: Endpoint[] = [];
      const open = (host: string, container: string) => {
        const session = connect(host, container);
        sessions.push(session);
        return session;
      };
      const ask = async (
        s: Endpoint,
        operation: string,
        payload: Record<string, unknown> = {},
      ) => {
        const began = performance.now();
        const r = await s.ask(
          {
            operation,
            build,
            ...payload,
            ...(v.timing ? { timing: true } : {}),
          },
          120000,
        );
        if (!v.timing) return r;
        requireReportProof(
          r?.timing &&
            [
              r.timing.ms,
              r.timing.cpuUs,
              r.timing.startupCpuUs,
              r.timing.peakRssKiB,
            ].every((n) => Number.isFinite(n) && n >= 0),
          "Missing registered operation timing",
        );
        console.log(
          JSON.stringify({
            event: "operation",
            operation,
            reader: payload.reader,
            committed: payload.committed,
            wallMs: performance.now() - began,
            ...r.timing,
          }),
        );
        return r.value;
      };
      const write = async (
        operation: string,
        payload: Record<string, unknown>,
      ) => {
        const endpoint = connect(v["hz-host"]!, v["hz-sweeper"]!, true);
        try {
          return await ask(endpoint, operation, payload);
        } finally {
          await endpoint.close();
        }
      };
      let idle = false,
        backoff = 0;
      try {
        const hub = open(v["hub-host"]!, v["hub-sweeper"]!),
          worker = open(v["hz-host"]!, v["hz-sweeper"]!),
          api = open(v["hz-host"]!, v["hz-api"]!);
        const [h, w, a] = await Promise.all([
          ask(hub, "hello"),
          ask(worker, "hello"),
          ask(api, "hello"),
        ]);
        requireReportProof(
          h.role === "hub" &&
            w.role === "remote-solver" &&
            isDeepStrictEqual(a, w) &&
            h.instance !== w.instance &&
            w.instance === scope.sourceInstance &&
            w.solver === scope.solverId &&
            [h, w, a].every((x) => x.build === build),
          "Deployed readers or scoped owners differ",
        );
        const binding = digest({
          schema: 1,
          scope: digest(scope),
          hub: h.instance,
          worker: w.instance,
          solver: w.solver,
          hubHost: v["hub-host"],
          hzHost: v["hz-host"],
          account: digest(account),
        });
        const state: Progress = (await readOptional<Progress>(path)) ?? {
          version: 1,
          binding,
          after: zero,
          cycle: 0,
          pending: null,
        };
        requireReportProof(
          state.binding === binding &&
            ((state.version === 1 && state.group === undefined) ||
              (state.version === 2 &&
                state.pending === null &&
                state.group &&
                typeof state.group.advance === "boolean")),
          "Operator checkpoint belongs to a different source",
        );
        const save = () => atomicJson(path, state);
        async function qualify(
          key: SourceKey,
          pending?: Pending,
        ): Promise<
          | { status: string; link?: undefined }
          | { status: "ready" | "already_retired"; link: HubReportLink }
        > {
          requireReportProof(outside(key), "Frozen worker report excluded");
          const src = await ask(worker, "key", { key });
          if (src.status !== "candidate") {
            requireReportProof(
              !pending || src.status === "other_storage",
              "Pending native source changed",
            );
            return { status: src.status };
          }
          const link: HubReportLink | null = await ask(hub, "describe", {
            owner: src.owner,
            key,
          });
          if (src.normalized && link?.pin.archiveFormat !== "shared-result-v1" &&
              (!pending || pending.link.pin.archiveFormat !== "shared-result-v1"))
            return { status: "other_storage" };
          if (pending)
            requireReportProof(
              link && isDeepStrictEqual(link, pending.link),
              "Pending hub member or scientific source changed",
            );
          if (!link) return { status: "no_receipted_hub_source" };
          const ready = await ask(worker, "state", { link });
          if (ready !== "ready" && ready !== "already_retired")
            return { status: ready };
          return { link, status: ready };
        }
        async function processKey(
          key: SourceKey,
          advance: boolean,
          pending?: Pending,
          qualified?: Awaited<ReturnType<typeof qualify>>,
        ) {
          const { link, status: ready } =
            qualified ?? (await qualify(key, pending));
          if (!link) return ready;
          if (v.apply) {
            state.pending = { key, link, advance };
            await save();
          }
          const restored = await ask(hub, "restore", {
            owner: link.owner,
            key,
            expected: link,
            account,
          });
          requireReportProof(
            restored && typeof restored.packed === "string",
            "Hub generation restore unavailable",
          );
          if (!v.apply) {
            await atomicJson(
              join(dir, `${key.executionId}.${key.sequence}.plan.json`),
              {
                build,
                binding,
                key,
                owner: link.owner,
                hubInstance: link.hubInstance,
                hubBundle: link.hubBundle,
                pin: link.pin,
                inventory: link.inventory,
                pointCount: link.anchors.length,
                cloudReadAt: restored.at,
                sourceState: ready,
              },
            );
            return "verified_cloud";
          }
          const staged = await write("stage", {
            link,
            bytes: restored.packed,
            ...(restored.dependencies ? { dependencies: restored.dependencies } : {}),
            cloudAt: restored.at,
          });
          if (staged !== "staged" && staged !== "already_retired")
            return staged;
          const apiRead = await ask(api, "read", {
            link,
            reader: "api",
            committed: false,
          });
          const status = await write("retire", {
            link,
            cloudAt: restored.at,
            api: apiRead,
          });
          if (status !== "retired" && status !== "already_retired")
            return status;
          const [apiProof, sweeperProof] = await Promise.all([
            ask(api, "read", { link, reader: "api", committed: true }),
            ask(worker, "read", { link, reader: "sweeper", committed: true }),
          ]);
          await confirm(link, restored.at, apiProof, sweeperProof);
          return status;
        }
        async function confirm(
          link: HubReportLink,
          cloudReadAt: string,
          apiProof: ReaderProof,
          sweeperProof: ReaderProof,
        ) {
          const key = sourceKey(link);
          if (link.pin.archiveFormat === "shared-result-v1")
            requireReportProof(apiProof.scientific && isDeepStrictEqual(apiProof.scientific, sweeperProof.scientific),
              "Committed scientific object pins differ");
          const proof = {
            binding,
            key,
            generation: link.pin.generation,
            hubBundle: link.hubBundle,
            originalSha256: link.pin.reportSha256,
            originalBytes: link.pin.reportByteSize,
            packedSha256: link.pin.storedSha256,
            packedBytes: link.pin.storedByteSize,
            ...(apiProof.scientific ? { scientific: apiProof.scientific } : {}),
            anchors: link.anchors.length,
          };
          for (const x of [apiProof, sweeperProof])
            requireReportProof(
              x.signature === key.signature &&
                x.generation === proof.generation &&
                x.sha256 === proof.originalSha256 &&
                x.byteSize === proof.originalBytes,
              "Committed consumer read differs",
            );
          const receipt = join(dir, `${key.executionId}.${key.sequence}.json`);
          const prior = await readOptional<{ proof: typeof proof }>(receipt);
          if (prior)
            requireReportProof(
              isDeepStrictEqual(prior.proof, proof),
              "Durable receipt collided",
            );
          else
            await atomicJson(
              receipt,
              {
                proof,
                build,
                cloudReadAt,
                api: apiProof,
                sweeper: sweeperProof,
              },
              true,
            );
        }
        const finish = async (
          k: SourceKey,
          advance: boolean,
          status: string,
        ) => {
          if (v.apply) {
            state.pending = null;
            if (advance) state.after = { job: k.executionId, seq: k.sequence };
            await save();
          }
          console.log(
            JSON.stringify({ status, job: k.executionId, seq: k.sequence }),
          );
        };
        async function group(links: HubReportLink[], advance: boolean) {
          assertRegisteredPage(links);
          requireReportProof(
            v.apply && links.every((l) => outside(sourceKey(l))),
            "Frozen source or read-only page",
          );
          state.version = 2;
          requireReportProof(
            links.every(
              (l) =>
                l.hubInstance === h.instance &&
                l.owner.workerInstance === w.instance &&
                l.owner.solverId === w.solver,
            ) &&
              (!advance ||
                links[0]!.pin.executionId > state.after.job ||
                (links[0]!.pin.executionId === state.after.job &&
                  links[0]!.pin.sequence > state.after.seq)),
            "Registered page differs from current checkpoint owner or order",
          );
          state.group = {
            links,
            advance,
            checksum: digest({ binding, after: state.after, links, advance }),
          };
          state.pending = null;
          await save();
          const statuses = await applyRegisteredPage(
            {
              hub: (op, data) => ask(hub, op, data),
              worker: (op, data) => ask(worker, op, data),
              api: (op, data) => ask(api, op, data),
              write,
            },
            links,
            account,
            confirm,
          );
          const outcomes = links.map((l, i) => ({
            job: l.pin.executionId,
            seq: l.pin.sequence,
            signature: l.pin.signature,
            status: statuses[i]!,
          }));
          // A lost confirmation or write reply leaves the same guarded page in the
          // only checkpoint. Ordinary v1 readers refuse an unfinished v2 page.
          const record = {
            binding,
            generation: links[0]!.pin.generation,
            hubBundle: links[0]!.hubBundle,
            outcomes,
          };
          await atomicJson(
            join(dir, digest(record) + ".page-outcome.json"),
            record,
            true,
          );
          const last = links.at(-1)!.pin;
          if (advance)
            state.after = { job: last.executionId, seq: last.sequence };
          delete state.group;
          state.version = 1;
          await save();
          for (const { job, seq, status } of outcomes)
            console.log(JSON.stringify({ job, seq, status }));
        }
        async function processKeys(keys: SourceKey[], advance: boolean) {
          let ready: HubReportLink[] = [];
          let bytes = 0;
          const flush = async () => {
            if (ready.length === 1) {
              const l = ready[0]!,
                k = sourceKey(l);
              await finish(
                k,
                advance,
                await processKey(k, advance, undefined, {
                  link: l,
                  status: "ready",
                }),
              );
            } else if (ready.length) await group(ready, advance);
            ready = [];
            bytes = 0;
          };
          for (const k of keys) {
            if (stop.signal.aborted) break;
            if (memberLimit === 1) {
              await finish(k, advance, await processKey(k, advance));
              continue;
            }
            const q = await qualify(k),
              l = q.link;
            if (!l) {
              await flush();
              await finish(k, advance, q.status);
              continue;
            }
            if (
              ready.length &&
              (ready[0]!.hubBundle !== l.hubBundle ||
                ready[0]!.owner.executionId !== l.owner.executionId ||
                bytes + l.pin.reportByteSize > maxRegisteredPageBytes)
            )
              await flush();
            ready.push(l);
            bytes += l.pin.reportByteSize;
            if (ready.length === memberLimit) await flush();
          }
          await flush();
        }
        const replayed = new Set<number>();
        if (state.group) {
          const g = state.group;
          requireReportProof(
            g.checksum ===
              digest({
                binding,
                after: state.after,
                links: g.links,
                advance: g.advance,
              }),
            "Pending registered page checksum differs",
          );
          requireReportProof(
            !requested &&
              (!selected ||
                g.links.every((l) =>
                  selected!.some((k) => isDeepStrictEqual(k, sourceKey(l))),
                )),
            "Resume exact registered page first",
          );
          await group(g.links, g.advance);
          if (selected) for (const l of g.links) replayed.add(l.pin.sequence);
        }
        if (state.pending) {
          requireReportProof(
            v.apply &&
              (!requested || isDeepStrictEqual(requested, state.pending.key)) &&
              (!selected ||
                selected.some((k) => isDeepStrictEqual(k, state.pending!.key))),
            "Resume pending exact key before another canary",
          );
          const p = state.pending;
          await finish(p.key, p.advance, await processKey(p.key, p.advance, p));
          if (requested) return;
        }
        if (selected) {
          await processKeys(
            selected.filter((k) => !replayed.has(k.sequence)),
            false,
          );
          return;
        }
        if (requested) {
          await finish(requested, false, await processKey(requested, false));
          return;
        }
        const page = await ask(hub, "scan", {
          workerInstance: w.instance,
          solverId: w.solver,
          after: state.after,
        });
        const keys: SourceKey[] = await ask(worker, "filter", {
          workerInstance: w.instance,
          solverId: w.solver,
          keys: page.keys.filter(outside),
        });
        await processKeys(keys, true);
        if (stop.signal.aborted) return;
        idle = !page.after;
        state.after = page.after ?? zero;
        if (idle) state.cycle++;
        await save();
        console.log(
          JSON.stringify({
            status: idle ? "coverage_pass_complete" : "page",
            cycle: state.cycle,
            after: state.after,
            selected: keys.length,
          }),
        );
        failures = 0;
        pages++;
        if (idle && mode !== "watch") return;
      } catch (error) {
        if (
          mode !== "watch" ||
          !(error instanceof HistoryOperationError) ||
          !error.retryable
        )
          throw error;
        failures++;
        backoff = Math.min(60000, 2000 * 2 ** Math.min(failures, 5));
        console.log(
          JSON.stringify({
            status: "retry",
            category: error.category,
            operation: error.operation,
            delayMs: backoff,
          }),
        );
      } finally {
        await Promise.all(sessions.map((s) => s.close()));
      }
      if (!stop.signal.aborted && pages < pageLimit)
        await delay(backoff || (idle ? 60000 : 1000), undefined, {
          signal: stop.signal,
        }).catch((e) => {
          if (!stop.signal.aborted) throw e;
        });
    }
  } finally {
    process.off("SIGTERM", halt);
    process.off("SIGINT", halt);
    await unlock();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runRegisteredReportCli().catch((error) => {
    console.error(
      JSON.stringify(
        error instanceof HistoryOperationError
          ? {
              operation: error.operation,
              category: error.category,
              retryable: error.retryable,
            }
          : {
              operation: "registered_report_operator",
              category: "source_or_checkpoint_mismatch",
            },
      ),
    );
    process.exitCode = 1;
  });
