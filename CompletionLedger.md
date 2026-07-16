# Completion Ledger

- **GCS Zstandard evidence migration:** Implement and deploy content-addressed
  tar.zst finalization, verified GCS upload, temporary render hydration,
  canonical archive metadata, and legacy gzip conversion. Migrate every
  terminal production result, prove stored renders and downloads without local
  VTK, remove local raw/archive duplicates only after per-object verification,
  and report the final object count, conserved evidence count, and reclaimed
  bytes. The bucket exists and its 30-day soft-delete guard is enabled; no
  production evidence has yet been migrated or deleted.

- **OpenCFD 2606 production campaign cutover:** The repository implementation,
  digest-pinned worker, isolated serial/MPI/forced-URANS canary, exact
  campaign-successor migration, fail-closed deployment workflow, and isolated
  2406 rollback reconstruction are complete. This change has not mutated the
  production solver or campaign. An authorized operator must run the guarded
  VPS cutover, verify that the live 2406 process/container is drained and
  removed, and retain the marker until every affected campaign's exact eligible
  source snapshot is represented by its linked 2606 generation and the durable
  continuation proof reaches `evidence` or truthful `not_required`.

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
  500 GiB. After terminal-job retention, active solver work currently leaves
  about 236 GiB free, approximately equal to the measured admission reserve.
  This is enough for guarded execution but still cannot retain the immutable
  artifacts for the complete 631,000-point campaign. Measure growth during the
  resumed run and expand again or move evidence to a compatible object store
  before the admission guard reaches its reserve.

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
