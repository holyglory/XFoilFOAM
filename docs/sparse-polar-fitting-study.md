# Sparse-polar mean screening

This is an offline research harness, not an activated fitting policy or physical
calibration. Run it through the `sparse-mean-study` Coordinator check graph.
`complete` means the measurements ran; `candidate_acceptance` separately records
whether each candidate passes the required controls. Passing manufactured
controls does not establish production readiness or physical accuracy.

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
6. `grouped_reversal_floor`: a retained heuristic comparison using a lift-trend
   rule, an arbitrary variance factor, and a stall exemption. It is not the
   selected covariance implementation.
7. `group_conditional_floor`: hold out whole lineages using the existing
   Gaussian covariance and test angle means separately from window contrasts;
   add resulting error to individual observation standard errors. Stronger
   repeated-window tests rejected this approach because its added error can
   still be averaged away.
8. `group_shared_covariance`: use the same group tests but represent detected
   shared error as a separate covariance block for each lineage and exact angle.
   Keep within-window excess variance independent. This is implemented behind
   the absent-by-default `lineage_conflict_probability` policy field.

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
reports window count, alpha span, transformed residual, an uncalibrated
residual-to-error summary, and whether the group-to-group lift change reverses the prior. This
diagnostic does not change weights or discard a history. In the SG6051
counterfactual it flags a reversal even though each anchor is a separate
lineage; in the repeated-window control it shows the two four-window lineages
as related groups. That distinction is the required input to the next grouped
covariance candidate.

The prespecified independent split was also screened without selecting on its
held-out errors: 12 fit, 20 calibration, and 20 held-out profiles, excluding
the original eight-profile pilot. The grouped reversal candidate produced the
same held-out mean absolute errors as the unchanged estimator (`Cl 0.111102`,
`Cd 0.024698`, `Cm 0.028845` in the retained report). It is therefore a
targeted protection for detected reversal patterns, not a generally better
estimator, and remains offline and unvalidated.

## Shared-covariance implementation

The numerical model uses a separate, covariance-based diagnostic rather than
the descriptive reversal heuristic. For each method, construct the unchanged
declared covariance of all eligible observations, including correlated sampling
noise. Hold out all observations of one lineage together and condition on the
other lineages. Fast and precise diagnostics remain separate.

Project the conditional residual onto its mean at each exact observed angle.
Measure its squared Mahalanobis distance using the projected covariance. The
remaining orthogonal distance measures contrasts between windows. Each
subspace's dimension determines its Gaussian quadratic-form threshold:

```text
per_test_probability = policy_probability / (6 * lineage_group_count)
tail_parameter = -log(per_test_probability)
threshold = dimension + 2 * sqrt(dimension * tail_parameter) + 2 * tail_parameter
```

The factor six covers three coefficients and two subspaces. This bounds the
family of tests only under the fixed Gaussian/error assumptions, not real
aerodynamic errors. When a subspace exceeds its threshold, its excess variance
factor is `max(0, score / dimension - 1)`. Otherwise the factor is zero.

Multiply the mean excess by the declared method-discrepancy variance and add a
block constant across windows sharing the same lineage and angle. Multiply the
contrast excess by the same variance and add it on the diagonal. The final
joint fit still receives every original coefficient and history window. It does
not reduce an entire URANS trajectory to one solver point or rewrite a
convergence/acceptance label. Prospective sampling scores account for the added
uncertainty as well.

This implementation removes the manufactured repeated-window reversal even
with 128 observations or shared cross-angle ancestry. The original fixture's
lift RMSE drops from about 2.479 to 0.00150. Camber, slope, stall and large
coherent-shift controls are unchanged; coherent precise evidence remains
effective against conflicting fast evidence. These controls demonstrate the
specified behavior, not physical accuracy.

On the retained 52-profile comparison, the three groups remain disjoint from
the original pilot in both profile and geometry. The 20-profile held-out
partition from the earlier study now has mean absolute drag error 0.017544
versus 0.024698 unchanged; lift and moment errors remain 0.111102 and 0.028845.
The guard activates on three profiles in that partition. These profiles have
been examined in earlier studies; this is not a new blind validation result.
References are accepted CFD, not experimental measurements.

The fitting endpoint returns model version `progressive-polar-gp-v4` when the
option is requested, with exact lineage membership, subspace statistics and
shared/independent variance diagnostics. The cache validator checks those
diagnostics against the request and contributing source identities. Missing,
altered or unsolicited diagnostics are rejected. Absent or null configuration
preserves older request/model signatures and v2/v3 behavior. The option cannot
claim validated uncertainty, and production request builders do not enable it.

## Repeated verification

Governed runs use `--runs-directory` to create unique immutable child artifacts,
rather than manually incrementing output paths. Previous artifacts are never
overwritten. Each child retains input files, exact implementation source,
replay checks and all candidate results, including failures. Cohort metadata
explicitly says this is a previously examined comparison. Pilot exclusion is
verified from the actual pinned pilot file, not merely reported as a checksum.

## Fresh source-preserving selection

`freeze_fresh_history_selection.py` emits the reviewed
`fresh_history_selection.sql` inside a repeatable-read, read-only transaction.
It does not accept arbitrary SQL templates. Prior profile UUIDs and finite
coordinate geometry are validated before interpolation. Both prior profile and
exact geometry exclusions are applied in SQL, including aliases of the named
diagnosed profiles. Supply all three older partitions, the eight-profile pilot,
the 27-profile transfer export, the SG6051 source model and its diagnosis report;
the protocol states precisely which input files and hashes it includes. The
earlier version-1 profile-only replacement utility did not prove all of these
exclusions and must not be used as validation evidence.

Version 2 requires a current ready fit with a source-geometry verification,
included numerical-revision-2/mesh-version-3 history, and an accepted reference
from a different job and evidence lineage with the same source-preserving
implementation. Iteration histories and physical-time histories form separate
cohorts. It selects by a fixed identity ordering, never by coefficient values or
prediction errors. Each selected row pins the model, prior, target, geometry,
epoch, signatures and eligible source/reference identities for the later export.

An empty selection is retained, not expanded by weakening criteria. Current
ready histories can exist while independent accepted reference pairs are still
missing. Lack of a linked ready model is not evidence that a raw history is
waiting only for the precise stage: the fast stage also supplies informative
histories. The September 30 fitting-priority repair removed a real publication
delay behind prediction-only refreshes; it did not change any statistical
acceptance rule or supply an experimental reference.
