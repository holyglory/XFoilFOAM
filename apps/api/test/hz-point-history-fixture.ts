import type { FastifyInstance } from "fastify";
import type { DB } from "@aerodb/db/client";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import {
  forceHistory,
  results,
  resultAttempts,
  syncApiSettings,
  syncApiPermissions,
} from "@aerodb/db/schema";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodePointHistory,
  pointHistoryKey,
  pointHistoryCrc32c,
  type PointHistoryIdentity,
} from "@aerodb/core/point-history-working-copy";
import { readStoredResultHistories } from "../src/result-history-reader";
import { verifyHzApiHistory } from "../src/hz-point-history-verify-cli";
import { handleHzHistoryRequest } from "../../sweeper/src/hz-point-history-custody-cli";
import {
  migrateHzHistory,
  type HistoryRelayServices,
} from "../../sweeper/src/hz-point-history-relay";
import type { HistorySelection } from "@aerodb/db/hz-point-history-storage";

export async function checkHzHistoryApi(
  app: FastifyInstance,
  db: DB,
  resultId: string,
  currentAttemptId: string,
  slug: string,
) {
  const role = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE,
    mediaRoot = process.env.MEDIA_DIR,
    root = await mkdtemp(join(tmpdir(), "hz-api-history-"));
  const [settings] = await db
    .select()
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1));
  if (!settings) throw new Error("Seeded instance settings required");
  const instance = settings.instanceId;
  const [priorPermission] = await db
    .select()
    .from(syncApiPermissions)
    .where(eq(syncApiPermissions.dataType, "polars"));
  const secret = "point-history-test-" + resultId;
  const [history] = await db
    .select()
    .from(forceHistory)
    .where(eq(forceHistory.resultAttemptId, currentAttemptId));
  const [canonical] = await db
    .select()
    .from(results)
    .where(eq(results.id, resultId));
  const [attemptBefore] = await db
    .select()
    .from(resultAttempts)
    .where(eq(resultAttempts.id, currentAttemptId));
  const histories = {
    units: { time: "s", coefficient: "1" },
    sampleInterval: 0.01,
    t: Array.from({ length: 1024 }, (_, i) => i / 100),
    cl: Array.from({ length: 1024 }, () => 0.63),
    cd: Array.from({ length: 1024 }, () => 0.014),
    cm: Array.from({ length: 1024 }, () => -0.025),
  };
  await db
    .update(results)
    .set({ steadyHistory: histories, frameTrack: histories })
    .where(eq(results.id, resultId));
  process.env.MEDIA_DIR = root;
  process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
  const objects = new Map<string, Buffer>(),
    identities: PointHistoryIdentity[] = [];
  const services: HistoryRelayServices = {
    prepare: (selection) =>
      handleHzHistoryRequest(db, {
        operation: "prepare",
        selection,
      }) as ReturnType<HistoryRelayServices["prepare"]>,
    put: async (source, sourceInstance) => {
      const { stored, ...hashes } = encodePointHistory(sourceInstance, source);
      const identity = {
        ...source,
        ...hashes,
        sourceInstance,
        bucket: "api-hz-history",
        objectKey: pointHistoryKey(sourceInstance, source, hashes.storedSha256),
        generation: "18446744073709551615",
        crc32c: pointHistoryCrc32c(stored),
        verifiedAt: new Date(),
      } as PointHistoryIdentity;
      objects.set(identity.objectKey, stored);
      identities.push(identity);
      return { identity, packed: stored };
    },
    read: async (identity) => objects.get(identity.objectKey)!,
    store: (identity, packed) =>
      handleHzHistoryRequest(db, {
        operation: "store",
        identity,
        packed: packed.toString("base64"),
      }),
    apiRead: (identity, throughCatalog) =>
      verifyHzApiHistory(db, identity, throughCatalog),
    apply: (identity, apiReadback, hubReadbackAt) =>
      handleHzHistoryRequest(db, {
        operation: "apply",
        identity,
        apiReadback,
        hubReadbackAt,
      }) as ReturnType<HistoryRelayServices["apply"]>,
  };
  try {
    await db
      .update(forceHistory)
      .set({ cm: [-0.02, -0.025] })
      .where(eq(forceHistory.id, history.id));
    await db
      .update(syncApiSettings)
      .set({ enabled: true, secret })
      .where(eq(syncApiSettings.id, 1));
    await db
      .insert(syncApiPermissions)
      .values({ dataType: "polars", canFetch: true, canPush: false })
      .onConflictDoUpdate({
        target: syncApiPermissions.dataType,
        set: { canFetch: true },
      });
    const exported = async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/sync/v1/export?types=polars&limit=500",
        headers: { "x-xfoilfoam-sync-secret": secret },
      });
      expect(response.statusCode).toBe(200);
      const found = response
        .json()
        .items.find(
          (item: { data: { remoteResultId: string } }) =>
            item.data.remoteResultId === resultId,
        );
      expect(found).toBeDefined();
      return found.data;
    };
    const exportBefore = await exported();
    const before = await app.inject({
      method: "GET",
      url: `/api/airfoils/${slug}/sim?resultId=${resultId}`,
    });
    expect(before.statusCode).toBe(200);
    for (const selection of [
      { kind: "force_history", id: history.id },
      { kind: "steady_history", id: resultId },
      { kind: "frame_track", id: resultId },
    ] as HistorySelection[])
      expect(
        await migrateHzHistory(selection, instance, services, async () => {}),
      ).toMatchObject({ offloaded: true, inlineRetained: false });
    const response = await app.inject({
      method: "GET",
      url: `/api/airfoils/${slug}/sim?resultId=${resultId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cl: 0.63,
      cd: 0.014,
      cm: -0.025,
      ld: 45,
      history: before.json().history,
    });
    const [raw] = await db
      .select()
      .from(results)
      .where(eq(results.id, resultId));
    expect(raw).toMatchObject({ cl: 0.41, cd: 0.021, cm: -0.01 });
    const exportAfter = await exported();
    expect(exportAfter).toMatchObject({
      steadyHistory: exportBefore.steadyHistory,
      frameTrack: exportBefore.frameTrack,
      cl: 0.41,
      cd: 0.021,
      cm: -0.01,
    });
    const hydrated = await readStoredResultHistories(db, raw);
    expect(hydrated.steadyHistory).toEqual(histories);
    expect(hydrated.frameTrack).toEqual(histories);
    const [attemptAfter] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.id, currentAttemptId));
    expect(attemptAfter).toEqual(attemptBefore);
    // The API must not synthesize arrays or silently try a forbidden hub fetch.
    const force = identities.find(
      (identity) => identity.sourceKind === "force_history",
    )!;
    await unlink(
      join(
        root,
        "point-histories/v1",
        force.storedSha256.slice(0, 2),
        `${force.storedSha256}.json.gz`,
      ),
    );
    const unavailable = await app.inject({
      method: "GET",
      url: `/api/airfoils/${slug}/sim?resultId=${resultId}`,
    });
    expect(unavailable.statusCode).toBeGreaterThanOrEqual(500);
  } finally {
    await db
      .update(syncApiSettings)
      .set({ enabled: settings.enabled, secret: settings.secret })
      .where(eq(syncApiSettings.id, 1));
    if (priorPermission)
      await db
        .update(syncApiPermissions)
        .set({ canFetch: priorPermission.canFetch })
        .where(eq(syncApiPermissions.dataType, "polars"));
    else
      await db
        .delete(syncApiPermissions)
        .where(eq(syncApiPermissions.dataType, "polars"));
    await db
      .update(forceHistory)
      .set({ t: history.t, cl: history.cl, cd: history.cd, cm: history.cm })
      .where(eq(forceHistory.id, history.id));
    await db
      .update(results)
      .set({
        steadyHistory: canonical.steadyHistory,
        frameTrack: canonical.frameTrack,
        steadyHistoryArchiveId: null,
        frameTrackArchiveId: null,
      })
      .where(eq(results.id, resultId));
    if (role === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = role;
    if (mediaRoot === undefined) delete process.env.MEDIA_DIR;
    else process.env.MEDIA_DIR = mediaRoot;
    await rm(root, { recursive: true, force: true });
  }
}
