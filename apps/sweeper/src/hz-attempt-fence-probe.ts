/** Controller compatibility for workers predating the typed fence RPC. The
 * fixed read-only program has no arguments or secrets and accepts no query.
 * It returns only the registered worker IDs and its current transfer flag. */
export const LEGACY_HZ_FENCE_PROBE = Symbol("hzWorkerTransferFence");
export const hzFenceProgram = `
import { createClient } from "/app/packages/db/src/client.ts";
import { HistoryMessages } from "/app/packages/core/src/point-history-protocol.ts";
const wire = new HistoryMessages(process.stdin, process.stdout);
const request = await wire.read(10000);
const c = createClient({max:1,connection:{application_name:"hz_history_fence_read",default_transaction_read_only:"on",statement_timeout:"3s",lock_timeout:"500ms"}});
try {
  if (request.operation !== "transfer_fence" || process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver")
    throw Error();
  const [worker] = await c.sql.unsafe("SELECT cfg.instance_id::text AS instance,solver.id::text AS solver,cfg.remote_solver_transfer_paused AS paused FROM sync_api_settings cfg JOIN registered_remote_solvers solver ON solver.id=cfg.remote_solver_registered_id AND solver.instance_id=cfg.instance_id::text AND solver.revoked_at IS NULL WHERE cfg.id=1 AND cfg.remote_solver_enabled AND cfg.upstream_base_url IS NOT NULL");
  await wire.send({id:request.id,result:worker ?? null});
} catch (error) {
  const retryable=["55P03","40001","40P01","08003","08006","57P01","57P02","57P03"].includes(error?.code);
  await wire.send({id:request.id,error:{operation:"worker_fence_probe",category:retryable?"transport":"integrity",retryable}});
} finally {wire.close();await c.sql.end({timeout:1});}
`;
