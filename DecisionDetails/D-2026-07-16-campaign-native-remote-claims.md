# D-2026-07-16-campaign-native-remote-claims

## Trigger and verified production shape

The bounded `hz-solver2` public canary resumed real CFD after the terminal
handoff repair, but it contains only five airfoils and uses a library revision
distinct from the active campaign's pinned revision. Compatible public polar
evidence from that canary is useful, but it does not terminal-link the
campaign's exact `sim_campaign_points` obligations.

Changing the canary to `target_scope='all'` was considered. Production had
1,619 active catalog airfoils and about 42,000 gaps for that library revision,
but the active campaign had almost the same physical condition under another
immutable revision. The all-scope switch would therefore spend substantial
compute without advancing campaign completion. It was rejected as the
permanent integration.

The active campaign instead had 24,147 untouched physical polar groups,
covering 627,822 claimable non-derived cells. This is enough authoritative work
to keep the dedicated solver occupied without manufacturing a duplicate queue.

## Contract

- Campaign candidates come from requested, non-derived points of active
  campaigns and active/kept conditions. They use the exact pinned campaign
  revision, not an enabled preset's latest revision.
- A remote campaign promise is eligible only when the complete physical polar
  group is claimable and fits within the configured claim limit. Partial or
  truncated groups remain local. Consequently the promise angle set is also
  the exact continuous-polar promotion scope used by a low-angle hard RANS
  failure.
- Campaign and public candidates share the production total order: explicit
  public priority 10, campaign priority 0–9, then background public priority 0;
  Reynolds, airfoil slug, and angle provide deterministic ties. Duplicate
  physical cells are removed before limiting.
- Claim selection, campaign lifecycle locking, predicate recheck, and promise
  point insertion are one transaction. Pause/cancel may finish before the
  lease or wait for the complete lease; it cannot race a half-created claim.
- Exact accepted or terminal remote evidence is imported before campaign state
  changes. Campaign points store both result and selected attempt identity,
  progress is recomputed, refinement runs only after the polar cache refresh,
  and replay remains idempotent. Released points are never resurrected.
- Remote terminal evidence remains non-accepted. A terminal preliminary shape
  must close the hub's automatic-ladder accounting truthfully rather than
  leaving a permanent `precalc_open` obligation or marking rejected URANS as a
  valid polar point.

## Alternatives and reversibility

Keeping only the five canary targets was safe but finite and did not meet the
continuous production-work requirement. Widening the public clone to the whole
catalog was mechanically reversible but duplicated campaign work and allowed
the hub's local public branch to consume the same backlog. Leasing partial
campaign gaps was rejected because claim-size truncation would silently narrow
whole-polar promotion semantics. Multi-condition remote promises could recover
the local campaign's cross-speed mesh reuse, but require a broader protocol;
single-condition full-polar promises are correct and independently reversible.

No schema migration is required. Disabling the campaign candidate branch
returns claims to the existing public fallback; already-issued leases are
allowed to settle so their evidence is retained.

## Rollout evidence

The hub node control plane and remote sweeper/worker identities must be checked
before and after deployment. Readiness requires a live promise whose provenance
is `campaign`, whose revision equals the campaign condition revision, whose
angle set equals the full non-derived requested polar, and whose returned exact
result/attempt terminal-links the corresponding campaign point. The hub's
OpenFOAM `api` and `worker` containers must remain untouched.
