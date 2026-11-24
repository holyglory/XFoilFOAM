import {
  isAttemptRead,
  MAX_ATTEMPT_READ_MESSAGES,
  ATTEMPT_READ_IDLE_MS,
  ATTEMPT_READ_LIFETIME_MS,
  type AttemptReadRole,
} from "./hz-attempt-read-session";
import {
  HistoryMessages,
  HistoryOperationError,
} from "@aerodb/core/point-history-protocol";
import { hzAttemptRpcFailure } from "./hz-attempt-transfer-fence";

export const ZERO_ID = "00000000-0000-0000-0000-000000000000";
export function exactId(id: unknown): string {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    throw Error("Invalid attempt identifier");
  return id.toLowerCase();
}
export function packedBytes(value: unknown) {
  if (typeof value !== "string" || !value.length || value.length > 1400000)
    throw Error("Attempt transfer size exceeded");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > 1048576)
    throw Error("Invalid packed attempt");
  return bytes;
}

export async function attemptRpc(
  handler: (r: Record<string, any>) => Promise<unknown>,
  readRole?: AttemptReadRole,
) {
  const wire = new HistoryMessages(process.stdin, process.stdout);
  const opened = Date.now();
  try {
    let request = await wire.read();
    const role = request.attemptReadSession;
    for (let count = 1; ; count++) {
      if (
        role !== undefined &&
        (!readRole ||
          role !== readRole ||
          request.attemptReadSession !== role ||
          !isAttemptRead(readRole, request.operation))
      ) {
        await wire.send({
          id: request.id,
          error: {
            operation: "attempt_read_scope",
            category: "denied",
            retryable: false,
          },
        });
        return;
      }
      try {
        // The role handler opens and closes its own DB client for every request.
        const result = await handler(request);
        const more =
          role !== undefined &&
          count < MAX_ATTEMPT_READ_MESSAGES &&
          Date.now() - opened < ATTEMPT_READ_LIFETIME_MS;
        await wire.send({
          id: request.id,
          result,
          ...(more ? { attemptReadSession: role } : {}),
        });
        if (!more) return;
      } catch (error) {
        const operation =
          "attempt_" +
          String(request.operation)
            .replace(/[^a-z_]/g, "")
            .slice(0, 20);
        await wire.send({
          id: request.id,
          error: hzAttemptRpcFailure(operation, error),
        });
        return;
      }
      try {
        request = await wire.read(
          Math.max(
            1,
            Math.min(
              ATTEMPT_READ_IDLE_MS,
              opened + ATTEMPT_READ_LIFETIME_MS - Date.now(),
            ),
          ),
        );
      } catch (error) {
        if (
          error instanceof HistoryOperationError &&
          error.operation === "read" &&
          error.category === "transport"
        )
          return;
        throw error;
      }
    }
  } finally {
    wire.close();
  }
}
