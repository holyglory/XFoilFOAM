# Fidelity controls preliminary-URANS provenance

## Trigger

The active standard campaign reported 11 “blocked” points. Production evidence
showed that all eleven had completed automatic preliminary-recovery attempts;
four no-shedding preliminary-URANS attempts were physically steady and stored
as `regime=rans`, while their immutable fidelity was `urans_precalc`. The
classifier treated those four as fresh RANS evidence, returned `needs_urans`,
and left their bounded obligations terminal.

## Options considered

1. Store no-shedding URANS as `regime=urans`.
   This would misrepresent the physical result and invite unavailable transient
   media as if shedding evidence existed.
2. Keep using physical regime for retry heuristics.
   This preserves the misclassification and causes already-completed
   preliminary evidence to consume its bounded recovery path twice.
3. Use fidelity as numerical-tier provenance while retaining physical regime
   for media and physical presentation.
   This distinguishes a steady RANS solve from a URANS-tier solve that reached
   a steady no-shedding outcome.

## Chosen behavior

The polar classifier treats only `regime=rans` evidence without
`urans_precalc`/`urans_full` fidelity as steady-RANS heuristic input. The
preliminary-obligation settlement path accepts an accepted exact result with
`fidelity=urans_precalc` regardless of whether it is physically steady or
unsteady, while retaining the exact attempt-classification and continuation
guards. A scoped polar-cache backfill refreshes classifications and settles
affected obligations without scheduling new CFD work.

Campaign UI uses distinct states: work currently trying a safer mesh is
automatic recovery; a bounded preliminary result with no publishable evidence
is “preliminary unavailable.” Neither is a user review task or a request to
change an internal setup.

## Verification

- Core regression: no-shedding preliminary-URANS evidence never re-enters
  RANS retry heuristics.
- Sweeper/DB regression: an accepted no-shedding preliminary result settles
  the exact blocked obligation.
- Scoped production repair: refresh only the affected airfoil/revision pair,
  then confirm progress counters and obligation states from the live database.
