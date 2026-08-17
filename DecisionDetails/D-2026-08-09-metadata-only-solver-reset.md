# D-2026-08-09 — Metadata-only solver reset

## Confirmed direction

Production must spend capacity on physical calculation, not historical archive
audit, restoration, or result-specific recovery workflows. Legacy validity is
decided from database provenance only. No GCS object is opened or
scientifically reinterpreted to decide whether it survives.

The reset preserves airfoils, imported coordinates, reusable physical and
numerical setup records, immutable preset revisions, campaign definitions, and
operational canaries. It deletes every old aerodynamic solver generation from
the database and GCS—including previously accepted canonical generations—clears
their derived projections, and returns every current physical cell to the
ordinary unsolved state.

## Options considered

- Historical archive audit/reduction was rejected because it adds operational
  state and spends time on evidence that can be recomputed.
- Clearing the whole database was rejected because it would destroy valid
  catalog, geometry, configuration, and campaign intent unrelated to result
  quality.
- A complete solver-domain reset is the bounded option: it is deterministic,
  does not inspect archive contents, and preserves only the inputs and
  operational canaries required for fresh calculation.

## Operational contract

1. Create and strongly test-restore a production database backup immediately
   before the destructive transaction.
2. Materialize the exact set of all old aerodynamic solver generations. No
   archive-content audit or scientific reinterpretation participates.
3. Delete those exact GCS generations and verify their absence.
4. Delete the complete old aerodynamic solver-domain graph and reset every
   current physical cell and campaign point without inventing coefficients.
5. Disable historical audit and archive-specific physical-recovery admission.
   Keep normal current-result GCS publication.
6. Re-enable configured admission and verify real OpenFOAM processes, progress,
   storage headroom, fresh evidence upload, and canonical publication on both
   solver pools.

## Verification

Regression coverage must prove the reset clears accepted and legacy aerodynamic
generations while retaining catalog/setup/campaign definitions and operational
canaries, prove audit/recovery lanes do not run, and prove the ordinary RANS →
FAST URANS → FULL URANS journey remains schedulable. Production evidence must
include the exact database/GCS deletion counts, unchanged protected-data
counts, configured versus live solver capacity, and a non-decreasing HZ storage
safety margin.

## Production evidence

- GCS deletion manifest: 17,532 exact old aerodynamic generations,
  874,445,675,730 bytes, zero deletion errors; the idempotent verification pass
  found all 17,532 absent.
- Hub transaction: 857 old jobs deleted; final solver-domain assertions passed;
  631,410 current points returned to `requested`; 632,190 released
  campaign-history points retained; campaign progress rebuilt to 631,410
  requested; one operational canary attestation retained; committed with exit
  status zero.
- Remote reset, 8/40 refill, storage burn-in, and fresh canonical-publication
  evidence remain pending and must not be reported complete.
