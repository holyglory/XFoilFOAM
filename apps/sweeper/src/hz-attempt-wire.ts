import { HistoryMessages } from "@aerodb/core/point-history-protocol";
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
) {
  const wire = new HistoryMessages(process.stdin, process.stdout);
  const r = await wire.read();
  try {
    await wire.send({ id: r.id, result: await handler(r) });
  } catch (e) {
    const operation =
      "attempt_" +
      String(r.operation)
        .replace(/[^a-z_]/g, "")
        .slice(0, 20);
    await wire.send({ id: r.id, error: hzAttemptRpcFailure(operation, e) });
  } finally {
    wire.close();
  }
}
