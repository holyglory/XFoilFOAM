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

# Version 1 is the first engine/control-plane contract that supports durable
# cross-job URANS recovery: immutable evidence archives can hydrate a saved
# case after local retention, continuations use the adaptive extension budget,
# and requests are rejected before CFD when controller and worker disagree.
# Keep this separate from mesh recovery: the legacy OpenCFD 2406 engine already
# advertises mesh strategy v1, but must not receive newly reopened URANS
# recovery work during a rolling deployment.
URANS_RECOVERY_VERSION = 1
