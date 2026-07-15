# Completion Ledger

- **Production evidence capacity:** The owner expanded the VPS disk from 300 to
  500 GiB and the live filesystem now has about 216 GiB free, which is enough
  to resume safely under the new admission reserve but still cannot retain the
  immutable artifacts for the complete 631,000-point campaign. Measure growth
  during the resumed run and expand again or move evidence to a compatible
  object store before the admission guard reaches its reserve.

- **Production storage admission rollout:** Deploy migration 0063 and the
  control-plane disk gate, verify the live scheduler persists a measured
  `storage blocked` reason at current production usage, and prove PostgreSQL,
  reconciliation and public/admin reads remain healthy without new jobs.

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
