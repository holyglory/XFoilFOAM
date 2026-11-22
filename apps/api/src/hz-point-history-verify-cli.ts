import { pathToFileURL } from "node:url";
import { createClient, type DB } from "@aerodb/db/client";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import { forceHistory, results } from "@aerodb/db/schema";
import { forceHistoryArchiveForRow } from "@aerodb/db/solver-history-storage";
import { resultHistoryArchiveForRow } from "@aerodb/db/result-history-storage";
import { readStoredForceHistory } from "./solver-history-reader";
import { readStoredResultHistories } from "./result-history-reader";
import type { PointHistoryIdentity } from "@aerodb/core/point-history-working-copy";
import {
  historyArchiveIdentity,
  pointHistoryIdentityDigest,
} from "@aerodb/core/point-history-working-copy";
import { readHzPointHistory } from "./hz-point-history-reader";
import { HistoryMessages } from "@aerodb/core/point-history-protocol";
export async function verifyHzApiHistory(
  db: DB,
  identity: PointHistoryIdentity,
  throughCatalog = false,
) {
  const restored = await readHzPointHistory(db, identity);
  if (throughCatalog) {
    const archive =
      identity.sourceKind === "force_history"
        ? await forceHistoryArchiveForRow(db, identity.sourceId)
        : await resultHistoryArchiveForRow(
            db,
            identity.resultId,
            identity.sourceKind,
          );
    if (
      !archive ||
      pointHistoryIdentityDigest(archive) !==
        pointHistoryIdentityDigest(identity)
    )
      throw new Error(
        "Catalog history pointer differs from the recorded generation",
      );
    let value: unknown;
    if (identity.sourceKind === "force_history") {
      const [stored] = await db
        .select()
        .from(forceHistory)
        .where(eq(forceHistory.id, identity.sourceId));
      if (!stored || stored.historyArchiveId !== archive.id)
        throw new Error("Force history pointer changed");
      const { t, cl, cd, cm } = await readStoredForceHistory(db, stored);
      value = { t, cl, cd, cm };
    } else {
      const fields =
        identity.sourceKind === "steady_history"
          ? {
              value: results.steadyHistory,
              archive: results.steadyHistoryArchiveId,
            }
          : { value: results.frameTrack, archive: results.frameTrackArchiveId };
      const [stored] = await db
        .select(fields)
        .from(results)
        .where(eq(results.id, identity.resultId));
      if (!stored || stored.archive !== archive.id)
        throw new Error("Result history pointer changed");
      value =
        identity.sourceKind === "steady_history"
          ? (
              await readStoredResultHistories(db, {
                id: identity.resultId,
                steadyHistory: stored.value,
                steadyHistoryArchiveId: stored.archive,
              })
            ).steadyHistory
          : (
              await readStoredResultHistories(db, {
                id: identity.resultId,
                frameTrack: stored.value,
                frameTrackArchiveId: stored.archive,
              })
            ).frameTrack;
    }
    if (!isDeepStrictEqual(value, JSON.parse(restored.payloadText)))
      throw new Error("Normal API history differs from exact archive");
  }
  return {
    identityDigest: pointHistoryIdentityDigest(identity),
    sourceSha256: createHash("sha256")
      .update(restored.payloadText)
      .digest("hex"),
    sourceByteSize: Buffer.byteLength(restored.payloadText),
    throughCatalog,
    checkedAt: new Date().toISOString(),
  };
}
export async function runHzApiHistoryProbe() {
  if (!process.env.DATABASE_URL)
    throw new Error("Explicit API database required");
  const channel = new HistoryMessages(process.stdin, process.stdout),
    client = createClient({
      max: 1,
      connection: {
        application_name: "hz-point-history-readback",
        statement_timeout: "10s",
      },
    });
  try {
    for (;;) {
      let request;
      try {
        request = await channel.read(600000);
      } catch (error) {
        if (channel.ended) return;
        throw error;
      }
      if (request.operation === "close") return;
      try {
        const result = await verifyHzApiHistory(
          client.db,
          historyArchiveIdentity(request.identity),
          request.throughCatalog === true,
        );
        await channel.send({ id: request.id, result });
      } catch {
        await channel.send({
          id: request.id,
          error: {
            operation: "api_history_read",
            category: "integrity",
            retryable: false,
          },
        });
      }
    }
  } finally {
    await client.sql.end({ timeout: 2 });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runHzApiHistoryProbe().catch(() => {
    process.stderr.write("HZ API point history readback failed\n");
    process.exitCode = 1;
  });
