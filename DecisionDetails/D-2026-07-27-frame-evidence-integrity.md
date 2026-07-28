# D-2026-07-27-frame-evidence-integrity — Exact frame evidence and honest ratio charts

## Decision

Keep every stored force-coefficient frame immutable. Display instantaneous
Cl/Cd as the exact stored frame Cl divided by the exact stored frame Cd; do not
smooth, delete, interpolate, or rewrite samples. Give the instantaneous ratio
chart a minimum five-percent relative display span so a sub-percent algebraic
ripple remains visible without occupying the full plot height. Label the trace
as exact-frame Cl/Cd.

Extend polar classification to inspect real `frame_track.frames` whenever the
track exists. A non-finite coefficient sample, non-positive frame Cd, or frame
Cl/Cm beyond the established physical magnitude bound rejects that result from
the accepted polar while retaining the immutable result and attempt evidence.
Recompute only exact affected cells through the ordinary preliminary-URANS
workflow.

## Why

The selected AG 455CT02R evidence archive and database track agree at every
inspected frame. Frames 15–17 move only about 0.25% in instantaneous Cl/Cd; an
extrema-only y-axis magnified that small real ratio movement into an apparent
discontinuity. Smoothing or rewriting the curve would falsely alter evidence,
while a zero-based chart would hide useful unsteady variation. A bounded
display domain changes only presentation and preserves every sample.

A production-wide audit of 2,300 tracks and 210,797 frames found zero missing
numeric samples and zero non-monotonic frame times. It also found two genuine
non-positive-drag samples, both in AH 94-W-301 results whose positive averaged
Cd let them pass the former mean-only classifier. Re-solving all stored tracks
would waste validated CFD work; ignoring frame samples would continue
publishing internally non-physical evidence. Frame-aware rejection plus
targeted recomputation preserves provenance, prevents false polar acceptance,
and limits solver work to the two proven defects.
