import { AttemptReadSession, isAttemptRead, type AttemptReadRole } from "./hz-attempt-read-session";
import { checkLegacyHzFence } from "./hz-attempt-controller-fence";
import type { HzWorkerOwner } from "./hz-attempt-transfer-fence";
import { runOriginalCycle } from "./hz-attempt-original-cycle";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { HistoryOperationError, SETTLED_REPORT_SIZE_LIMIT } from "@aerodb/core/point-history-protocol";
import { HistorySshEndpoint } from "./hz-point-history-relay";
import { atomicJson, lockDirectory } from "./hz-point-history-relay-service";
import { ZERO_ID, exactId } from "./hz-attempt-custody";
import { migrateHzAttempt, type AttemptRelay } from "./hz-attempt-migration";

export async function hzAttemptStorage(
  args = process.argv.slice(2),
  io: {
    relay?: AttemptRelay;
    report?: (value: unknown) => void;
    signal?: AbortSignal;
    originalCycle?: typeof runOriginalCycle;
    checkLegacyFence?: typeof checkLegacyHzFence;
  } = {},
) {
  const report = io.report ?? ((value) => console.log(JSON.stringify(value)));
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "hz-attempt-storage-cli.ts plan [--id UUID | --until-complete] | status | migrate --apply (--id UUID | --directory DIR [--until-complete]) | watch --apply --directory DIR [--poll-seconds N] | restore --apply --id UUID. Writes require --bucket BUCKET --hub-account-file FILE. Worker scopes: --include-retained or --include-settled-receipts. A settled watch can pair --registered-roster FILE.jsonl.gz with --registered-roster-sha256 UNCOMPRESSED_SHA256. Select --canonical-fields with a single settled-receipt migration to verify its canonical result fields. Add --originals-directory DIR [--originals-scope FILE] to the same watch for archive-only discovery and copies.",
    );
    return;
  }
  const { values: v, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      apply: { type: "boolean" },
      "include-retained": { type: "boolean" },
      "include-settled-receipts": { type: "boolean" },
      "canonical-fields": { type: "boolean" },
      "registered-roster": { type: "string" },
      "registered-roster-sha256": { type: "string" },
      "originals-directory": { type: "string" },
      "originals-scope": { type: "string" },
      id: { type: "string" },
      directory: { type: "string" },
      limit: { type: "string", default: "8" },
      pages: { type: "string", default: "1" },
      "poll-seconds": { type: "string", default: "300" },
      "until-complete": { type: "boolean" },
      "hz-host": { type: "string", default: "hz-solver2" },
      "hub-host": { type: "string", default: "airfoils.pro" },
      "hz-sweeper": { type: "string", default: "hz-solver2-sweeper-1" },
      "hz-api": { type: "string", default: "hz-solver2-node-api-1" },
      "hub-sweeper": { type: "string", default: "app-sweeper-1" },
      bucket: { type: "string" },
      "hub-account-file": { type: "string" },
    },
  });
  const [mode] = positionals;
  const settled = v["include-settled-receipts"] === true;
  const retained = settled || v["include-retained"] === true;
  const watching = mode === "watch",
    write = ["migrate", "watch", "restore"].includes(mode!),
    continuous = watching || v["until-complete"];
  const poll = Number(v["poll-seconds"]);
  if (!Number.isInteger(poll) || poll < 5 || poll > 86400)
    throw Error("Invalid watch interval");
  if (
    positionals.length !== 1 ||
    !["plan", "status", "watch", "migrate", "restore"].includes(mode!) ||
    write !== Boolean(v.apply) ||
    (mode === "restore" && !v.id) ||
    (v.id && (continuous || mode === "status")) ||
    (v["canonical-fields"] && !(settled && mode==="migrate" && v.id)) ||
    (v["originals-directory"] && mode !== "watch") ||
    (Boolean(v["registered-roster"]) !== Boolean(v["registered-roster-sha256"])) ||
    (v["registered-roster"] && !(watching && write && settled && v.directory)) ||
    (v["originals-scope"] && !v["originals-directory"])
  )
    throw Error("Invalid command");
  const limit = Number(v.limit),
    pages = Number(v.pages),
    id = v.id ? exactId(v.id) : undefined;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 64 ||
    !Number.isSafeInteger(pages) ||
    pages < 1 ||
    (!id && write && !v.directory)
  )
    throw Error("Invalid bounds or checkpoint");
  const account = !write
    ? null
    : (await readFile(v["hub-account-file"]!, "utf8")).trim();
  if (write && (!v.bucket || !account)) throw Error("Missing hub pin");
  const sessions = new Map<AttemptReadRole, AttemptReadSession>();
  let owner: HzWorkerOwner | undefined;
  const endpoint = async (
    host: string,
    box: string,
    entry: string,
    request: Record<string, unknown>,
    role: AttemptReadRole,
    write = false,
  ) => {
    if (!write && isAttemptRead(role, request.operation)) {
      let session = sessions.get(role);
      if (!session) {
        session = new AttemptReadSession(role, () => new HistorySshEndpoint(host, box, entry));
        sessions.set(role, session);
      }
      return session.ask(request);
    }
    const ssh = new HistorySshEndpoint(host, box, entry, write);
    try {
      return await ssh.ask(request);
    } finally {
      await ssh.close();
    }
  };
  const helper = "/app/apps/sweeper/src/hz-attempt-custody-cli.ts";
  const transport: AttemptRelay = io.relay ?? {
    worker: (r, write) =>
      endpoint(v["hz-host"], v["hz-sweeper"], helper, r, "worker", write),
    api: (r) =>
      endpoint(
        v["hz-host"],
        v["hz-api"],
        "/app/apps/api/src/hz-attempt-custody-cli.ts",
        r,
        "api",
      ),
    hub: (r) =>
      endpoint(v["hub-host"], v["hub-sweeper"], helper, {
        ...r,
        bucket: v.bucket,
        account,
        ...(r.operation === "read" && owner ? { instance:owner.instance, solver:owner.solver } : {}),
      }, "hub"),
  };
  const control = new AbortController(),
    stop = () => control.abort();
  if (io.signal?.aborted) stop();
  io.signal?.addEventListener("abort", stop, { once: true });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  async function retry<T>(fn: () => Promise<T>) {
    let wait = 1000;
    for (;;) {
      control.signal.throwIfAborted();
      try {
        return await fn();
      } catch (e) {
        if (!(continuous && e instanceof HistoryOperationError && e.retryable))
          throw e;
        if (wait === 1000)
          report({
            waiting: true,
            operation: e.operation,
            category: e.category,
            retryable: true,
          });
        await delay(wait, undefined, { signal: control.signal });
        wait = Math.min(30000, wait * 2);
      }
    }
  }
  let nativeFence = false;
  const checkLegacy = () =>
    (io.checkLegacyFence ?? checkLegacyHzFence)(
      v["hz-host"],
      v["hz-sweeper"],
      owner!,
    );
  const relay: AttemptRelay = {
    ...transport,
    async worker(r, lock) {
      const requireTransfers = write && mode !== "restore" && !!owner;
      if (
        requireTransfers &&
        !nativeFence &&
        ["pending", "page", "prepare", "commit"].includes(String(r.operation))
      )
        await checkLegacy();
      try {
        const result = await transport.worker(
          {
            ...r,
            ...(retained ? { retained: true } : {}),
            ...(settled ? { settled: true } : {}),
            ...(requireTransfers ? { requireTransfers: true, owner } : {}),
          },
          lock,
        );
        if (r.operation === "bound")
          nativeFence = result.transfer_fence_protocol === 1;
        return result;
      } catch (error) {
        // Old workers hid the transfer flag in the replay owner predicate. A
        // positive current pause delays this exact member. A permission or
        // integrity failure with the fence open keeps its original meaning.
        if (
          requireTransfers &&
          !nativeFence &&
          r.operation === "replay" &&
          error instanceof HistoryOperationError &&
          error.operation === "attempt_replay" &&
          error.category === "integrity"
        )
          await checkLegacy();
        throw error;
      }
    },
  };
  const dir = v.directory && resolve(v.directory);
  const originals = v["originals-directory"]
    ? {
        directory: resolve(v["originals-directory"]),
        scope: v["originals-scope"] && resolve(v["originals-scope"]),
        hzHost: v["hz-host"],
        hzContainer: v["hz-sweeper"],
        hubHost: v["hub-host"],
        hubContainer: v["hub-sweeper"],
        bucket: v.bucket!,
        accountFile: resolve(v["hub-account-file"]!),
      }
    : null;
  const unlock = dir ? await lockDirectory(dir) : null;
  try {
    const bound = await retry(() => relay.worker({ operation: "bound" })),
      instance = exactId(bound.instance);
    owner = { instance, solver: exactId(bound.solver) };
    if (v["include-retained"] && bound.retained_contract !== true)
      throw new HistoryOperationError("retained_worker_contract", "input");
    if (settled && bound.settled_receipt_contract !== true)
      throw new HistoryOperationError("settled_worker_contract", "input");
    if (mode === "status") {
      report(await relay.worker({ operation: "status" }));
      return;
    }
    if (id) {
      if (v["canonical-fields"]) {
        if (bound.canonical_subtrees!==true) throw Error("Canonical subtree storage is disabled");
        const {settleWorkerCanonicalFields}=await import("./canonical-result-history");
        report({canonicalFields:await retry(()=>settleWorkerCanonicalFields(relay,id))});
        return;
      }
      if (mode === "plan") {
        const row = await relay.worker({ operation: "one", attemptId: id });
        report(row);
        return;
      }
      const result = await retry(() =>
        migrateHzAttempt(relay, id, instance, mode === "restore"),
      );
      report(result);
      return;
    }
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          mode,
          instance,
          bound.solver,
          v["hz-host"],
          v["hz-api"],
          v["hz-sweeper"],
          v["hub-host"],
          v["hub-sweeper"],
          v.bucket,
          account,
        ]),
      )
      .digest("hex");
    const file =
      dir &&
      join(
        dir,
        "attempt-" +
          mode +
          (settled ? "-settled-receipts" : retained ? "-retained" : "") +
          ".json",
      );
    let state = {
      version: 1,
      binding,
      high: bound.high || ZERO_ID,
      after: ZERO_ID,
      complete: false,
      scanned: 0,
      eligible: 0,
      verified: 0,
      limited: 0,
      deferredReadbacks: 0,
      reportSizeHeld: 0,
      sourceStoredBytes: 0,
      excluded: 0,
      alreadyArchived: 0,
      logicalBytes: 0,
      netBytes: 0,
    };
    if (file) {
      try {
        const saved = JSON.parse(await readFile(file, "utf8"));
        if (
          saved.version !== 1 ||
          saved.binding !== binding ||
          saved.after > saved.high
        )
          throw Error("Invalid checkpoint");
        exactId(saved.after);
        exactId(saved.high);
        state = saved;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await atomicJson(file, state);
    }
    if (v["registered-roster"] && bound.registered_roster_protocol !== 1)
      throw new HistoryOperationError("registered_roster_contract","input");
    const roster = v["registered-roster"] ? await (await import("./hz-attempt-registered-roster")).openRegisteredAttemptRoster(
      v["registered-roster"],v["registered-roster-sha256"]!,dir!,binding,
    ) : undefined;
    async function visitRegisteredPage() {
      if (!roster || roster.complete) return;
      const result = await retry(() => roster.advance(
        pins => relay.worker({operation:"registered-state",pins}),
        async pin => {
          const value=await migrateHzAttempt(relay,pin.attempt,instance,false,pin);
          return {limited:value.limited};
        },control.signal,
      ));
      if (result) report({registeredRoster:result});
    }
    // An already committed event survives disconnects. Job-row contention
    // during its post-read must not monopolize the sole worker. Explicit
    // migrations, transfer fences and source-integrity failures retain their
    // normal retry/restore semantics.
    let nextPendingCheck = 0;
    let afterEvent = ZERO_ID;
    let previousPending: string | null = null;
    async function transfer(id: string, observed?: { id: string; event?: string }) {
      return retry(async () => {
        try {
          return await migrateHzAttempt(relay, id, instance);
        } catch (error) {
          if (!watching || !(error instanceof HistoryOperationError) || error.category !== "database_busy" || !error.retryable) throw error;
          const durable = observed ??
            (await relay.worker({ operation: "pending", attemptId: id })).find((r: { id: string }) => r.id === id);
          if (!durable) throw error;
          report({ pendingReadback: id, event: durable.event, operation: error.operation });
          nextPendingCheck = Date.now() + 60_000;
          return { pendingReadback: true as const };
        }
      });
    }
    async function revisitPending() {
      if (!watching || Date.now() < nextPendingCheck) return;
      const cursorSupported = bound.pending_cursor_protocol === 1;
      const rows = await retry(() => relay.worker({
        operation: "pending", ...(cursorSupported ? { afterEvent } : {}),
      }));
      nextPendingCheck = Date.now() + 60_000;
      if (!rows.length) {
        afterEvent = ZERO_ID;
        previousPending = null;
        return;
      }
      const pos = cursorSupported ? 0 : (rows.findIndex((r: { id: string }) => r.id === previousPending) + 1) % rows.length;
      const row = rows[pos];
      previousPending = exactId(row.id);
      if (cursorSupported) afterEvent = exactId(row.event);
      const recovered = await transfer(previousPending, {id:previousPending,event:row.event});
      if (!("pendingReadback" in recovered)) nextPendingCheck = 0;
    }
    for (;;) {
      if (write && !watching) {
        // Audit pending commits even if a previous scan reached its high water.
        for (;;) {
          const pending = await retry(() =>
            relay.worker({ operation: "pending" }),
          );
          if (!pending.length) break;
          for (const row of pending)
            await retry(() =>
              migrateHzAttempt(relay, exactId(row.id), instance),
            );
        }
      }
      if (watching) await revisitPending();
      if (state.complete) await visitRegisteredPage();
      for (
        let pass = 0;
        !state.complete && (continuous || pass < pages);
        pass++
      ) {
        await visitRegisteredPage();
        if (originals)
          await (io.originalCycle ?? runOriginalCycle)(
            originals,
            15,
            control.signal,
          );
        const rows = await retry(() =>
          relay.worker({
            operation: "page",
            canonicalFields: settled && bound.canonical_subtrees===true,
            high: state.high,
            after: state.after,
            limit,
          }),
        );
        for (const row of rows) {
          control.signal.throwIfAborted();
          const key = exactId(row.id);
          if (key <= state.after || key > state.high)
            throw Error("Invalid keyset progress");
          if (watching) await revisitPending();
          if (write && row.canonical_fields) {
            const { settleWorkerCanonicalFields } = await import("./canonical-result-history");
            await retry(async () => {
              try {
                const fields = await settleWorkerCanonicalFields(relay, key);
                if (fields.length) report({ canonicalFields: fields });
              } catch (error) {
                if (!watching || !(error instanceof HistoryOperationError) ||
                    !["database_busy", "integrity"].includes(error.category)) throw error;
                // A held field stays inline or pending for the next fair scan.
                report({ canonicalFieldDeferred: key, operation: error.operation, category: error.category });
              }
            });
          }
          // Older peers return only their first eight pending entries. Their
          // ordinary forward page still identifies any later unconfirmed row.
          if (watching && bound.pending_cursor_protocol !== 1 && row.archive && row.pending && key !== previousPending)
            await transfer(key, {id:key});
          if (!row.archive && row.limiter === null) {
            if (write) {
              const r = await transfer(key);
              if ("pendingReadback" in r) {
                state.deferredReadbacks = (state.deferredReadbacks ?? 0) + 1;
              } else if (r.limited) {
                state.limited++;
                if (r.limited === SETTLED_REPORT_SIZE_LIMIT) state.reportSizeHeld = (state.reportSizeHeld ?? 0) + 1;
              }
              else {
                state.verified++;
                state.netBytes += r.netValueBytesReclaimed ?? 0;
              }
            }
            state.eligible++;
            state.sourceStoredBytes += Number(row.stored);
            state.logicalBytes += Number(row.logical);
          }
          if (row.archive) state.alreadyArchived++;
          else if (row.limiter !== null) {
            state.excluded++;
            if (row.limiter === SETTLED_REPORT_SIZE_LIMIT) state.reportSizeHeld = (state.reportSizeHeld ?? 0) + 1;
          }
          state.scanned++;
          state.after = key;
          if (file) await atomicJson(file, state);
        }
        state.complete = rows.length < limit || state.after === state.high;
        if (file) await atomicJson(file, state);
        report({ ...state });
        if (!state.complete && continuous)
          await delay(50, undefined, { signal: control.signal });
      }
      if (state.complete)
        report({
          complete: true,
          checkpoint: { ...state },
          ...(write
            ? {
                activeCustody: await retry(() =>
                  relay.worker({ operation: "status" }),
                ),
              }
            : {}),
        });
      if (!watching) break;
      const nextScan = Date.now() + (roster && !roster.complete ? 250 : previousPending ? Math.min(60_000, poll * 1000) : poll * 1000);
      if (originals)
        await (io.originalCycle ?? runOriginalCycle)(
          originals,
          poll,
          control.signal,
        );
      await delay(Math.max(0, nextScan - Date.now()), undefined, {
        signal: control.signal,
      });
      const next = await retry(() => relay.worker({ operation: "bound" }));
      if (next.instance !== instance || next.solver !== bound.solver)
        throw Error("Worker identity changed");
      state = {
        ...state,
        high: next.high || ZERO_ID,
        after: ZERO_ID,
        complete: false,
        scanned: 0,
        eligible: 0,
        verified: 0,
        limited: 0,
        deferredReadbacks: 0,
        reportSizeHeld: 0,
        sourceStoredBytes: 0,
        excluded: 0,
        alreadyArchived: 0,
        logicalBytes: 0,
        netBytes: 0,
      };
      if (file) await atomicJson(file, state);
    }
  } catch (error) {
    if (!control.signal.aborted) throw error;
  } finally {
    io.signal?.removeEventListener("abort", stop);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    try { await Promise.all([...sessions.values()].map(session => session.close())); } finally { await unlock?.(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  hzAttemptStorage().catch((e) => {
    console.error(
      JSON.stringify(
        e instanceof HistoryOperationError
          ? {
              operation: e.operation,
              category: e.category,
              retryable: e.retryable,
            }
          : {
              operation: "hz_attempt_operator",
              category: "input_or_integrity",
            },
      ),
    );
    process.exitCode = 1;
  });
