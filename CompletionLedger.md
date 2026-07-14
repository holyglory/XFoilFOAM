# Completion Ledger

- **Campaign capacity and media finalization:** Deploy the control-plane change
  that stops forwarding logical campaign backlog as engine pressure, makes the
  former hidden two-job cap automatically follow the worker CPU-token budget,
  terminalizes completed solver jobs after immutable evidence staging, and
  isolates costly default-media work in the bounded `media-repair`
  control-plane service. Verify on the VPS that the stuck completed job becomes
  terminal, scheduler ticks keep completing while the repair worker renders,
  automatic admission fills available worker tokens with independently
  scheduled polar jobs, and no missing URANS video is published as an accepted
  polar point.

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
