# Completion Ledger

- **A18 low-angle alternate-branch correction:** The control-plane classifier,
  cache reset, affected-cell preliminary-URANS requests, and campaign-evidence
  public-anchor fix must be deployed and verified together. The engine-side
  zero-anchored RANS marcher remains inactive until the production worker is
  genuinely idle; its guarded rebuild must not interrupt the active campaign.
  Once the guard permits it, rebuild through `scripts/deploy/rebuild-engine.sh`,
  then verify that the five exact A18 requests progress through preliminary
  URANS and that the public Detail route shows real campaign evidence while
  excluding the rejected alternate branch.
