# Completion Ledger

- **Campaign instrument overview rollout:** The selected campaign-detail
  instrument cluster is implemented and locally verified. Commit, push, normal
  control-plane deployment, and a production route check remain before this UI
  change is ready.

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
