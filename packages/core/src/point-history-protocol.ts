import type { Readable, Writable } from "node:stream";
import { MAX_POINT_HISTORY_PACKED_BYTES } from "./point-history-working-copy";

export const MAX_HISTORY_MESSAGE = 2 * MAX_POINT_HISTORY_PACKED_BYTES + 16384;
export const SETTLED_REPORT_SIZE_LIMIT = "worker-signed-report-byte-limit";
export class HistoryOperationError extends Error {
  constructor(
    readonly operation: string,
    readonly category:
      | "transport"
      | "denied"
      | "integrity"
      | "transfer_paused"
      | "deployment_busy"
      | "database_busy"
      | "input"
      | "local_io",
    readonly retryable = false,
  ) {
    super(`History operation failed: ${operation}/${category}`);
    this.name = "HistoryOperationError";
  }
}
export class HistoryMessages {
  private readonly iterator: AsyncIterator<Buffer>;
  private remainder: Buffer = Buffer.alloc(0);
  constructor(
    private readonly source: Readable,
    private readonly sink: Writable,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
    sink.on("error", () => undefined);
  }
  async read(timeout = 120000): Promise<Record<string, any>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.readLine(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.source.destroy();
            reject(new HistoryOperationError("read", "transport", true));
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async readLine() {
    const parts: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = this.remainder.length
        ? this.remainder
        : ((await this.iterator.next()).value as Buffer | undefined);
      this.remainder = Buffer.alloc(0);
      if (!chunk) throw new HistoryOperationError("read", "transport", true);
      const end = chunk.indexOf(10),
        length = end < 0 ? chunk.length : end;
      size += length;
      if (size > MAX_HISTORY_MESSAGE)
        throw new HistoryOperationError("message", "input");
      parts.push(chunk.subarray(0, length));
      if (end >= 0) {
        this.remainder = chunk.subarray(end + 1);
        const bytes = Buffer.concat(parts);
        const text = bytes.toString("utf8");
        if (!Buffer.from(text).equals(bytes))
          throw new HistoryOperationError("message", "integrity");
        try {
          return JSON.parse(text) as Record<string, any>;
        } catch {
          throw new HistoryOperationError("message", "input");
        }
      }
    }
  }
  async send(value: unknown, timeout = 120000) {
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > MAX_HISTORY_MESSAGE)
      throw new HistoryOperationError("message", "input");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sink.destroy();
        reject(new HistoryOperationError("send", "transport", true));
      }, timeout);
      this.sink.write(text, (error) => {
        clearTimeout(timer);
        if (error) reject(new HistoryOperationError("send", "transport", true));
        else resolve();
      });
    });
  }
  get ended() {
    return this.source.readableEnded;
  }
  close() {
    this.sink.end();
  }
}
export function boundedPacked(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(MAX_POINT_HISTORY_PACKED_BYTES / 3) * 4
  )
    throw new HistoryOperationError("packed", "input");
  const bytes = Buffer.from(value, "base64");
  if (
    !bytes.length ||
    bytes.toString("base64") !== value ||
    bytes.length > MAX_POINT_HISTORY_PACKED_BYTES
  )
    throw new HistoryOperationError("packed", "integrity");
  return bytes;
}
