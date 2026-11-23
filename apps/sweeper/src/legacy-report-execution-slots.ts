import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type { LegacyReportScope } from "@aerodb/db/legacy-report-storage";
import {
  sameLegacyCursor as same,
  type LegacyBackupPage,
  type LegacyBackupReceipt,
  type LegacyCursor,
} from "@aerodb/db/legacy-report-storage-codec";
import { durableWrite, syncDirectory } from "./legacy-report-storage-files";
import {
  legacySha256,
  type LegacyBackupStore,
} from "./legacy-report-storage-gcs";

import {
  capacitySamplingFailed,
  type PeerBudget,
  type PeerCapacityReason,
  type PeerMemory,
} from "./legacy-report-peer-memory";

export interface LegacySlotOptions<T> {
  slots: 1 | 2;
  targetBinding: string;
  peerSource?: T;
  pairOrder?: "serial" | "concurrent";
  applicationMarker?: (name: string) => string;
  openBudget?: () => Promise<PeerBudget>;
}

type Packed = Omit<LegacyBackupPage, "members"> & {
  bytes: Buffer;
  rawByteSize: number;
  memberCount: number;
  reportRows: number;
};
type Artifact = { name: string; sha: string };
interface Ready {
  receipt: string;
  files: Artifact[];
}
interface Session {
  binding: string;
  target: string;
  first: number;
  peerExecution: number;
  peer: LegacyCursor;
  cap: number;
}
interface Inputs<T> {
  options: LegacySlotOptions<T>;
  scope: LegacyReportScope;
  binding: string;
  scopeHash: string;
  directory: string;
  pendingPath: string;
  pages: number;
  maxBytes: number;
  exists: boolean;
  store: LegacyBackupStore;
  shouldStop?: () => boolean;
  cursor(): { next: LegacyCursor; lastReceipt: string | null };
  prepare(start: LegacyCursor, peer: boolean, cap: number): Promise<Packed>;
  inspect(bytes: Buffer): Packed;
  apply(
    page: Packed,
    directory: string,
    pinned: LegacyBackupReceipt | undefined,
    check: (verified: LegacyBackupPage) => void,
  ): Promise<string>;
  publish(next: LegacyCursor, receipt: string): Promise<void>;
}
const limit = 128 * 1024 ** 2;
const namePattern =
  /^[a-f0-9]{64}\.[a-f0-9]{64}\.[1-9][0-9]{0,19}\.receipt\.json$/;
