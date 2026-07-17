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
  capability data fails closed. The current recovery controller requires the
  version-2 contract; a known version 0 or 1 leaves continuation and corrective
  final recovery pending while ordinary RANS and first-pass preliminary URANS
  remain eligible. The OpenCFD 2606 cutover and exact successor-evidence
  certification are complete. The successor campaign is currently ingesting
  one deliberately admitted RANS batch while durable general admission remains
  closed; deploy the matching version-2 engine before opening that admission.
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
  grouped for remediation. The local full-tier controller now applies strict
  stationarity while the exact saved case can still extend and refine; deploy
  that controller, recover accepted preliminary/final results, and monitor
  subsequent URANS work for recurrence before removing this item.

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
  whose SHA-256 matches the tested production backup. The OpenCFD 2606 engine
  now runs with that remote-only contract. At the 2026-07-17 reconciliation,
  546 legacy evidence directories had complete three-pass migration receipts,
  588 current GCS archive objects were registered in Postgres, and 605 local
  remote pointers existed. The remaining corpus still contained 3,029 legacy
  gzip files (147,646,075,989 bytes) plus 190,833,139,011 bytes of packaged raw
  evidence, so migration and local reclamation are not complete. Canary jobs
  intentionally have no canonical result-attempt/database associations, so
  their per-artifact disposition remains
  `remote-copy-plus-local-archive-pending-database-ack`.
  The local 0073 implementation now preserves a terminal campaign-job archive
  with zero exact result owners as an immutable, admin-downloadable orphan
  quarantine without creating coefficients or binding by AoA; deploy the
  migration/backfill and exercise it against the audited orphan before any
  corresponding local source is removed.
  Add and verify a distinct attestation-backed cleanup for canary-only local
  archives after certification; do not invent a database acknowledgement or
  register canary evidence as campaign data.

- **OpenFOAM Foundation 14 production activation:** The additive identity,
  adapter, isolated worker/pool, control-plane selection, compatibility split,
  guarded deployment path, and real amd64 serial plus two-rank MPI RANS
  canaries are complete. Keep OpenCFD 2606 as the scheduling default and the
  Foundation pool disabled until a real Foundation 14 URANS canary verifies
  transient force parsing, integer-period evidence, stored media, and partial
  publication/recovery end to end. The arm64 package URL and checksum are
  pinned but that architecture has not been built or executed; validate it
  before deploying the Foundation worker to an arm64 host.

- **Production evidence capacity:** The owner expanded the VPS disk from 300 to
  500 GiB. The latest 2026-07-17 production measurement is 492 GiB usable,
  about 385 GiB used, and 103 GiB free (79% used); the
  `/var/lib/docker/volumes/app_results` volume accounts for about 357 GiB.
  One exact 78-case successor RANS batch is active and publishing partial
  evidence; durable general admission remains disabled. The VPS cannot safely
  retain the immutable artifacts for the complete 631,000-point campaign.
  Complete the verified GCS migration before opening sustained campaign
  admission, then remeasure active-case growth and the local hydration reserve.

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
