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
  version: 1;
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
    },
  });
  const mode = positionals[0];
  requireReportProof(
    positionals.length === 1 &&
      ["one", "pass", "watch"].includes(mode!) &&
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
      const ask = (
        s: Endpoint,
        operation: string,
        payload: Record<string, unknown> = {},
      ) => s.ask({ operation, build, ...payload }, 120000);
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
          state.version === 1 && state.binding === binding,
          "Operator checkpoint belongs to a different source",
        );
        const save = () => atomicJson(path, state);
        async function processKey(
          key: SourceKey,
          advance: boolean,
          pending?: Pending,
        ) {
          requireReportProof(outside(key), "Frozen worker report excluded");
          const src = await ask(worker, "key", { key });
          if (src.status !== "candidate") {
            requireReportProof(
              !pending || src.status === "other_storage",
              "Pending native source changed",
            );
            return src.status;
          }
          const link: HubReportLink | null = await ask(hub, "describe", {
            owner: src.owner,
            key,
          });
          if (pending)
            requireReportProof(
              link && isDeepStrictEqual(link, pending.link),
              "Pending hub member or scientific source changed",
            );
          if (!link) return "no_receipted_hub_source";
          const ready = await ask(worker, "state", { link });
          if (ready !== "ready" && ready !== "already_retired") return ready;
          if (v.apply) {
            state.pending = { key, link, advance };
            await save();
          }
          const restored = await ask(hub, "restore", {
            owner: src.owner,
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
          const proof = {
            binding,
            key,
            generation: link.pin.generation,
            hubBundle: link.hubBundle,
            originalSha256: link.pin.reportSha256,
            originalBytes: link.pin.reportByteSize,
            packedSha256: link.pin.storedSha256,
            packedBytes: link.pin.storedByteSize,
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
                cloudReadAt: restored.at,
                api: apiProof,
                sweeper: sweeperProof,
              },
              true,
            );
          return status;
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
        if (state.pending) {
          requireReportProof(
            v.apply &&
              (!requested || isDeepStrictEqual(requested, state.pending.key)),
            "Resume pending exact key before another canary",
          );
          const p = state.pending;
          await finish(p.key, p.advance, await processKey(p.key, p.advance, p));
          if (requested) return;
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
        for (const k of keys) {
          if (stop.signal.aborted) return;
          await finish(k, true, await processKey(k, true));
        }
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
