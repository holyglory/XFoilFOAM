# D-2026-07-17-remote-rollout-preservation

## Verified baselines

The deployed `hz-solver2` source at
`/opt/airfoils-pro/app/apps/sweeper/src/remote-solver.ts` has SHA-256
`28c309329178a9421d0cdc852e2688a04253d34eb83a6ec7a0d03c781148f5ce`.
That is byte-for-byte the same file stored at branch commit `5d07064`, after
the terminal-evidence, preliminary-retry, and lease-recovery commits
`ef44b62`, `3870c17`, and `5d07064`. The campaign/parallel/identity work extends
that baseline; it must not be integrated by overwriting or reconstructing the
live hotfix from memory.

The feature worktree is intentionally isolated but is based on an older
production line. It is suitable as a reviewed patch source, not as a direct
deployment source. The destination remains the active OpenCFD 2606 branch.

## Delivery prerequisite

Evidence member-set digests cross the Python engine/TypeScript control-plane
boundary. Python orders member paths by Unicode code point; the existing
TypeScript implementation uses locale-sensitive ordering. Uppercase VTK paths
produce different orders and therefore different digests even when the exact
same immutable evidence bytes are present. The TypeScript canonical-order
repair and its cross-language golden vector must land on the integration
branch before remote evidence delivery is enabled.

## Integration and verification

Integrate the remote commits onto the active branch, resolve against the
schema-level engine identity already present there, and include the evidence
digest repair. Preserve generic non-promise sync compatibility. Rerun the full
remote controller and hub validation suites against a freshly migrated
isolated database, plus package typechecks and formatting/diff checks. Deploy
only the Node control plane and remote sweeper under the normal idle-safe
rules; do not recreate OpenFOAM `api` or `worker` as part of this integration.

Live readiness requires a campaign-native promise with the exact pinned
revision, multiple independent marched polar jobs within the configured cap,
matching engine runtime provenance on every upload, and a successful evidence
round trip containing the uppercase-path digest golden case.
