import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "@aerodb/db/client";
import {
  HistoryMessages,
  HistoryOperationError,
} from "@aerodb/core/point-history-protocol";
import { HzAttemptHubStore } from "./hz-attempt-hub";
import { exactId } from "./hz-attempt-custody";
import {
  inspectOriginals,
  originalBinding,
  mapOriginals,
  prepareOriginals,
  originalHubObjects,
  registerOriginals,
  type SourceBinding,
} from "./hz-attempt-originals";

export async function originalWorkerRequest(db: DB, r: Record<string, any>) {
  const b = await originalBinding(db);
  if (r.operation === "bound") return b;
  if (b.instance !== r.binding?.instance || b.solver !== r.binding?.solver)
    throw Error("Changed worker registration");
  switch (r.operation) {
    case "inventory":
      return inspectOriginals(db, b, r.selection);
    case "prepare":
      return prepareOriginals(db, b, r.pins, r.budget);
    case "register":
      return registerOriginals(db, b, r.items, r.budget);
    default:
      throw Error("Unknown original worker operation");
  }
}
export async function originalHubRequest(
  db: DB,
  r: Record<string, any>,
  storeFactory = (bucket: string, account: string) =>
    new HzAttemptHubStore(bucket, account, fetch, true),
) {
  if ((process.env.AIRFOILFOAM_DEPLOYMENT_ROLE ?? "hub") !== "hub")
    throw new HistoryOperationError("hub_role", "denied");
  const b: SourceBinding = {
    instance: exactId(r.binding?.instance),
    solver: exactId(r.binding?.solver),
    high: exactId(r.binding?.high),
  };
  const [bound] = await db.execute(
    sql`SELECT s.id FROM registered_remote_solvers s JOIN sync_api_settings hub ON hub.id=1 AND hub.instance_id::text<>${b.instance} WHERE s.id=${b.solver}::uuid AND s.instance_id=${b.instance} AND s.revoked_at IS NULL`,
  );
  if (!bound) throw new HistoryOperationError("hub_registration", "denied");
  if (r.operation === "mapping") return mapOriginals(db, b, r.rows);
  if (
    r.operation !== "objects" ||
    !r.bucket ||
    r.bucket !== process.env.AIRFOILFOAM_EVIDENCE_BUCKET ||
    typeof r.account !== "string"
  )
    throw Error("Invalid hub original request");
  return originalHubObjects(
    storeFactory(r.bucket, r.account),
    b,
    r.items,
    r.budget,
  );
}
export async function serveOriginals() {
  const wire = new HistoryMessages(process.stdin, process.stdout);
  const ro = createClient({
    max: 1,
    connection: {
      application_name: "hz_attempt_originals_read",
      default_transaction_read_only: "on",
      statement_timeout: "20s",
      lock_timeout: "1s",
      idle_in_transaction_session_timeout: "5s",
    },
  });
  try {
    for (;;) {
      let r;
      try {
        r = await wire.read(180000);
      } catch (error) {
        if (wire.ended) return;
        throw error;
      }
      const reg = r.operation === "register";
      try {
        let result;
        if (reg) {
          if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver")
            throw Error("Invalid registration role");
          const writer = createClient({
            max: 1,
            connection: {
              application_name: "hz_attempt_originals_register",
              statement_timeout: "15s",
              lock_timeout: "1s",
              idle_in_transaction_session_timeout: "5s",
            },
          });
          try {
            result = await originalWorkerRequest(writer.db, r);
          } finally {
            await writer.sql.end({ timeout: 1 });
          }
        } else if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver")
          result = await originalWorkerRequest(ro.db, r);
        else result = await originalHubRequest(ro.db, r);
        await wire.send({ id: r.id, result });
      } catch (e) {
        const code =
          (e as { cause?: { code?: string } })?.cause?.code ??
          (e as { code?: string })?.code;
        const retry =
          (e instanceof HistoryOperationError && e.retryable) ||
          [
            "55P03",
            "40001",
            "40P01",
            "08003",
            "08006",
            "57P01",
            "57P02",
            "57P03",
          ].includes(code ?? "");
        await wire.send({
          id: r.id,
          error: {
            operation:
              "original_" +
              String(r.operation)
                .replace(/[^a-z]/g, "")
                .slice(0, 18),
            category: retry
              ? "transport"
              : e instanceof HistoryOperationError && e.category === "denied"
                ? "denied"
                : "integrity",
            retryable: retry,
          },
        });
      }
      // Controller takes the shared deployment lock only for this write page.
      if (reg) return;
    }
  } finally {
    wire.close();
    await ro.sql.end({ timeout: 1 });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  serveOriginals().catch(() => {
    console.error("Original archive helper unavailable");
    process.exitCode = 1;
  });
