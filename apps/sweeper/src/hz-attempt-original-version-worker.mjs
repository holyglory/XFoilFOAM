// Executed by the private controller through the installed remote-solver modules.
// No database writer, cloud client, registration call or scheduler is opened here.
const root = import.meta.url.endsWith("/hz-attempt-original-version-worker.mjs")
  ? new URL("../../../", import.meta.url)
  : new URL("file:///app/");
const load = (path) => import(new URL(path, root).href);
const { sql } = await load("apps/sweeper/node_modules/drizzle-orm/index.js");
const {
  originalBinding,
  inspectOriginals,
  prepareOriginals,
  checkPin,
  samePin,
} = await load("apps/sweeper/src/hz-attempt-originals.ts");
const { packHzAttemptSource } = await load(
  "apps/sweeper/src/hz-attempt-custody.ts",
);
const { prepareAttemptEvidenceCopy } = await load(
  "packages/db/src/attempt-evidence-storage.ts",
);
const { checkHzTransferFence, hzAttemptRpcFailure } = await load(
  "apps/sweeper/src/hz-attempt-transfer-fence.ts",
);
const { HistoryMessages } = await load(
  "packages/core/src/point-history-protocol.ts",
);

export async function readOriginalVersion(
  db,
  binding,
  pin,
  inspectOnly = false,
) {
  checkPin(pin);
  const captured = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
    );
    const b = await originalBinding(tx);
    if (b.instance !== binding.instance || b.solver !== binding.solver)
      throw Error("Version registration changed");
    await checkHzTransferFence(tx, binding);
    const [row] = await inspectOriginals(tx, b, { ids: [pin.id] });
    if (!row?.owned || row.job !== pin.job || row.result !== pin.result)
      throw Error("Version producer differs from frozen owner");
    if (!samePin(row, pin)) {
      if (typeof row.sha !== "string" || !Number.isSafeInteger(row.bytes))
        throw Error("Current revision unavailable");
      return { changed: { sha: row.sha, bytes: row.bytes } };
    }
    // prepareOriginals validates the full signed producing request, native
    // registration, promise and immutable submission before it can defer.
    // A deferred result authorizes only reading this pinned version.
    const prepared = await prepareOriginals(tx, b, [pin], pin.bytes);
    if (prepared.items.length === 1 && !prepared.deferred.length) {
      if (!samePin(prepared.items[0].pin, pin))
        throw Error("Original pin changed");
      return inspectOnly ? { current: true } : { item: prepared.items[0] };
    }
    if (
      prepared.items.length ||
      prepared.deferred.length !== 1 ||
      prepared.deferred[0] !== pin.id
    )
      throw Error("Incomplete source owner proof");
    if (inspectOnly) return { current: true };
    const [source] =
      await tx.execute(sql`SELECT a.id::text AS "attemptId",a.result_id::text AS "resultId",
      a.sim_job_id::text AS "simJobId",a.evidence_payload::text AS "payloadText"
      FROM result_attempts a WHERE a.id=${pin.id}::uuid AND a.evidence_archive_id IS NULL
      AND a.result_id IS NOT DISTINCT FROM ${pin.result}::uuid AND a.sim_job_id IS NOT DISTINCT FROM ${pin.job}::uuid
      AND octet_length(a.evidence_payload::text)=${pin.bytes}`);
    if (!source) throw Error("Missing exact original version");
    return { source };
  });
  if (!captured.source) return captured;
  const packed = await packHzAttemptSource(captured.source);
  if (
    packed.proof.sourceSha256 !== pin.sha ||
    packed.proof.sourceByteSize !== pin.bytes ||
    packed.proof.attemptId !== pin.id ||
    packed.proof.resultId !== pin.result ||
    packed.proof.simJobId !== pin.job ||
    prepareAttemptEvidenceCopy(captured.source).historySeries.reduce(
      (n, x) => n + x.byteSize,
      0,
    ) !== pin.history
  )
    throw Error("Original version differs from frozen bytes");
  return { item: { pin, ...packed } };
}

export async function serveOriginalVersion() {
  const { createClient } = await load("packages/db/src/client.ts");
  const wire = new HistoryMessages(process.stdin, process.stdout);
  const c = createClient({
    max: 1,
    connection: {
      application_name: "hz_original_version_read",
      default_transaction_read_only: "on",
      statement_timeout: "12s",
      lock_timeout: "500ms",
      idle_in_transaction_session_timeout: "5s",
    },
  });
  try {
    const r = await wire.read();
    try {
      if (
        process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver" ||
        !["snapshot", "recheck"].includes(r.operation)
      )
        throw Error("Invalid original version operation");
      await wire.send({
        id: r.id,
        result: await readOriginalVersion(
          c.db,
          r.binding,
          r.pin,
          r.operation === "recheck",
        ),
      });
    } catch (e) {
      await wire.send({
        id: r.id,
        error: hzAttemptRpcFailure("original_prepare", e),
      });
    }
  } finally {
    wire.close();
    await c.sql.end({ timeout: 1 });
  }
}
