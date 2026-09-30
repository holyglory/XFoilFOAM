# Sparse-polar mean screening

This is an offline research harness, not an activated fitting policy or physical
calibration. Run it through the `sparse-mean-study` Coordinator check graph.
`complete` means the measurements ran; `candidate_acceptance` separately records
whether each candidate passes the required controls. No current candidate does.

## Retained inputs

- The original SG6051 fit at Re 204560, Mach 0.08814658492111002, including its
  two incompatible-geometry CFD anchors. This is a counterfactual stress case;
  those anchors are excluded from current public fitting.
- The source-preserving numerical-revision-2 native diagnostic at the same
  physical target. Its result identifiers are diagnostic artifact labels, not
  database result IDs or experimental references.
- All eight profiles from the retained September 19 pilot. Each accepted CFD
  reference is withheld together with its job and evidence lineage before
  reducing the remaining histories or computing any candidate correction.
- Explicitly manufactured camber, slope, early-stall, large coherent offset,
  conflicting fast/precise, and repeated-history-window controls.

Source checksums are fixed in `scripts/materials/screen_sparse_polar_means.py`.
The artifact retains the complete source files, producing API source, replay
checks, candidate curves, per-reference measurements, and acceptance results.
The pilot was previously examined and is not a new blind validation cohort.
Its accepted CFD references are not experimental truth, and their original mesh
compatibility and initialization independence are not newly established here.

## Replay contract

The SG6051 producing API at `383b2fc` included optional null physical/numerical
identity fields in its transport hash. Current transport serialization omits
them. The producing source file is checksum-pinned and its exact serialization
is verified separately from the current request signature.

Estimator signatures, source identities, and metadata must match. JSON integer
and floating representations of the same angle compare numerically. All stored
curve coefficients and interval endpoints reproduce with zero observed
difference; the verifier's absolute numerical tolerance is `1e-12`. Unknown
producer source, altered transport hash, or changed coefficients are refused.

## Candidate definitions

All candidates retain original coefficients and eligibility. Research-only
copies vary effective observation uncertainty in Cl, log(Cd), and Cm coordinates;
they never rewrite stored solver observations.

1. `unchanged`: the existing joint Gaussian residual model.
2. `method_floor`: add the existing method-discrepancy variance to each eligible
   observation's variance.
3. `disagreement_floor`: multiply that added variance by `max(0, score - 1)`.
4. `conservative_floor`: instead use `max(0, score / cutoff - 1)`.
5. `method_conservative_floor`: compute that score separately for fast and
   precise evidence, so suspect fast data do not reduce precise-data influence.

The existing score is the mean squared standardized leave-one-observation-out
residual. Under its declared fixed Gaussian covariance, the standardized vector
has a correlation matrix. Applying the Gaussian quadratic-form bound and its
worst-correlation trace bounds gives:

```text
tail_probability = 0.01
tail_parameter = -log(tail_probability)
cutoff = 1 + 2 * sqrt(tail_parameter) + 2 * tail_parameter
```

This is a conservative *model-conditional* cutoff per coefficient/method, not a
physical or familywise false-alarm guarantee. The covariance/error assumptions
are not certified by using this bound. See [Hsu, Kakade and Zhang (2012)](https://www.cs.columbia.edu/~djhsu/papers/quadratic-ecp.pdf).

Student-t likelihoods remain an alternative, but their inference is not a
drop-in guaranteed-convergent replacement; see [Jylänki, Vanhatalo and Vehtari
(2011)](https://www.jmlr.org/papers/v12/jylanki11a.html).

## Findings and remaining requirement

The constant floor improves the pilot's average errors but suppresses useful
camber, slope, stall, and precise corrections. Starting inflation at one model
variance also suppresses a genuine slope change. Neither is suitable globally.

The conservative method-scoped candidate avoids the two-anchor SG6051 reversal,
preserves the manufactured coherent corrections, and retains a precise
correction despite conflicting fast evidence. However, four related windows at
each of two wrong anchors defeat its observation-level conflict score: the
repeated-window curve still reverses, with lift RMSE approximately 2.479 in that
manufactured case. A successful two-anchor example is therefore insufficient.

The next candidate must evaluate related evidence windows together when testing
conflicts, without collapsing those histories in the final joint fit. It must
catch both shared errors across related windows and disagreements within those
windows, retain source identities, and preserve useful independent and precise
evidence. Full-polar physical validation remains a separate requirement.

The artifact also records a lineage-group diagnostic for every research fit. It
reports window count, alpha span, transformed residual, model-conditional group
score, and whether the group-to-group lift change reverses the prior. This
diagnostic does not change weights or discard a history. In the SG6051
counterfactual it flags a reversal even though each anchor is a separate
lineage; in the repeated-window control it shows the two four-window lineages
as related groups. That distinction is the required input to the next grouped
covariance candidate.
