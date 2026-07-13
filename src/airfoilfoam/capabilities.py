"""Monotonic engine capabilities consumed by the durable control plane."""

# Version 1 replaces the folding four-block C-grid with the quality-gated
# segmented topology used to recover older deterministic PRECALC mesh blocks.
# Increment only when a deployed engine can produce a materially newer mesh
# repair for obligations that were terminal under the previous version.
MESH_RECOVERY_VERSION = 1
