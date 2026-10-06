import type { DB, Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import {
  progressiveEvidenceWakeSql,
  type ProgressiveEvidenceWakeScope,
} from "./progressive-evidence-wake";
import { runNotificationDrain } from "./notification-drain";
import { deliverNextProgressiveWorkerEvidence } from "./progressive-worker-evidence-delivery";
import { stageNextProgressiveWorkerEvidence } from "./progressive-worker-evidence";
import { runSweeperServices } from "./service-lifecycle";

const MAX_SEQUENTIAL_EVIDENCE_DELIVERIES = 8;
const SERVICE_MAX_SEQUENTIAL_EVIDENCE_DELIVERIES = 32;
const DEFAULT_PARALLEL_EVIDENCE_LANES = 4;
const MAX_PARALLEL_EVIDENCE_LANES = 32;

function configuredEvidenceLanes(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number(env[name] ?? DEFAULT_PARALLEL_EVIDENCE_LANES);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PARALLEL_EVIDENCE_LANES
  )
    throw new Error(
      `${name} must be an integer from 1 through ${MAX_PARALLEL_EVIDENCE_LANES}`,
    );
  return value;
}

export async function drainProgressiveWorkerEvidencePass(
  deliver: (preferActive: boolean) => Promise<boolean>,
  preferActive: boolean,
  maximum = MAX_SEQUENTIAL_EVIDENCE_DELIVERIES,
  signal?: AbortSignal,
): Promise<boolean> {
  let changed = false;
  for (let pass = 0; pass < maximum; pass += 1) {
    if (signal?.aborted) break;
    const delivered = await deliver(preferActive);
    changed ||= delivered;
    if (!delivered) break;
  }
  return changed;
}

export async function nextProgressiveEvidenceWakeAt(
  db: DB,
  scope: ProgressiveEvidenceWakeScope | "all" = "all",
): Promise<Date | null> {
  const scopes: ProgressiveEvidenceWakeScope[] =
    scope === "all" ? ["staging", "delivery"] : [scope];
  for (const selected of scopes) {
    const [ready] = await db.execute(
      progressiveEvidenceWakeSql(selected, true),
    );
    if (ready?.wake_at != null)
      return ready.wake_at instanceof Date
        ? ready.wake_at
        : new Date(String(ready.wake_at));
  }
  const deadlines: Date[] = [];
  for (const selected of scopes) {
    const [pending] = await db.execute(
      progressiveEvidenceWakeSql(selected, false),
    );
    if (pending?.wake_at != null)
      deadlines.push(
        pending.wake_at instanceof Date
          ? pending.wake_at
          : new Date(String(pending.wake_at)),
      );
  }
  return deadlines.length
    ? new Date(Math.min(...deadlines.map((deadline) => deadline.getTime())))
    : null;
}

export async function runProgressiveEvidenceService(
  db: DB,
  notifications: Pick<Sql, "listen">,
  engine: EngineClient,
  signal: AbortSignal,
  options: {
    stage?: (preferActive: boolean) => Promise<boolean>;
    deliver?: (preferActive: boolean) => Promise<boolean>;
    nextWakeAt?: (scope: "staging" | "delivery") => Promise<Date | null>;
    reportError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const stagingLanes = configuredEvidenceLanes("REMOTE_EVIDENCE_STAGE_LANES");
  const deliveryLanes = configuredEvidenceLanes(
    "REMOTE_EVIDENCE_DELIVERY_LANES",
  );
  const stage =
    options.stage ??
    ((preferActive: boolean) =>
      stageNextProgressiveWorkerEvidence(db, engine, { preferActive }));
  const deliver =
    options.deliver ??
    ((preferActive: boolean) =>
      deliverNextProgressiveWorkerEvidence(db, fetch, { preferActive }));
  const pendingWakes = new Map<
    ProgressiveEvidenceWakeScope,
    Promise<Date | null>
  >();
  const nextWakeAt = (scope: ProgressiveEvidenceWakeScope) => {
    const existing = pendingWakes.get(scope);
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(() =>
        options.nextWakeAt
          ? options.nextWakeAt(scope)
          : nextProgressiveEvidenceWakeAt(db, scope),
      )
      .finally(() => {
        if (pendingWakes.get(scope) === pending) pendingWakes.delete(scope);
      });
    pendingWakes.set(scope, pending);
    return pending;
  };
  const service = (scope: "staging" | "delivery", lane: number) => ({
    name: `progressive-evidence-${scope}-${lane}`,
    run: async (childSignal: AbortSignal) => {
      let preferActive = lane % 2 === 0;
      await runNotificationDrain(
        notifications,
        "progressive_worker_evidence_changed",
        childSignal,
        {
          drain: async () => {
            const preference = preferActive;
            preferActive = !preferActive;
            return scope === "staging"
              ? stage(preference)
              : drainProgressiveWorkerEvidencePass(
                  deliver,
                  true,
                  SERVICE_MAX_SEQUENTIAL_EVIDENCE_DELIVERIES,
                  childSignal,
                );
          },
          nextWakeAt: () => nextWakeAt(scope),
          reportError:
            options.reportError ??
            ((error) =>
              console.error(
                `[sweeper] progressive evidence ${scope} failed:`,
                error instanceof Error ? error.message : String(error),
              )),
        },
      );
    },
  });
  await runSweeperServices(signal, [
    ...Array.from({ length: stagingLanes }, (_, lane) =>
      service("staging", lane),
    ),
    ...Array.from({ length: deliveryLanes }, (_, lane) =>
      service("delivery", lane),
    ),
  ]);
}
