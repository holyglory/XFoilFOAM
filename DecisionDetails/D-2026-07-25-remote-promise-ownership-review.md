# D-2026-07-25-remote-promise-ownership-review

## Decision

A hub-issued remote polar promise is the exclusive scheduling owner of its
airfoil, setup revision, and AoA cells for a 72-hour failover horizon. Claim,
ordinary heartbeat, and evidence-transfer heartbeat renew that same horizon.
The local scheduler and remote claim endpoint take the same per-cell advisory
locks and recheck current results and active promises at the mutation boundary.
Only the mirrored job carrying that exact promise id may claim its leased
cells.

An incoming generation that is byte/provenance-distinct from the current
accepted generation remains an immutable review conflict. An earlier conflict
whose exact promised generation was subsequently accepted is automatically
archived. The admin surface shows compact airfoil/AoA/condition/solver context
and coefficient comparison; raw identities and generation ids are available
only inside an evidence disclosure. Unsupported polar promotion is not
presented as an action.

## Why

The prior design combined a 24-hour hub default with a one-hour transfer
heartbeat and relied on pre-transaction gap scans. A healthy long solve could
therefore lose ownership during transfer, and a local and remote claimant could
both pass their initial scan before either wrote its claim. Keeping the short
lease would optimize quick failover at the cost of duplicate expensive CFD;
making leases permanent would strand cells after a dead remote. A refreshed
72-hour lease is long enough for current polar work while expiry still restores
automatic failover.

Treating every repeated delivery as a manual conflict preserved evidence but
left exact accepted replays in an impossible queue. Automatically discarding
all conflicts would conceal genuinely different solver generations. Exact
accepted-generation reconciliation removes only proven obsolete replays and
keeps all materially different evidence reviewable.

The former raw UUID/JSON-key cards exposed implementation identities without
the aerodynamic context needed for a decision, and their “promote” action was
guaranteed to fail for polar evidence because complete promotable bytes were
not retained. Semantic comparison with progressive technical disclosure keeps
the current canonical result safe while making the rare real conflict
understandable.

## Verification

- Transactional hub-claim regression: active remote lease blocks a competing
  claim, expiry releases it, and a local queued result remains authoritative.
- Local-claim regression: active remote ownership blocks an unrelated local
  job while the exact mirrored promise job remains eligible.
- Lease regressions: claim and every transfer heartbeat send the shared
  72-hour horizon.
- Reconciliation regression: an exact accepted replay is archived while a
  different engine generation remains pending with a semantic review model.
- UI regression: normal content contains no raw natural key or impossible
  polar promotion action; exact ids and coefficient comparison remain
  available in the expandable evidence section.
