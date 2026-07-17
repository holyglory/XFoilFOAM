# D-2026-07-17-remote-engine-identity-fence

## Decision

Fence remote solver work at both trust boundaries. Before a claimed immutable
setup is mirrored or submitted, compare its solver family, distribution,
release, numerics revision, and adapter contract with the local engine's
authoritative health response and pass that exact logical identity to engine
submission. Carry engine-authored runtime/build provenance with every remote
result. For a `remoteSolver` promise, the hub requires that provenance and
validates the same five identity fields against the pinned revision before any
result-related write. Preserve generic non-promise sync compatibility.

## Why

During the OpenCFD 2606 cutover, `hz-solver2` still executed OpenCFD 2406 while
its mirrored setup snapshot was labelled 2606. Six points were accepted with
NULL solver implementation, runtime build, and method provenance. A setup
snapshot is a request, not execution evidence; a signature match therefore did
not prove which numerical implementation ran.

One-sided alternatives are insufficient. A remote-only admission check can be
bypassed by stale software or a runtime change, while a hub-only check wastes
compute and leases before rejecting evidence. Inferring runtime from the setup
or rewriting the six attempts would falsify immutable history. The two fences
stop incompatible work early and keep the hub independently authoritative.

Focused mutation evidence showed the old hub returned HTTP 200 and published a
distribution-mismatched point. The regression now rejects distribution,
release, numerics, adapter-contract, and missing-runtime cases before writes,
while an exact match is accepted and retained in the immutable attempt
payload. Remote controller regressions cover the same mismatch dimensions,
missing build acknowledgement, and the exact-match false-positive guard.

## Rollout and recovery

Integrate the guard onto the active OpenCFD 2606 branch, deploy hub and remote
control planes without restarting live solver processes, then upgrade the
remote engine through the guarded maintenance path when idle. Keep the six
2406 attempts and artifacts as quarantined historical evidence, clear them
from canonical/public selection and campaign satisfaction, and reissue their
physical cells under a fresh 2606 promise. A canary is complete only when the
hub stores the matching implementation/runtime provenance and fulfills the
exact promised point.
