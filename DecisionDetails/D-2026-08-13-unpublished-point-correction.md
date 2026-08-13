# Unpublished point correction

## Decision

Solver › Points owns the operator journey for terminal unpublished CFD output.
The list links directly from campaign-level “not published” counts and shows
the exact stored solver error, classifier reasons, and quality warnings before
offering actions.

Same-case URANS continuation remains a distinct action and is available only
when the exact selected result attempt has authenticated restartable state.
Changing mesh, numerical, sampling, or manual settings instead creates a new,
disabled, airfoil-targeted simulation preset with a single-angle sweep and a
new immutable revision. The original campaign preset, prior attempts, and
publication verdict remain unchanged. The corrected revision and its FAST or
FULL URANS request are linked back to the source result attempt in
`point_correction_runs`.

## Alternatives

- Mutating the campaign preset was rejected because it would silently change
  unrelated points and future campaign work.
- Reusing the generic requeue action was rejected because it cannot truthfully
  represent changed solver inputs.
- Editing a live case was rejected because it breaks immutable evidence and
  the OpenFOAM atomic-dictionary safety rule.

## Verification contract

- The unpublished filter contains terminal failed or rejected points only when
  no active obligation, URANS request, or verification item owns the point.
- Every correction names the source result and current result-attempt ID;
  stale generations are rejected.
- Identical submissions are idempotent and reuse the same corrected revision
  and request.
- The corrected mesh is pinned for both FAST and FULL URANS tiers, the preset
  is disabled and targets only the source airfoil, and the sweep contains only
  the source angle.
- Corrected runs remain visible from the source point and prior evidence is
  never relabelled or overwritten.
