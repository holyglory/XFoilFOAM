type PlanNode = Record<string, unknown>;

function unexecutedClosedCopyOwner(node: PlanNode) {
  // 0217's protected public view joins a terminal job as j. PostgreSQL may
  // choose a seq scan for that nested branch while never entering it.
  const alias = String(node.Alias);
  const filter = `((${alias}."ingestedAt" IS NOT NULL) AND (${alias}.status = ANY ('{done,failed,cancelled}'::sim_job_status[])) AND (${alias}.engine_job_id = (${alias}.id)::text))`;
  // A correlated proof can also carry the candidate report's exact owner ID.
  // Only this extra equality is removed for comparison with the view predicate.
  const viewFilter = typeof node.Filter === "string" ? node.Filter.replace(
    / AND \((j(?:_\d+)?)\.id = (?:progressive_worker_reports|progressive_worker_staging_keys|fixture_staging_keys|report|k)(?:_\d+)?\.sim_job_id\)/,
    (condition, owner) => owner === alias ? "" : condition,
  ) : node.Filter;
  return (
    node.Schema === "public" &&
    /^j(?:_\d+)?$/.test(alias) &&
    Array.isArray(node.Output) &&
    node.Output.length === 1 &&
    node.Output[0] === alias + ".id" &&
    viewFilter === filter &&
    node["Actual Loops"] === 0 &&
    node["Actual Rows"] === 0 &&
    node["Rows Removed by Filter"] === 0
  );
}

/** A failing assertion reports the execution evidence, including never-run
 * scans that are on the wrong relation or have a different purpose. */
export function unexpectedWorkerJobScans(
  nodes: PlanNode[],
  hasClosedCopyProof: boolean,
) {
  return nodes
    .filter(
      (node) =>
        node["Node Type"] === "Seq Scan" &&
        node["Relation Name"] === "sim_jobs" &&
        !(hasClosedCopyProof && unexecutedClosedCopyOwner(node)),
    )
    .map((node) => ({
      relation: `${String(node.Schema)}.${String(node["Relation Name"])}`,
      alias: node.Alias,
      loops: node["Actual Loops"],
      rows: node["Actual Rows"],
      filtered: node["Rows Removed by Filter"],
    }));
}
