# D-2026-07-28 — Immutable result interpretations and clean-cycle recovery

## Context

Historical and current URANS trajectories can contain damaged startup or
terminal periods even when later periods are physically repeatable.  The
previous outcome-oriented projection did not preserve a distinct versioned
answer to “which exact raw samples/cycles support these coefficients?”, making
it unsafe to repair old values without either mutating raw evidence or
re-solving every case.  Steady RANS had a related ambiguity: final-window
means could use only a partial coefficient channel or a shorter window.

## Decision

1. Solver attempts, GCS archives, raw coefficient histories, and stored media
   are immutable evidence.  They are never overwritten to apply a newer
   reduction.
2. A reducer writes an append-only interpretation that records its exact
   policy/build identity, raw evidence signature, selected time/iteration
   window, coefficient statistics, and every audited cycle disposition.
3. A canonical result is an append-only selection of one accepted
   interpretation for the still-current exact attempt.  It cannot point to a
   different result or a continuation-required interpretation.
4. FAST URANS accepts exactly the final 3 contiguous clean cycles; FINAL
   accepts exactly the final 5.  Every selected cycle requires at least 20
   raw coefficient observations and 20 real archived field-frame writes.  A
   cycle audit rejects phase gaps, impulsive steps, high-frequency bursts,
   shape/amplitude/phase mismatch, and nonrepeatable means.
5. A bad final cycle requests up to 3 additional physical periods, never more
   than the remaining physical-period allowance. That allowance is measured
   only from an authenticated `transient_start` marker through the latest
   archived coefficient/frame time; retained steady/startup history cannot
   spend it. Once a post-corruption clean suffix starts, subsequent recovery
   earns one period at a time. FAST and FINAL retain limits of 9 and 12
   measured periods; exhaustion remains a critical system-owned incident. The
   exact one-to-three-period instruction is persisted only for an authenticated
   same-case continuation; a missing marker requires a fresh rerun, a legacy
   pending target-less action can adopt it once before scheduling, and routed
   work is immutable. Each period owns its half-open coefficient interval
   (only the final period includes its endpoint), so a shared boundary cannot
   inflate sample floors or bias a mean.
6. A current RANS result must prove its final 200 raw iterations for Cl, Cd,
   and Cm.  Missing, malformed, or mismatching proof is a targeted FAST URANS
   handoff, not a terminal failure or a whole-polar promotion trigger.
7. A current no-shedding URANS result is steady-equivalent only with a typed
   physical-observation certificate: a complete slow-wake horizon, at least
   20 raw and 20 transported samples, finite all-channel source statistics,
   and independent time-weighted Cl/Cd/Cm statistics recomputed from the
   bounded force-history payload. It cannot publish directly from the engine
   summary; it waits for the same verified GCS archive reduction as periodic
   URANS. Missing, shortened, corrupt, or transport-mismatched proof follows
   the bounded FAST recovery path.
8. Historical correction reads a fresh, generation-pinned, fully authenticated
   GCS archive.  If exact restart state is proved, the scheduler continues the
   original case; otherwise it records a durable restart-proof/fresh-rerun
   action.  It never constructs coefficients from a render, downsampled
   browser payload, or partial archive. FULL continuation also proves the
   exact airfoil, revision, boundary condition, AoA, and normalized producing
   solver implementation against both the accepted FAST queue entry and the
   resolved target. An already accepted exact FINAL satisfies an archive action
   under the natural-cell lock rather than creating duplicate physical work.
   One active archive action owns each request or FINAL-verify receipt; a
   replacement archive is terminalized instead of competing for that work.

## Alternatives considered

### Rewrite existing result rows

Rejected. It hides which numerical policy produced a value and destroys the
ability to compare old/new interpretations or reproduce a correction.

### Keep a fixed percentage discard and average the remaining history

Rejected. It can include a late damaged period, discard a valid short clean
tail, or average across a restart/impulse. It has no per-cycle evidence
contract.

### Re-run every historical URANS case

Rejected as the default. It consumes compute and can produce a different
trajectory even when an authenticated archive already contains enough raw
evidence. A fresh run is reserved for absent/unrestartable proof or exhausted
continuation.

### Stitch individually good cycles from different parts of a trajectory

Rejected. It can silently bridge a corrupt interval and produce a mean that no
physical contiguous window supports. Only a terminal contiguous suffix is
publishable.

## Acceptance evidence

- Engine clean-cycle and archive-reduction regression tests prove startup
  exclusion, exact 3/5-cycle selection, half-open period-boundary ownership,
  per-cycle field-frame floors, authenticated transient-progress caps, and
  bounded continuation for a damaged final cycle.
- Engine-client/core/sweeper contracts reject malformed or insufficient
  certificates, selected-cycle semantic contradictions, and non-stationary
  archive reductions; they also bind no-shedding certificate transport means
  and RMS values to its actual force-history payload. Unproven current RANS
  and unproven no-shedding URANS route to targeted FAST URANS.
- Database migration tests prove append-only rows, same-result ownership,
  canonical-selection validation, terminal cap state, and parent fixture
  cleanup through cascades.
- The archive backfill verifies every manifest member against the exact GCS
  generation before it stages a result interpretation or a recovery action;
  recovery exhausted at the physical-period cap creates no further action.
