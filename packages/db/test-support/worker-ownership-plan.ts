type PlanNode = Record<string, unknown>;
type Step = { node: PlanNode; branch: number };

const children = (node: PlanNode) => (node.Plans ?? []) as PlanNode[];
const relation = (node: PlanNode, name: string) => node["Relation Name"] === name;

// EXPLAIN quotes generated subquery aliases such as "*SELECT* 1_2" in
// expressions, but returns their unquoted names in its Alias field.
function sqlAlias(node: PlanNode) {
  if (typeof node.Alias !== "string") return undefined;
  return /^[a-z_][a-z0-9_$]*$/.test(node.Alias) ? node.Alias : '"' + node.Alias.replaceAll('"', '""') + '"';
}

function terms(condition: unknown) {
  if (typeof condition !== "string" || !condition.startsWith("((") || !condition.endsWith("))")) return [];
  return condition.slice(2, -2).split(") AND (");
}

function equality(conditions: string[], left: string, right: string) {
  return conditions.includes(`${left} = ${right}`) || conditions.includes(`${right} = ${left}`);
}

function scans(root: PlanNode) {
  const nodes = [root];
  for (const node of nodes) nodes.push(...children(node));
  return nodes.filter(node => node["Relation Name"]);
}

function keyedBy(node: PlanNode, outer: string) {
  const alias = sqlAlias(node);
  const conditions = terms(node["Index Cond"] ?? node["Recheck Cond"] ?? node.Filter);
  return !!alias && ["sim_job_id", "sequence"].every(key => equality(conditions, `${alias}.${key}`, `${outer}.${key}`));
}

function unexecutedClosedCopyOwner(node: PlanNode, path: Step[]) {
  const alias = sqlAlias(node);
  if (!alias || !/^j(?:_\d+)?$/.test(alias) || node.Schema !== "public" ||
      node["Actual Loops"] !== 0 || node["Actual Rows"] !== 0 || node["Rows Removed by Filter"] !== 0 ||
      !Array.isArray(node.Output) || node.Output.length !== 1 || node.Output[0] !== alias + ".id") return false;

  const conditions = terms(node.Filter);
  if (!conditions.includes(`${alias}."ingestedAt" IS NOT NULL`) ||
      !conditions.includes(`${alias}.status = ANY ('{done,failed,cancelled}'::sim_job_status[])`) ||
      !equality(conditions, alias + ".engine_job_id", `(${alias}.id)::text`)) return false;

  // The receipt and the protected 0217 view must both probe the same key
  // supplied by an actual outer scan. The job must be inside the view arm.
  const arm = path.map(({ node: parent }) =>
    parent["Node Type"] === "Append" && /^SubPlan \d+$/.test(String(parent["Subplan Name"]))).lastIndexOf(true);
  if (arm < 0) return false;
  const { node: append, branch } = path[arm];
  const arms = children(append);
  if (arms.length !== 2) return false;
  const receipts = scans(arms[1 - branch]);
  const covered = scans(arms[branch]);
  if (receipts.length !== 1 || !relation(receipts[0], "progressive_worker_evidence_receipts")) return false;
  const proofTables = ["progressive_worker_staging_copies", "progressive_worker_reports",
    "progressive_worker_evidence_receipts", "sim_jobs", "sync_sweep_promises", "sync_api_settings"];
  if (covered.length !== proofTables.length ||
      !proofTables.every(name => covered.some(scan => scan.Schema === "public" && relation(scan, name)))) return false;
  const marker = covered.find(scan => relation(scan, "progressive_worker_staging_copies"))!;
  return path.slice(0, arm).some(({ node: ancestor }) => {
    const outer = sqlAlias(ancestor);
    return !!outer && keyedBy(receipts[0], outer) && keyedBy(marker, outer) &&
      (conditions.length === 3 || (conditions.length === 4 && equality(conditions, alias + ".id", outer + ".sim_job_id")));
  });
}

export function unexpectedWorkerJobScans(root: PlanNode, hasClosedCopyProof: boolean) {
  const failures: Record<string, unknown>[] = [];
  function visit(node: PlanNode, path: Step[]) {
    if (node["Node Type"] === "Seq Scan" && relation(node, "sim_jobs") &&
        !(hasClosedCopyProof && unexecutedClosedCopyOwner(node, path))) {
      failures.push({
        relation: `${String(node.Schema)}.${String(node["Relation Name"])}`, alias: node.Alias,
        loops: node["Actual Loops"], rows: node["Actual Rows"], filtered: node["Rows Removed by Filter"],
        filter: node.Filter, output: node.Output,
        ancestors: path.map(({ node: p, branch }) => ({
          type: p["Node Type"], subplan: p["Subplan Name"], alias: p.Alias, relation: p["Relation Name"], branch,
        })),
      });
    }
    children(node).forEach((child, branch) => visit(child, [...path, { node, branch }]));
  }
  visit(root, []);
  return failures;
}
