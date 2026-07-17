# Completion Ledger

- **Preliminary-URANS reliability recovery:** The active production campaign
  currently has 26 unresolved preliminary-recovery obligations from the legacy
  OpenCFD 2406 path; preserve those histories unchanged and recover successor
  cells fresh on 2606. OpenCFD 2606 recovery version 2 is live and the exact
  20-32C/Re≈102k/α15° canary has produced accepted preliminary and final
  generations; the final result is canonical, publishable, and backed by a
  verified content-addressed GCS Zstandard archive. Its stored fast/final
  deltas correctly settled as a non-critical comparison disagreement. The
  first terminal audit failed closed because its validator still expected the
  preliminary classification to remain accepted after final publication had
  correctly superseded it. Regression-backed terminal validation now binds the
  superseded preliminary, exact accepted final attempt, physical job, canonical
  result pointer/classification, and pinned runtime together. That correction
  is deployed, the exact terminal audit passed, a fresh full production backup
  passed strong scratch-database restore and was copied off-VPS, and the
  guarded engine upgrade now serves
  `prod-20260717-22c0d3f08d63-r7`. A fresh-target audit found that the
  one-shot validator still rejected a legitimate no-shedding URANS generation
  because its physical regime is `rans` even though method and fidelity prove
  preliminary/final URANS execution. Deploy the regression-backed regime
  correction, restore safe active-solve storage margin, and run the distinct
  20-32C/Re≈102k/α14° preliminary-plus-final canary on r7. Durable scheduling
  remains fenced at `enabled=false`, `max_concurrent_jobs=0`, and
  `cpu_slots=0` until those gates pass. Reopen only bounded campaign capacity
  and monitor subsequent fast/final work for recurrence. Any exhausted
  fast/final chain must remain a grouped red system-owned incident with a
  remediation version, never a review task or an unchanged user retry.

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
  549 receipt-covered legacy evidence directories were complete and none was
  left mid-pass. The remaining corpus still contained 3,026 legacy gzip files
  (145,861,216,428 bytes), 16 local Zstandard archives (216,240,757 bytes), and
  60,471 packaged raw files (187,927,660,666 bytes). No terminal raw directory
  lacked a protecting archive or remote pointer, but migration and local
  reclamation are not complete. Canary jobs
  intentionally have no canonical result-attempt/database associations, so
  their per-artifact disposition remains
  `remote-copy-plus-local-archive-pending-database-ack`.
  Migration 0073 now preserves a terminal campaign-job archive with zero exact
  result owners as an immutable, admin-API-downloadable orphan quarantine
  without creating coefficients or binding by AoA. It is deployed and
  test-covered, but the 2026-07-17 read-only production audit found no eligible
  terminal campaign orphan: all 11 zero-owner filesystem archives have no
  `sim_jobs` owner and are canary-only. Do not force a quarantine trial or
  claim a web UI proof; the authenticated list/detail/download API exists,
  while a visible quarantine UI remains unimplemented.
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
  500 GiB. The latest 2026-07-17 production measurement is 491.9 GiB usable,
  about 389 GiB used, and about 99 GiB free (80.0% used); the
  `/var/lib/docker/volumes/app_results` volume accounts for about 357 GiB.
  The 78-case successor RANS batch is terminal and durable general admission
  remains disabled. The active-job admission check currently has only about
  228 MiB of margin below its 80% ceiling; reclaim and remeasure at least one
  full active-solve reserve before the fresh r7 canary. The VPS cannot safely
  retain the immutable artifacts for the complete 631,000-point campaign.
  Continue the verified migration one complete job at a time, preserve at
  least 80 GiB free, and remeasure active-case growth before opening sustained
  campaign admission.

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
