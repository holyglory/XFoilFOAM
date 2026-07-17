# Completion Ledger

- **Preliminary-URANS reliability recovery:** The active production campaign
  currently has 26 unresolved preliminary-recovery obligations from the legacy
  OpenCFD 2406 path. Five continuation submissions performed zero CFD because
  retention had removed their live restart fields; 21 physical results
  exhausted the former acceptance path.
  Every affected cell still has immutable checkpoint evidence. Their latest
  classifications all report non-stationarity; 12 also lack enough periods and
  seven ended before the required integration window. Complete archive-backed
  continuation hydration, attempt-preserving storage failure handling,
  adaptive same-case settling, and the per-angle
  RANS → preliminary URANS → verified URANS interface. Deploy through the
  guarded engine workflow. The repository now carries an explicit
  `urans_recovery_version` capability contract: recovery requests pin their
  expected version, the API and worker reject mismatches before solve work,
  absent legacy capability is version 0, and malformed or unavailable
  capability data fails closed. Until production has a matching version-1
  engine, continuation and final-recovery obligations must remain pending;
  ordinary RANS screening and first-pass preliminary URANS may continue.
  Explicit admin final requests must remain aggregate owners of the same
  per-point preliminary-plus-verification sequence; they must not create
  direct full-fidelity bypass jobs.
  Deterministic wave-1 RANS mesh failures must retain their immutable attempt,
  reopen only for a strictly newer live `mesh_recovery_version`, return to the
  exact campaign point once, and pin that version on the replacement job. They
  must never trigger aerodynamic whole-polar promotion. Repository version 2
  now recovers all 1,619 eligible closed seed profiles, including real
  OpenFOAM 2606 full-ladder and transient canaries for GOE451 and FX79W660A;
  production still must activate that engine version. If version 2 ever
  exhausts, record one new grouped critical pre-solver incident rather than
  replaying it unchanged.
  Reopen checkpoints only on the exact solver implementation that produced
  them; during the approved OpenCFD 2606 cutover, preserve all 26 affected 2406
  histories unchanged and recompute their successor cells fresh. Prove that
  cross-segment continuation cannot loop without measurable progress, that
  failed final verification retains and automatically refines the accepted
  preliminary generation, and that repeated fast/final incidents are durably
  grouped for remediation. Recover accepted preliminary results and monitor
  subsequent preliminary work for recurrence before removing this item.

- **GCS Zstandard evidence migration:** Implement and deploy content-addressed
  tar.zst finalization, verified GCS upload, temporary render hydration,
  canonical archive metadata, and legacy gzip conversion. Migrate every
  terminal production result, prove stored renders and downloads without local
  VTK, remove local raw/archive duplicates only after per-object verification,
  and report the final object count, conserved evidence count, and reclaimed
  bytes. The bucket exists, its 30-day soft-delete guard is enabled, and the
  production deployment environment is configured for remote-only Zstandard
  evidence with a bounded 50 GiB hydration cache. The verified pre-migration
  PostgreSQL dump and its restore manifest now also have a private off-VPS copy
  whose SHA-256 matches the tested production backup. Those values are not
  active in the unchanged running containers; no production evidence has yet
  been migrated or deleted.

- **OpenCFD 2606 production campaign cutover:** The repository implementation,
  digest-pinned worker, isolated serial/MPI/forced-URANS canary, exact
  campaign-successor migration, fail-closed deployment workflow, and isolated
  2406 rollback reconstruction are complete. Production now runs the guarded
  OpenCFD 2606 engine, but the cutover marker remains pending and both execution
  pools remain disabled after fail-closed recovery attempts. The latest attempt
  proved that GCS upload, all-member restore, and raw-tree removal succeeded,
  but the old canary verifier incorrectly required the complete local archive
  to be removed before its database acknowledgement existed. Repository
  migration 0072 and the control-plane/engine repair now implement a separate
  immutable preliminary registration, authenticated cleanup, four per-point
  database proofs, crash-safe replay, and a final attestation that cannot be
  created from an incomplete or unrelated proof set. Integrate that repair with
  the incident-bound staged deployment runner; verify migration 0072 before
  activation; build and recreate the matching Node API, sweeper, gateway, and
  worker artifacts; then run a fresh canary. Earlier failed direct-canary jobs
  remain terminal, unregistered evidence and must not enter the new proof set.
  Finish the successor-generation gates only after the new final attestation,
  then replace the temporary staged recovery path with the canonical release
  workflow. Keep the marker until every affected campaign's exact eligible
  source snapshot is represented by its linked 2606 generation and the durable
  continuation proof reaches `evidence` or truthful `not_required`.

