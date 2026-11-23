import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
import { HistorySshEndpoint } from "./hz-point-history-relay";
import { LEGACY_HZ_FENCE_PROBE } from "./hz-attempt-fence-probe";
import {
  requireActiveHzTransfer,
  type HzWorkerOwner,
} from "./hz-attempt-transfer-fence";

export async function checkLegacyHzFence(
  host: string,
  container: string,
  owner: HzWorkerOwner,
) {
  const probe = new HistorySshEndpoint(host, container, LEGACY_HZ_FENCE_PROBE);
  try {
    const state = await probe.ask({ operation: "transfer_fence" }, 15000);
    if (
      !state ||
      state.instance !== owner.instance ||
      state.solver !== owner.solver
    )
      throw new HistoryOperationError("worker_registration", "denied");
    requireActiveHzTransfer(state.paused);
  } finally {
    await probe.close();
  }
}
