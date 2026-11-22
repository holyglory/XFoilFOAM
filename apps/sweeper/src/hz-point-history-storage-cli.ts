import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { runHzPointHistoryOperator } from "./hz-point-history-relay-service";
import {
  validateRelayOptions,
  HzHistoryConnections,
  openHistoryWorker,
  verifyStoredHzHistory,
  type HZRelayOptions,
} from "./hz-point-history-relay";
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
import { validateHistorySelection } from "@aerodb/db/hz-point-history-storage";
export async function hzPointHistoryStorageCli(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      apply: { type: "boolean" },
      "readers-ready": { type: "boolean" },
      kind: { type: "string", default: "all" },
      id: { type: "string" },
      after: { type: "string" },
      limit: { type: "string", default: "8" },
      "max-bytes": { type: "string", default: String(8 * 1024 * 1024) },
      directory: { type: "string" },
      "max-passes": { type: "string" },
      "hz-host": { type: "string", default: process.env.HZ_SSH_HOST },
      "hz-sweeper-container": {
        type: "string",
        default: process.env.HZ_SWEEPER_CONTAINER,
      },
      "hz-api-container": {
        type: "string",
        default: process.env.HZ_API_CONTAINER,
      },
      "hub-host": { type: "string", default: process.env.HUB_SSH_HOST },
      "hub-sweeper-container": {
        type: "string",
        default: process.env.HUB_SWEEPER_CONTAINER,
      },
      bucket: { type: "string", default: process.env.HUB_EVIDENCE_BUCKET },
      "hub-service-account": {
        type: "string",
        default: process.env.HUB_SERVICE_ACCOUNT,
      },
      "source-instance": { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "hz-point-history-storage-cli pass|migrate|watch|status|candidates|verify --directory=ABSOLUTE --kind=all|force_history|steady_history|frame_track [--id=UUID --limit=1] [--apply --readers-ready] [--max-passes=N]; configure HZ/HUB SSH, containers, bucket and canonical hub service account via flags or documented environment variables.",
    );
    return;
  }
  const command = positionals[0] ?? "pass";
  if (
    positionals.length > 1 ||
    !["pass", "migrate", "watch", "status", "candidates", "verify"].includes(
      command,
    )
  )
    throw new HistoryOperationError("options", "input");
  const required = (key: keyof typeof values) => {
    const value = values[key];
    if (typeof value !== "string" || !value)
      throw new HistoryOperationError(`missing_${key}`, "input");
    return value;
  };
  if (command === "status" || command === "candidates") {
    if (values.apply) throw new HistoryOperationError("read_only", "input");
    if (
      command === "candidates" &&
      !["force_history", "steady_history", "frame_track"].includes(values.kind)
    )
      throw new HistoryOperationError("kind", "input");
    const worker = openHistoryWorker(
      required("hz-host"),
      required("hz-sweeper-container"),
    );
    try {
      if (command === "status") {
        console.log(JSON.stringify(await worker.ask({ operation: "status" })));
        return;
      }
      const hello = await worker.ask({ operation: "hello" });
      if (
        values["source-instance"] &&
        values["source-instance"] !== hello.instance
      )
        throw new HistoryOperationError("worker_instance", "integrity");
      const page = await worker.ask({
        operation: "scan",
        input: {
          kind: values.kind,
          after: values.after ?? null,
          high: hello.high[values.kind],
          limit: Number(values.limit),
          maxBytes: Number(values["max-bytes"]),
        },
      });
      console.log(JSON.stringify(page));
    } finally {
      await worker.close();
    }
    return;
  }
  if (values.after)
    throw new HistoryOperationError("after_requires_candidates", "input");
  const options: HZRelayOptions = {
    hzHost: required("hz-host"),
    hzSweeperContainer: required("hz-sweeper-container"),
    hzApiContainer: required("hz-api-container"),
    hubHost: required("hub-host"),
    hubSweeperContainer: required("hub-sweeper-container"),
    bucket: required("bucket"),
    hubServiceAccount: required("hub-service-account"),
    sourceInstance: values["source-instance"],
    kind: values.kind as HZRelayOptions["kind"],
    limit: Number(values.limit),
    maxBytes: Number(values["max-bytes"]),
  };
  validateRelayOptions(options);
  const selection = values.id
    ? { kind: options.kind as "force_history", id: values.id }
    : undefined;
  if (selection) validateHistorySelection(selection);
  if (command === "verify") {
    if (!selection || values.apply)
      throw new HistoryOperationError("verify_selection", "input");
    const connections = new HzHistoryConnections(options);
    try {
      await connections.hello();
      console.log(
        JSON.stringify(
          await verifyStoredHzHistory(selection, connections.services()),
        ),
      );
    } finally {
      await connections.close();
    }
    return;
  }
  const directory = required("directory");
  if (!isAbsolute(directory))
    throw new HistoryOperationError("directory", "input");
  const maxPasses =
    values["max-passes"] === undefined
      ? undefined
      : Number(values["max-passes"]);
  if (
    maxPasses !== undefined &&
    (!Number.isSafeInteger(maxPasses) || maxPasses < 1)
  )
    throw new HistoryOperationError("max_passes", "input");
  if (!values.apply) {
    console.log(
      JSON.stringify({
        operation: command,
        mode: "plan",
        kind: options.kind,
        id: selection?.id ?? null,
        limit: options.limit,
        maxBytes: options.maxBytes,
        directory,
        topology: "controller SSH to HZ and hub; no HZ cloud credentials",
        custody:
          "fresh hub generation + fsynced HZ working copy + normal API read + guarded 0204/0206",
        automatic: command === "watch",
      }),
    );
    return;
  }
  if (!values["readers-ready"])
    throw new HistoryOperationError("readers_ready", "input");
  const stop = new AbortController(),
    onStop = () => stop.abort();
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  try {
    console.log(
      JSON.stringify(
        await runHzPointHistoryOperator(options, {
          directory,
          mode: command as "pass" | "migrate" | "watch",
          selection,
          maxPasses,
          signal: stop.signal,
          emit: (event) => console.log(JSON.stringify(event)),
        }),
      ),
    );
  } finally {
    process.off("SIGTERM", onStop);
    process.off("SIGINT", onStop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  hzPointHistoryStorageCli().catch((error) => {
    const failure =
      error instanceof HistoryOperationError
        ? error
        : new HistoryOperationError(
            "operator",
            (error as NodeJS.ErrnoException)?.code ? "local_io" : "integrity",
          );
    process.stderr.write(
      JSON.stringify({
        event: "failed",
        operation: failure.operation,
        category: failure.category,
        retryable: failure.retryable,
      }) + "\n",
    );
    process.exitCode = 1;
  });
