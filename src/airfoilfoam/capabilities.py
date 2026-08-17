"""Monotonic engine capabilities consumed by the durable control plane."""

# Version 2 extends the quality-gated segmented recovery ladder with
# trailing-edge-centred and camber-aware C-grids, followed by a rare-profile
# source-preserving cartesian2DMesh fallback. Real OpenFOAM canaries recover
# thick trailing edges, strongly cambered leading-edge passages, sharp concave
# notches, and extreme-thickness contours that exhaust every version-1
# topology without changing source coordinates or quality thresholds.
# Increment only when a deployed engine can produce a materially newer mesh
# repair for obligations that were terminal under the previous version.
MESH_RECOVERY_VERSION = 2

# Version 2 adds an in-engine numerical recovery pass for pimpleFoam: a
# last-known-good same-case checkpoint is restored before one conservative
# upwind/Co<=1 retry, failed-pass evidence remains immutable, and a retry that
# does not advance the physical trajectory fails closed.  Version 1 was the
# first engine/control-plane contract that supported durable cross-job URANS
# recovery: immutable evidence archives could hydrate a saved case after local
# retention, continuations used the adaptive extension budget, and requests
# were rejected before CFD when controller and worker disagreed.
# Version 9 derives the high-frequency wake bound from the larger of projected
# AoA height and measured section thickness. Thick/cambered sections therefore
# retain a physically plausible thickness-scale limit cycle while the legacy
# chord-only bound remains unchanged for thin/ordinary sections; clean-tail,
# independent-half, discontinuity, and field-density gates remain mandatory.
# Version 8 keeps a known immutable OpenFOAM continuation boundary out of the
# live within-run impulse trigger. Period similarity and final clean-tail
# publication remain strict, so an unsettled restart cannot be accepted; it
# simply avoids arming expensive numerical recovery for provenance we already
# know is a restart seam.
# Version 7 keeps both conservative timestep controls pinned across cadence
# refinement and same-case continuation after the recovery rung is armed.
# Version 6 adds an automatic live numerical-recovery rung when the clean-tail
# gate observes an impulsive Cl/Cd/Cm candidate: pressure/transport tolerances
# tighten, the PIMPLE correction loop deepens, the conservative Courant ceiling
# is restored, and certification restarts after the contaminated prefix.
# Version 5 prevents dense field-output cadence from altering the physical
# timestep: transient dictionaries use ``runTime`` instead of
# ``adjustableRunTime``, so a write boundary cannot inject a one-step
# coefficient impulse. Version 4 kept startup Co<=1 until two repeatable,
# discontinuity-free periods also carried >=20 real field frames per period.
# Version 11 makes the low-amplitude no-shedding certificate admit only a
# bounded, temporally clean absolute-RMS tail; wall-budget-stopped chunks that
# have not exhausted their measured physical clean-cycle allowance remain
# explicitly restartable instead of becoming terminal evidence.
# Keep this separate from mesh recovery: the legacy OpenCFD 2406 engine already
# advertises mesh strategy v1, but must not receive newly reopened URANS
# recovery work during a rolling deployment.
URANS_RECOVERY_VERSION = 12

# Version 1 is the first authenticated, generation-pinned GCS archive
# clean-cycle reducer.  The control plane treats a missing field as legacy
# version zero and will not admit fresh RANS or URANS that it could not later
# interpret from immutable evidence.  Increment only when the reducer's
# durable output contract changes compatibly and needs a new control-plane
# admission fence.
# v4 adds the versioned adaptive clean-tail policy.  Its recovery proof carries
# truthful measured periods and finite FAST 18 / FINAL 27 ceilings; older
# reducers keep the exact v3 static-cap contract.
# v3 aligns archive-backed no-shedding certificates with the current live
# bounded-RMS reducer.  The generation-pinned archive is replayed under the
# same v2 certificate contract rather than allowing live and archived evidence
# to disagree about a physically steady tail.
# v2 distinguishes the typed legacy-provenance outcome from v1, which returned
# a generic 409 for an otherwise readable URANS archive whose immutable
# manifest did not assert ``unsteady=true``.  The version boundary is required
# so durable v1 terminal queue receipts can be reduced again without mutation.
ARCHIVE_REDUCTION_VERSION = 4
