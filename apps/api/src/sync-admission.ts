import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import type { DB } from "@aerodb/db/client";

export const SYNC_DATA_CONNECTIONS = 4;
export const SYNC_CONTROL_CONNECTIONS = 2;
type Traffic = "control" | "report" | "polar" | "transfer";
export const SYNC_REPORT_LIMIT = 2;
const heavyLimit = 3;
const controlLimit = 8;

interface Ticket {
  kind: Traffic;
  abort: AbortController;
  started: number;
  running: boolean;
  done: boolean;
  clientGone: boolean;
  rootInsideTransaction: number;
  transactions: number;
  txAcquireMs: number;
  txHeldMs: number;
  settingsMs: number;
  registrationMs: number;
}
const context = new AsyncLocalStorage<{
  ticket: Ticket;
  inTransaction: boolean;
}>();

/** Check at an explicit pre-effect boundary. Once an admitted transaction has
 * started writing, it retains its slot and finishes normally even if a peer left. */
export function syncRequestSignal(): AbortSignal | undefined {
  return context.getStore()?.ticket.abort.signal;
}
export function assertSyncClientActive(): void {
  syncRequestSignal()?.throwIfAborted();
}
/** Includes pool wait and SQL execution. These spans may overlap transaction time. */
export async function syncLookupTime<T>(
  field: "settingsMs" | "registrationMs",
  query: () => PromiseLike<T>,
): Promise<T> {
  const ticket = context.getStore()?.ticket;
  if (!ticket) return query();
  const started = performance.now();
  try {
    return await query();
  } finally {
    ticket[field] += performance.now() - started;
  }
}
function closedClient() {
  return Object.assign(new Error("Sync client disconnected"), {
    statusCode: 499,
  });
}

function traffic(
  method: string | string[],
  route: string,
): Traffic | undefined {
  if (!route.startsWith("/api/sync/v1/") || method === "OPTIONS") return;
  const path = route.slice("/api/sync/v1/".length);
  if (path === "progressive-executions/:executionId/reports") return "report";
  if (path === "polars") return "polar";
  if (
    path === "status" ||
    /^progressive-executions\/:executionId\/(?:control|start)$/.test(path) ||
    /^solvers\/:id\/(?:heartbeat|progress)$/.test(path) ||
    /^sweeps\/:promiseId\/(?:heartbeat|cancel)$/.test(path)
  )
    return "control";
  return "transfer";
}

/** Bind auth, admission checks and helper queries to the same chosen lane.
 * Explicit transaction handles remain the exact handles supplied by Drizzle.
 * Count an ambient root query inside a transaction separately from SQL locks. */
export function syncRequestDatabase(data: DB, control: DB): DB {
  return new Proxy(data, {
    get(_target, property) {
      const scope = context.getStore();
      const db = scope?.ticket.kind === "control" ? control : data;
      const method = Reflect.get(db, property, db);
      if (typeof method !== "function") return method;
      if (!scope) return method.bind(db);
      if (
        scope.inTransaction &&
        [
          "execute",
          "select",
          "insert",
          "update",
          "delete",
          "transaction",
        ].includes(String(property))
      )
        scope.ticket.rootInsideTransaction++;
      if (property !== "transaction") return method.bind(db);
      return (
        callback: Parameters<DB["transaction"]>[0],
        options?: Parameters<DB["transaction"]>[1],
      ) => {
        const queued = performance.now();
        return db.transaction(async (tx) => {
          const acquired = performance.now();
          scope.ticket.transactions++;
          scope.ticket.txAcquireMs += acquired - queued;
          try {
            return await context.run(
              { ticket: scope.ticket, inTransaction: true },
              () => callback(tx),
            );
          } finally {
            scope.ticket.txHeldMs += performance.now() - acquired;
          }
        }, options);
      };
    },
  });
}

interface Counts {
  admitted: number;
  busy: number;
  disconnected: number;
  settledAfterDisconnect: number;
  abandonedBeforeHandler: number;
  abandonedInHandler: number;
  maxActive: number;
  tx: number;
  txAcquireMs: number;
  txHeldMs: number;
  settingsMs: number;
  registrationMs: number;
  rootInsideTransaction: number;
  bodyMs: number;
  handlerMs: number;
}
function counts(): Counts {
  return {
    admitted: 0,
    busy: 0,
    disconnected: 0,
    settledAfterDisconnect: 0,
    abandonedBeforeHandler: 0,
    abandonedInHandler: 0,
    maxActive: 0,
    tx: 0,
    txAcquireMs: 0,
    txHeldMs: 0,
    settingsMs: 0,
    registrationMs: 0,
    rootInsideTransaction: 0,
    bodyMs: 0,
    handlerMs: 0,
  };
}
function counters(): Record<Traffic, Counts> {
  return {
    control: counts(),
    report: counts(),
    polar: counts(),
    transfer: counts(),
  };
}

/** Reject overload before body parsing, authentication queries or archive
 * verification. Admission does not authorize any operation or return a receipt. */
