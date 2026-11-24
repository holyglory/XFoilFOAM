import type { HistorySshEndpoint } from "./hz-point-history-relay";

export type AttemptReadRole = "worker" | "hub" | "api";
const reads: Record<AttemptReadRole, ReadonlySet<string>> = {
  worker: new Set([
    "bound",
    "one",
    "page",
    "pending",
    "status",
    "prepare",
    "catalog",
    "science",
    "canonical-candidates",
    "registered-state",
  ]),
  hub: new Set(["read", "read-canonical-source"]),
  api: new Set(["api", "canonical-read"]),
};
export const MAX_ATTEMPT_READ_MESSAGES = 64;
export const ATTEMPT_READ_IDLE_MS = 30_000;
export const ATTEMPT_READ_LIFETIME_MS = 120_000;

export function isAttemptRead(role: AttemptReadRole, operation: unknown) {
  return typeof operation === "string" && reads[role].has(operation);
}

type Endpoint = Pick<
  HistorySshEndpoint,
  "ask" | "close" | "continuesAttemptReadSession"
>;

/** One serial, read-only SSH channel per role. Each ask is individually
 * correlated. A peer without a continuation acknowledgement stays one-shot. */
export class AttemptReadSession {
  private endpoint?: Endpoint;
  private legacy = false;
  private used = 0;
  private opened = 0;
  private last = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private role: AttemptReadRole,
    private open: () => Endpoint,
  ) {}

  ask(request: Record<string, unknown>) {
    if (!isAttemptRead(this.role, request.operation))
      throw new Error("Attempt read session requires a read operation");
    const pending = this.queue.then(() => this.exchange(request));
    this.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
  private async discard() {
    const endpoint = this.endpoint;
    this.endpoint = undefined;
    await endpoint?.close();
  }
  private async exchange(request: Record<string, unknown>) {
    const now = Date.now();
    if (
      this.endpoint &&
      (this.used >= MAX_ATTEMPT_READ_MESSAGES ||
        now - this.last >= ATTEMPT_READ_IDLE_MS - 5000 ||
        now - this.opened >= ATTEMPT_READ_LIFETIME_MS - 5000)
    )
      await this.discard();
    if (!this.endpoint) {
      this.endpoint = this.open();
      this.opened = now;
      this.used = 0;
    }
    try {
      const response = await this.endpoint.ask(
        this.legacy ? request : { ...request, attemptReadSession: this.role },
      );
      this.last = Date.now();
      this.used++;
      if (!this.endpoint.continuesAttemptReadSession) {
        // The final bounded message also closes a new peer.
        if (
          this.used < MAX_ATTEMPT_READ_MESSAGES &&
          this.last - this.opened < ATTEMPT_READ_LIFETIME_MS - 5000
        )
          this.legacy = true;
        await this.discard();
      }
      return response;
    } catch (error) {
      await this.discard();
      throw error;
    }
  }
  async close() {
    await this.queue;
    await this.discard();
  }
}
