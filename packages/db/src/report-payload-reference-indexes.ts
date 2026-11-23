import type { Sql } from "./client";
import { prepareNonNullIndexes } from "./online-partial-indexes";

/** The RESTRICT triggers on both report tables probe these scalar keys each
 * time the last owner releases a normalized result. Never detoast the result. */
export function prepareReportPayloadReferenceIndexes(sql: Sql) {
  return prepareNonNullIndexes(sql, 223, [
    {
      table: "progressive_worker_reports",
      column: "result_payload_hash",
      name: "progressive_worker_reports_result_payload_hash_idx",
    },
    {
      table: "progressive_remote_reports",
      column: "result_payload_hash",
      name: "progressive_remote_reports_result_payload_hash_idx",
    },
  ]);
}