- **hz-solver2 40-slot OpenCFD 2606 activation:** The role-separated Compose
  profile, strict volume canary, archive-only render proof, restartable guarded
  cutover, verified backup/rollback artifacts, private attestation, and
  hub-acknowledgement retention fence are implemented in the repository. The
  live dedicated server still requires an idle maintenance boundary and an
  authorized run of `scripts/deploy/rebuild-remote-solver-engine.sh` with one
  immutable build ID. Record the live merged 40-CPU profile, scratch-restored
  backup and rollback hashes, three-scenario receipt/attestation hashes,
  OpenCFD 2606 health, resumed sweeper state, new promised work, completed
  evidence delivery, and production-hub acknowledgement before removing this
  item. Do not place hub GCS credentials on the remote solver or use the hub's
  campaign-successor cutover there.

- **OpenFOAM Foundation 14 production activation:** The additive identity,
  adapter, isolated worker/pool, control-plane selection, compatibility split,
  guarded deployment path, and real amd64 serial plus two-rank MPI RANS
  canaries are complete. Keep OpenCFD 2606 as the scheduling default and the
  Foundation pool disabled until a real Foundation 14 URANS canary verifies
  transient force parsing, integer-period evidence, stored media, and partial
  publication/recovery end to end. The arm64 package URL and checksum are
  pinned but that architecture has not been built or executed; validate it
  before deploying the Foundation worker to an arm64 host.

- **Remote feature integration and evidence-delivery gate:** this isolated
  branch is a patch source, not a deployable production head. Its committed
  `remote-solver.ts` baseline is byte-identical to the deployed terminal and
  PRECALC hotfix (SHA-256
  `28c309329178a9421d0cdc852e2688a04253d34eb83a6ec7a0d03c781148f5ce`),
  which must remain intact when the campaign, parallel-admission, and identity
  changes are integrated onto the active OpenCFD 2606 branch. The integration
  must also include the TypeScript/Python evidence-member code-point ordering
  repair and uppercase-path golden vector before remote deliveries are
  enabled. Rerun the complete hub/remote suites on a freshly migrated isolated
  database after integration, including the historical cancelled/expired
  blocked-delivery reconciliation and evidence-retention cases; do not deploy
  this old-base branch directly.

- **Remote solver engine-identity rollout:** the hub-side upload fence and the
  remote claim/submission health fence are implemented and regression-covered
  locally, but still need integration onto the active OpenCFD 2606 production
  branch and coordinated control-plane deployment. After deployment, verify a
  2406 runtime cannot mirror, submit, or publish a 2606 promise; verify a
  matching 2606 runtime persists build provenance and fulfills one canary;
  preserve the contained 2406 attempts as immutable history while re-solving
  their quarantined cells under the promised implementation.

- **Remote solver campaign ownership:** `hz-solver2` is live again through the
  bounded five-airfoil public feed, but that canary revision is not the active
  campaign's immutable revision and therefore cannot settle campaign points.
  Add campaign-native sync claims, terminal-link imported exact evidence through
  the campaign ingest hook, deploy the hub control plane, and verify that the
  next remote promise names the campaign revision before treating continuous
  production solving as complete.

- **Remote solver capacity admission:** the live worker and engine are
  configured for 40 CPU slots, but the remote controller currently admits one
  single-condition marched polar at a time, so the active AG24 job truthfully
  holds only one CPU token. Deploy multi-promise admission, verify multiple
  independent complete polars run concurrently without changing their internal
  AoA march, and confirm the engine token pool and hub lease counts remain
  bounded before treating CPU utilization as complete.

- **Production evidence capacity:** The owner expanded the VPS disk from 300 to
  500 GiB. The latest 2026-07-16 production measurement is 492 GiB usable,
  about 416 GiB used, and 72 GiB free (86% used); the
  `/var/lib/docker/volumes/app_results` volume accounts for about 380 GiB.
  Two steady solves were still active at that measurement. Keep the storage
  safeguard closed to new admission while already-admitted work and ingestion
  drain. The VPS cannot safely retain the immutable artifacts for the complete
  631,000-point campaign. Complete the verified GCS migration before materially
  increasing campaign admission, then remeasure active-case growth and the
  local hydration reserve.

- **A18 low-angle alternate-branch correction:** The control-plane classifier,
  cache reset, affected-cell preliminary-URANS requests, campaign-evidence
  public anchor, and accepted-only chart line gate must be deployed and
  verified together. The engine-side zero-anchored RANS marcher remains
  inactive until the production worker is genuinely idle; its guarded rebuild
  must not interrupt the active campaign. Once the guard permits it, rebuild
  through `scripts/deploy/rebuild-engine.sh`, then verify that the five exact
  A18 requests progress through preliminary URANS and that public Detail shows
  real campaign evidence, retains provisional cells as marked evidence, and
  never joins them into a final polar curve.
