# Completion Ledger

- **Remote feature integration and evidence-delivery gate:** this isolated
  branch is a patch source, not a deployable production head. Its committed
  `remote-solver.ts` baseline is byte-identical to the deployed terminal and
  PRECALC hotfix (SHA-256
  `28c309329178a9421d0cdc852e2688a04253d34eb83a6ec7a0d03c781148f5ce`),
  which must remain intact when the campaign, parallel-admission, and identity
  changes are integrated onto the active OpenCFD 2606 branch. The integration
  must also include the TypeScript/Python evidence-member code-point ordering
  repair and uppercase-path golden vector before remote deliveries are
  enabled. Rerun the complete hub/remote suites on a freshly migrated isolated
  database after integration, including the historical cancelled/expired
  blocked-delivery reconciliation and evidence-retention cases; do not deploy
  this old-base branch directly.

- **Remote solver engine-identity rollout:** the hub-side upload fence and the
  remote claim/submission health fence are implemented and regression-covered
  locally, but still need integration onto the active OpenCFD 2606 production
  branch and coordinated control-plane deployment. After deployment, verify a
  2406 runtime cannot mirror, submit, or publish a 2606 promise; verify a
  matching 2606 runtime persists build provenance and fulfills one canary;
  preserve the contained 2406 attempts as immutable history while re-solving
  their quarantined cells under the promised implementation.

- **Remote solver campaign ownership:** `hz-solver2` is live again through the
  bounded five-airfoil public feed, but that canary revision is not the active
  campaign's immutable revision and therefore cannot settle campaign points.
  Add campaign-native sync claims, terminal-link imported exact evidence through
  the campaign ingest hook, deploy the hub control plane, and verify that the
  next remote promise names the campaign revision before treating continuous
  production solving as complete.

- **Remote solver capacity admission:** the live worker and engine are
  configured for 40 CPU slots, but the remote controller currently admits one
  single-condition marched polar at a time, so the active AG24 job truthfully
  holds only one CPU token. Deploy multi-promise admission, verify multiple
  independent complete polars run concurrently without changing their internal
  AoA march, and confirm the engine token pool and hub lease counts remain
  bounded before treating CPU utilization as complete.

- **Production evidence capacity:** The owner expanded the VPS disk from 300 to
  500 GiB. After terminal-job retention, active solver work currently leaves
  about 236 GiB free, approximately equal to the measured admission reserve.
  This is enough for guarded execution but still cannot retain the immutable
  artifacts for the complete 631,000-point campaign. Measure growth during the
  resumed run and expand again or move evidence to a compatible object store
  before the admission guard reaches its reserve.

- **A18 low-angle alternate-branch correction:** The control-plane classifier,
  cache reset, affected-cell preliminary-URANS requests, campaign-evidence
  public anchor, and accepted-only chart line gate must be deployed and
  verified together. The engine-side zero-anchored RANS marcher remains
  inactive until the production worker is genuinely idle; its guarded rebuild
  must not interrupt the active campaign. Once the guard permits it, rebuild
  through `scripts/deploy/rebuild-engine.sh`, then verify that the five exact
  A18 requests progress through preliminary URANS and that public Detail shows
  real campaign evidence, retains provisional cells as marked evidence, and
  never joins them into a final polar curve.