export function installSyncAdmission(app: FastifyInstance): void {
  const active: Record<Traffic, number> = {
    control: 0,
    report: 0,
    polar: 0,
    transfer: 0,
  };
  const reports = new Set<string>();
  const tickets = new WeakMap<FastifyRequest, Ticket>();
  let observed = counters();
  const outstanding = new Set<Ticket>();
  let cpu = process.cpuUsage(),
    eventLoop = performance.eventLoopUtilization(),
    windowStart = performance.now();
  const flush = () => {
    const usage = process.cpuUsage(cpu),
      utilization = performance.eventLoopUtilization(eventLoop),
      now = performance.now();
    const windowMs = Math.round(now - windowStart);
    cpu = process.cpuUsage();
    eventLoop = performance.eventLoopUtilization();
    windowStart = now;
    if (
      !outstanding.size &&
      !Object.values(observed).some(
        (c) => c.admitted || c.busy || c.disconnected || c.handlerMs || c.tx,
      )
    )
      return;
    const oldestMs = Math.round(
      Math.max(0, ...Array.from(outstanding, (t) => now - t.started)),
    );
    app.log.info(
      {
        event: "syncAdmission",
        windowMs,
        active: { ...active },
        oldestMs,
        classes: observed,
        processCpuMs: Math.round((usage.user + usage.system) / 1000),
        listenerActiveMs: Math.round(utilization.active),
        listenerIdleMs: Math.round(utilization.idle),
      },
      "Sync request capacity",
    );
    observed = counters();
  };
  const interval = setInterval(flush, 30_000);
  interval.unref();
  app.addHook("onClose", async () => {
    clearInterval(interval);
    flush();
  });
  app.addHook("onRoute", (options) => {
    const kind = traffic(options.method, options.url);
    if (!kind) return;
    const acquire: onRequestHookHandler = (req, reply, done) => {
      const key =
        kind === "report"
          ? String(
              (req.params as { executionId: string }).executionId,
            ).toLowerCase()
          : undefined;
      const nonReport = active.polar + active.transfer;
      const busy =
        kind === "control"
          ? active.control >= controlLimit
          : active.report + nonReport >= heavyLimit ||
            (kind === "report"
              ? active.report >= SYNC_REPORT_LIMIT || reports.has(key!)
              : nonReport >= 2);
      if (busy) {
        observed[kind].busy++;
        const seconds = 2 + Math.floor(Math.random() * 3);
        reply
          .header("Retry-After", String(seconds))
          .header("Cache-Control", "no-store")
          .code(503)
          .send({
            code: "sync_capacity_busy",
            error: "Sync capacity is busy",
            retryAfterMs: seconds * 1000,
          });
        return;
      }
      const ticket: Ticket = {
        kind,
        abort: new AbortController(),
        started: performance.now(),
        running: false,
        done: false,
        clientGone: false,
        transactions: 0,
        txAcquireMs: 0,
        txHeldMs: 0,
        settingsMs: 0,
        registrationMs: 0,
        rootInsideTransaction: 0,
      };
      active[kind]++;
      outstanding.add(ticket);
      observed[kind].maxActive = Math.max(
        observed[kind].maxActive,
        active[kind],
      );
      observed[kind].admitted++;
      if (key) reports.add(key);
      tickets.set(req, ticket);
      const release = () => {
        if (ticket.done || ticket.running) return;
        ticket.done = true;
        outstanding.delete(ticket);
        active[kind]--;
        if (key) reports.delete(key);
        tickets.delete(req);
        req.raw.off("aborted", abort);
        reply.raw.off("close", close);
        reply.raw.off("finish", finish);
        const c = observed[kind];
        c.tx += ticket.transactions;
        c.txAcquireMs += Math.round(ticket.txAcquireMs);
        c.txHeldMs += Math.round(ticket.txHeldMs);
        c.rootInsideTransaction += ticket.rootInsideTransaction;
        c.settingsMs += Math.round(ticket.settingsMs);
        c.registrationMs += Math.round(ticket.registrationMs);
        if (ticket.clientGone) c.settledAfterDisconnect++;
      };
      const abort = () => {
        if (!ticket.clientGone) {
          ticket.clientGone = true;
          observed[kind].disconnected++;
          if (ticket.running) observed[kind].abandonedInHandler++;
          else observed[kind].abandonedBeforeHandler++;
          ticket.abort.abort(closedClient());
        }
        release();
      };
      const close = () => {
        if (reply.raw.writableFinished) release();
        else abort();
      };
      const finish = () => release();
      req.raw.once("aborted", abort);
      reply.raw.once("close", close);
      reply.raw.once("finish", finish);
      // The same closure is used after handler completion if the socket closed
      // while a transaction was running. Never release a live handler's permit.
      finishes.set(ticket, release);
      if (req.raw.aborted || reply.raw.destroyed) {
        abort();
        done(closedClient());
        return;
      }
      context.run({ ticket, inTransaction: false }, done);
    };
    const existing = options.onRequest;
    options.onRequest = [
      acquire,
      ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
    ];
    const handle = options.handler;
    options.handler = async function (req, reply) {
      const ticket = tickets.get(req);
      if (!ticket || ticket.abort.signal.aborted) throw closedClient();
      const started = performance.now();
      observed[kind].bodyMs += Math.round(started - ticket.started);
      ticket.running = true;
      try {
        return await context.run({ ticket, inTransaction: false }, () =>
          handle.call(this, req, reply),
        );
      } finally {
        ticket.running = false;
        observed[kind].handlerMs += Math.round(performance.now() - started);
        if (
          ticket.clientGone ||
          reply.raw.writableFinished ||
          reply.raw.destroyed
        )
          finishes.get(ticket)?.();
      }
    };
  });
}
const finishes = new WeakMap<Ticket, () => void>();
