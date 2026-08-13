# D-2026-08-13 — Certified no-shedding URANS classification

## Evidence

The live campaign contained 116 rejected URANS attempts across 111 distinct
physical cells whose verbatim engine payloads carried
`no_shedding_certificate.certified=true`. Current v11 examples were solved,
converged, physically non-shedding FAST-URANS observations, but the pointwise
classifier still added `missing-urans-video` and
`missing-clean-cycle-certificate`. Those artifacts describe periodic
shedding, so their absence was expected rather than missing evidence.

The mismatch appeared after numerical provenance was correctly separated from
the physical wake verdict: a no-shedding run remains `regime=urans` because
URANS produced it, while `unsteady=false` truthfully describes the observed
wake. The classifier had only the first half of that change.

## Decision

Move the strict no-shedding certificate parser into dependency-free core and
reuse it from the engine client, ingest pre-classifier, and persisted polar
read model. A URANS point bypasses periodic force-history, video, frame-track,
incomplete-integration, and clean-cycle gates only when:

- the shared exact parser accepts the complete certificate;
- the point remains attributable to URANS; and
- `unsteady` is explicitly false.

Coefficient presence, positive drag, physical magnitude, solved status,
solver-error, and convergence gates remain unchanged. A malformed certificate
or one attached to a shedding payload fails closed and cannot waive periodic
evidence. Classifier and fit versions advance to v7 so regenerated caches name
the changed evidence interpretation.

## Rejected alternatives

- Treat the point as RANS. This loses the numerical method and immutable
  attempt provenance.
- Require or synthesize a video/clean cycles. A non-shedding wake has no
  physical period to animate or certify; generated periodic evidence would be
  false.
- Trust only `certified=true`. The full certificate contains the observation
  horizon, sample counts, statistics, amplitude tolerances, and exact version;
  accepting a partial shape would weaken the evidence gate.

## Verification

Pure classifier and ingest-shaped regressions cover the exact current payload,
malformed certificates, and a certificate attached to a shedding point. A
database-backed regression inserts the persisted attempt shape and proves a
cache refresh classifies it accepted without any periodic media row. Production
verification refreshes affected revisions, checks all valid certified attempts
lose the two false reasons, and confirms malformed or genuinely periodic noisy
attempts remain rejected.