const shaPattern = /^[a-f0-9]{64}$/;
function requireProof(ok: unknown): asserts ok {
  if (!ok)
    throw new Error(
      "Disjoint execution custody journal or coverage differs; pending evidence retained",
    );
}
function startOf(scope: LegacyReportScope, execution: number): LegacyCursor {
  return {
    execution,
    kind: "report",
    after: scope.executions[execution]?.reportAfter ?? 0,
    copied: 0,
  };
}
// Keep a long front execution productive when a few very short jobs follow.
// Only frozen counts are inspected. Among equally useful peers choose the nearest.
const peerWindow = 16;
function choosePeer(scope: LegacyReportScope, front: LegacyCursor) {
  const target = scope.executions[front.execution];
  const remaining =
    (front.kind === "report" ? target.reports : 0) +
    target.conflicts -
    front.copied;
  let selected = front.execution + 1,
    best = -1;
  const stop = Math.min(scope.executions.length, selected + peerWindow);
  for (let index = selected; index < stop; index++) {
    const candidate = scope.executions[index];
    const score = Math.min(remaining, candidate.reports + candidate.conflicts);
    if (score > best) {
      selected = index;
      best = score;
    }
    if (score === remaining) break;
  }
  return selected;
}
function stageName(c: LegacyCursor) {
  requireProof(
    [c.execution, c.after, c.copied].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) && ["report", "conflict"].includes(c.kind),
  );
  return `page-${c.execution}-${c.kind}-${c.after}-${c.copied}`;
}
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function json<T>(path: string): Promise<T> {
  const s = await stat(path);
  requireProof(s?.isFile() && s.size <= 1024 * 1024);
  return JSON.parse(await readFile(path, "utf8"));
}
async function save(path: string, value: unknown, immutable = false) {
  await durableWrite(
    path,
    Buffer.from(JSON.stringify(value) + "\n"),
    immutable,
  );
}
async function hashFile(path: string) {
  const s = await stat(path);
  requireProof(s?.isFile() && s.size <= 512 * 1024 ** 2);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function artifactName(name: string, receipt: string) {
  const [, body] = receipt.split(".");
  return (
    name === receipt ||
    name === body + ".jsonl.gz" ||
    name === receipt + ".normalized.json" ||
    /^custody-attempt-[a-f0-9]{64}\.json$/.test(name) ||
    (name.startsWith(receipt + ".") &&
      /^[a-f0-9]{64}\.custody(?:-applied)?\.json$/.test(
        name.slice(receipt.length + 1),
      ))
  );
}
// Check actual member order and every count/high-water transition. A page may
// end at the next execution's initial cursor, but may only contain its own job.
function checkMembers(
  scope: LegacyReportScope,
  start: LegacyCursor,
  page: LegacyBackupPage,
  cap: number,
) {
  const item = scope.executions[start.execution],
    c = { ...start };
  let decoded = 0;
  function advance() {
    requireProof(
      c.execution === start.execution &&
        c.copied === (c.kind === "report" ? item.reports : item.conflicts) &&
        c.after ===
          (c.kind === "report" ? item.reportHighWater : item.conflictHighWater),
    );
    Object.assign(
      c,
      c.kind === "report"
        ? { kind: "conflict", after: 0, copied: 0 }
        : startOf(scope, c.execution + 1),
    );
  }
  for (const m of page.members) {
    if (c.kind !== m.kind) advance();
    requireProof(
      c.execution === start.execution &&
        m.executionId === item.executionId &&
        m.kind === c.kind &&
        m.sequence > c.after &&
        m.sequence <=
          (c.kind === "report"
            ? item.reportHighWater
            : item.conflictHighWater) &&
        (m.kind !== "report" || m.solverId === scope.solverId),
    );
    c.after = m.sequence;
    c.copied++;
    requireProof(
      c.copied <= (m.kind === "report" ? item.reports : item.conflicts),
    );
    decoded += Buffer.byteLength(m.rowText) + m.reportByteSize;
  }
  while (!same(c, page.next)) advance();
  requireProof(decoded <= cap && !same(start, page.next));
}

/** One owner of copy.lock and checkpoint.json. A directory at the old pending
 * pathname fences pre-supervisor writers until every speculative edge is joined. */
export async function runLegacyExecutionSlots<T>(input: Inputs<T>) {
  const { scope, directory, pendingPath: journal, options } = input;
  const pairedCap = Math.min(input.maxBytes, limit);
  const sessionPath = join(journal, "session.json"),
    publicationPath = join(journal, "publishing.json");
  const retired = join(directory, ".joined-executions");
  if (await stat(retired)) {
    const names = await readdir(retired);
    requireProof(
      names.every(
        (n) => n === "session.json" || /^\.legacy-[a-f0-9-]+\.tmp$/.test(n),
      ),
    );
    if (names.includes("session.json")) {
      const old = await json<Session>(join(retired, "session.json"));
      requireProof(
        old.binding === input.binding &&
          old.target === options.targetBinding &&
          (input.cursor().next.execution >= old.peerExecution ||
            (input.cursor().next.execution >= old.first &&
              same(old.peer, startOf(scope, old.peerExecution)))),
      );
    }
    await rm(retired, { recursive: true });
    await syncDirectory(directory);
  }
  let state: Session;
  if (input.exists) state = await json<Session>(sessionPath);
  else {
    const front = input.cursor().next,
      first = front.execution,
      peerExecution = choosePeer(scope, front);
    state = {
      binding: input.binding,
      target: options.targetBinding,
      first,
      peerExecution,
      peer: startOf(scope, peerExecution),
      cap: pairedCap,
    };
    const tmp = join(directory, ".execution-pair-" + randomUUID());
    await mkdir(tmp, { mode: 0o700 });
    await save(join(tmp, "session.json"), state);
    await syncDirectory(tmp);
    await rename(tmp, journal);
    await syncDirectory(directory);
  }
  const peer = state.peerExecution;
  requireProof(
    state.binding === input.binding &&
      state.target === options.targetBinding &&
      Number.isInteger(state.first) &&
      state.first >= 0 &&
      Number.isInteger(peer) &&
      peer > state.first &&
      peer <= state.first + peerWindow &&
      peer < scope.executions.length &&
      Number.isSafeInteger(state.cap) &&
      state.cap > 0 &&
      state.cap <= limit,
  );
  requireProof(
    state.peer.execution === peer || same(state.peer, startOf(scope, peer + 1)),
  );
  stageName(state.peer);
  const pairOrder = options.pairOrder ?? "concurrent";
  requireProof(pairOrder === "concurrent" || pairOrder === "serial");
  const report = {
    maxActive: 0,
    pairOrder,
    pageWork: [] as {
      execution: string;
      role: "front" | "peer";
      start: LegacyCursor;
      next: LegacyCursor;
      generation: string;
      members: number;
      packedBytes: number;
      startedAt: string;
      elapsedMs: number;
    }[],
    appliedAhead: 0,
    pairedExecutions: [] as [string, string][],
    peerReceipts: [] as string[],
    executions: [
      scope.executions[state.first].executionId,
      scope.executions[peer].executionId,
    ],
    peerNext: { ...state.peer },
    published: 0,
    peerAdmissionDeferred: 0,
    pendingPeerExecution: null as number | null,
    memory: [] as PeerMemory[],
    admissionReasons: [] as PeerCapacityReason[],
  };
  function checkReceipt(r: LegacyBackupReceipt, start: LegacyCursor) {
    requireProof(
      r.version === 1 &&
        r.sourceInstance === scope.sourceInstance &&
        r.solverId === scope.solverId &&
        r.scopeSha256 === input.scopeHash &&
        same(r.start, start) &&
        !same(start, r.next) &&
        (r.next.execution === start.execution ||
          same(r.next, startOf(scope, start.execution + 1))) &&
        r.object.objectKey ===
          `legacy-worker-reports/v1/${scope.sourceInstance}/${scope.solverId}/${input.scopeHash}/${r.object.sha256}.jsonl.gz`,
    );
  }
  async function readReady(dir: string, start: LegacyCursor) {
    const ready = await json<Ready>(join(dir, "ready.json"));
    requireProof(
      namePattern.test(ready.receipt) &&
        Array.isArray(ready.files) &&
        ready.files.length > 0 &&
        ready.files.some((f) => f.name === ready.receipt),
    );
    for (const f of ready.files)
      requireProof(
        artifactName(f.name, ready.receipt) &&
          shaPattern.test(f.sha) &&
          (await hashFile(join(dir, f.name))) === f.sha,
      );
    requireProof(
      ready.files.find((f) => f.name === ready.receipt)!.sha ===
        ready.receipt.split(".")[0],
    );
    const receipt = await json<LegacyBackupReceipt>(join(dir, ready.receipt));
    checkReceipt(receipt, start);
    requireProof(
      ready.receipt.split(".")[1] === receipt.object.sha256 &&
        ready.receipt.split(".")[2] === receipt.object.generation,
    );
    const marker = options.applicationMarker?.(ready.receipt);
    if (marker) {
      requireProof(ready.files.some((f) => f.name === marker));
      const app = await json<{
        archiveReceiptSha256: string;
        scopeSha256: string;
        phaseBinding?: string;
        normalizerBinding: string;
        object: LegacyBackupReceipt["object"];
        proof: { transactionCommitted: boolean };
      }>(join(dir, marker));
      requireProof(
        app.archiveReceiptSha256 === ready.receipt.split(".")[0] &&
          app.scopeSha256 === input.scopeHash &&
          (app.phaseBinding ?? app.normalizerBinding) ===
            options.targetBinding &&
          app.object.generation === receipt.object.generation &&
          app.object.sha256 === receipt.object.sha256 &&
          (receipt.memberCount === 0 ||
            app.proof.transactionCommitted === true),
      );
    }
    return { ready, receipt };
  }
  async function pageBudget(start: LegacyCursor, newCap: number) {
    const path = join(journal, stageName(start), "budget.json");
    const recorded = (await stat(path)) ? await json<number>(path) : newCap;
    requireProof(
      Number.isSafeInteger(recorded) && recorded > 0 && recorded <= 2 * limit,
    );
    return recorded;
  }
  async function stage(start: LegacyCursor, second: boolean, newCap: number) {
    const dir = join(journal, stageName(start));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await syncDirectory(journal);
    requireProof((await stat(dir))?.isDirectory());
    const transfer = join(dir, "transfer.gz");
    if (await stat(join(dir, "ready.json"))) {
      const { receipt } = await readReady(dir, start);
      if (await stat(transfer)) {
        requireProof((await hashFile(transfer)) === receipt.object.sha256);
        const page = input.inspect(await input.store.read(receipt.object));
        requireProof(
          legacySha256(page.bytes) === receipt.object.sha256 &&
            same(page.start, start) &&
            same(page.next, receipt.next),
        );
        await unlink(transfer);
        await syncDirectory(dir);
      }
      return receipt;
    }
    const entries = await readdir(dir),
      pins = entries.filter((n) => namePattern.test(n));
    requireProof(pins.length <= 1);
    const cap = await pageBudget(start, newCap);
    await save(join(dir, "budget.json"), cap, true);
    let pinned: LegacyBackupReceipt | undefined;
    if (pins.length) {
      requireProof(
        (await hashFile(join(dir, pins[0]))) === pins[0].split(".")[0],
      );
      pinned = await json<LegacyBackupReceipt>(join(dir, pins[0]));
      checkReceipt(pinned, start);
    }
    let packed: Packed;
    const prior = await stat(transfer);
    if (prior) {
      requireProof(prior.isFile() && prior.size <= 512 * 1024 ** 2);
      packed = input.inspect(await readFile(transfer));
    } else {
      // No writer is invoked until the rename and directory fsync. An
      // interrupted pre-upload scratch file can be rebuilt from the source.
      if (pinned) packed = input.inspect(await input.store.read(pinned.object));
      else {
        requireProof(
          !entries.some((n) => n.endsWith(".json") && n !== "budget.json"),
        );
        packed = await input.prepare(start, second, cap);
      }
      const scratch = join(dir, "transfer.tmp");
      const file = await open(
        scratch,
        constants.O_CREAT |
          constants.O_WRONLY |
          constants.O_TRUNC |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(packed.bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(scratch, transfer);
      await syncDirectory(dir);
    }
    requireProof(
      same(packed.start, start) &&
        packed.scopeSha256 === input.scopeHash &&
        packed.sourceInstance === scope.sourceInstance &&
        packed.solverId === scope.solverId,
    );
    const name = await input.apply(packed, dir, pinned, (page) =>
      checkMembers(scope, start, page, cap),
    );
    requireProof(namePattern.test(name));
    const files: Artifact[] = [];
    for (const f of await readdir(dir))
      if (artifactName(f, name))
        files.push({ name: f, sha: await hashFile(join(dir, f)) });
    await save(join(dir, "ready.json"), { receipt: name, files }, true);
    await syncDirectory(dir);
    await unlink(transfer);
    await syncDirectory(dir);
    const receipt = await json<LegacyBackupReceipt>(join(dir, name));
    checkReceipt(receipt, start);
    return receipt;
  }
  async function timedStage(start: LegacyCursor, second: boolean, cap: number) {
    const began = performance.now(),
      startedAt = new Date().toISOString();
    const r = await stage(start, second, cap);
    report.pageWork.push({
      execution: scope.executions[start.execution].executionId,
      role: second ? "peer" : "front",
      start: r.start,
      next: r.next,
      generation: r.object.generation,
      members: r.memberCount,
      packedBytes: r.object.byteSize,
      startedAt,
      elapsedMs: performance.now() - began,
    });
    return r;
  }
  async function publish(start: LegacyCursor) {
    const dir = join(journal, stageName(start));
    const { ready, receipt } = await readReady(dir, start);
    await save(publicationPath, {
      start,
      next: receipt.next,
      receipt: ready.receipt,
      files: ready.files,
    });
    await syncDirectory(journal);
    for (const f of ready.files) {
      const dest = join(directory, f.name);
      try {
        await link(join(dir, f.name), dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        requireProof((await hashFile(dest)) === f.sha);
      }
    }
    await syncDirectory(directory);
    await input.publish(receipt.next, ready.receipt);
    report.published++;
    await clearPublication(start);
  }
  async function clearPublication(start: LegacyCursor) {
    await rm(join(journal, stageName(start)), { recursive: true, force: true });
    await syncDirectory(journal);
    await unlink(publicationPath);
    await syncDirectory(journal);
  }
  if (await stat(publicationPath)) {
    const saved = await json<{
      start: LegacyCursor;
      next: LegacyCursor;
      receipt: string;
      files: Artifact[];
    }>(publicationPath);
    const curr = input.cursor();
    requireProof(
      namePattern.test(saved.receipt) &&
        saved.start.execution >= state.first &&
        saved.start.execution <= peer &&
        Array.isArray(saved.files) &&
        saved.files.some((f) => f.name === saved.receipt),
    );
    if (same(curr.next, saved.next) && curr.lastReceipt === saved.receipt) {
      requireProof(
        (await hashFile(join(directory, saved.receipt))) ===
          saved.receipt.split(".")[0],
      );
      for (const f of saved.files)
        requireProof(
          artifactName(f.name, saved.receipt) &&
            shaPattern.test(f.sha) &&
            (await hashFile(join(directory, f.name))) === f.sha,
        );
      const object = await json<LegacyBackupReceipt>(
        join(directory, saved.receipt),
      );
      checkReceipt(object, saved.start);
      requireProof(same(object.next, saved.next));
      await clearPublication(saved.start);
    } else {
      requireProof(same(curr.next, saved.start));
      await publish(saved.start);
    }
  }
  async function retireJoined() {
    requireProof(
      (await readdir(journal)).every(
        (n) => n === "session.json" || /^\.legacy-[a-f0-9-]+\.tmp$/.test(n),
      ),
    );
    requireProof(!(await stat(retired)));
    await rename(journal, retired);
    await syncDirectory(directory);
    await rm(retired, { recursive: true });
    await syncDirectory(directory);
  }
  let used = report.published;
  let closed = false;
  for (;;) {
    const front = input.cursor().next;
    requireProof(front.execution >= state.first && front.execution <= peer + 1);
    if (front.execution >= peer) {
      const dir = join(journal, stageName(front));
      if (same(front, state.peer) && !(await stat(dir))) {
        await retireJoined();
        closed = true;
        break;
      }
      if (used >= input.pages || input.shouldStop?.()) break;
      if (!same(front, state.peer))
        requireProof(await stat(join(dir, "ready.json")));
      // Reopen an uncertain peer at its exact start, even in one-slot mode.
      const receipt = await stage(front, false, input.maxBytes);
      if (same(front, state.peer)) {
        state.peer = receipt.next;
        await save(sessionPath, state);
        await syncDirectory(journal);
      }
      await publish(front);
      used++;
      continue;
    }
    if (used >= input.pages || input.shouldStop?.()) break;
    const requestPeer =
      options.slots === 2 &&
      used + 2 <= input.pages &&
      state.peer.execution === peer &&
      (await pageBudget(front, pairedCap)) <= limit &&
      (await pageBudget(state.peer, pairedCap)) <= limit;
    const hold = join(directory, "execution-peer-memory-hold.json");
    const probe =
      requestPeer && !(await stat(hold))
        ? await options.openBudget?.()
        : undefined;
    const admit = probe?.admit === true;
    if (requestPeer && !admit) {
      report.peerAdmissionDeferred++;
      report.admissionReasons.push(
        probe?.reason ??
          ((await stat(hold)) ? "prior_capacity_hold" : "capacity_unavailable"),
      );
    }
    if (input.shouldStop?.()) {
      await probe?.finish();
      break;
    }
    const overlap = admit && pairOrder === "concurrent";
    report.maxActive = Math.max(report.maxActive, overlap ? 2 : 1);
    const jobs = [timedStage(front, false, admit ? pairedCap : input.maxBytes)];
    if (overlap) jobs.push(timedStage(state.peer, true, pairedCap));
    const settled = await Promise.allSettled(jobs);
    // A matched serial control uses the same two native cursor edges. Start
    // the peer only after the front's complete durable application receipt.
    if (
      admit &&
      !overlap &&
      settled[0].status === "fulfilled" &&
      !input.shouldStop?.()
    ) {
      settled.push(
        ...(await Promise.allSettled([
          timedStage(state.peer, true, pairedCap),
        ])),
      );
    }
    if (settled.length === 2)
      report.pairedExecutions.push([
        scope.executions[front.execution].executionId,
        scope.executions[peer].executionId,
      ]);
    const [first, other] = settled;
    used += settled.length;
    let sampleFailure: unknown;
    if (probe)
      try {
        const memory = await probe.finish();
        if (memory) report.memory.push(memory);
        if (admit && (!memory || !memory.permitted)) {
          await save(hold, { binding: input.binding, memory });
          await syncDirectory(directory);
        }
      } catch (e) {
        if (capacitySamplingFailed(e)) {
          report.admissionReasons.push("capacity_unavailable");
          if (admit) {
            await save(hold, {
              binding: input.binding,
              reason: "capacity_unavailable",
            });
            await syncDirectory(directory);
          }
        } else sampleFailure = e;
      }
    // Persist a successful late-range edge even if the first reply was lost.
    if (other?.status === "fulfilled") {
      state.peer = other.value.next;
      await save(sessionPath, state);
      await syncDirectory(journal);
      report.appliedAhead++;
      const edge = await json<Ready>(
        join(journal, stageName(other.value.start), "ready.json"),
      );
      report.peerReceipts.push(edge.receipt);
    }
    if (first.status === "fulfilled") await publish(front);
    const failures = [first, other].filter((x) => x?.status === "rejected");
    if (failures.length) {
      // Never hide a permanent proof failure behind a retryable peer failure.
      const f =
        failures.find(
          (x) => x?.status === "rejected" && !x.reason?.retryable,
        ) ?? failures[0];
      if (f?.status === "rejected") throw f.reason;
    }
    if (sampleFailure) throw sampleFailure;
  }
  // A declined pair can leave a verified, ordinary front receipt and no
  // speculative work. Return immediately to the scalar checkpoint layout.
  if (
    !closed &&
    (options.slots === 1 || report.peerAdmissionDeferred > 0) &&
    same(state.peer, startOf(scope, peer))
  ) {
    const names = await readdir(journal);
    if (names.length === 1 && names[0] === "session.json") {
      await retireJoined();
      closed = true;
    }
  }
  report.peerNext = { ...state.peer };
  if (!closed) report.pendingPeerExecution = peer;
  return report;
}
