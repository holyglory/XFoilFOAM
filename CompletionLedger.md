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
  preliminary/final URANS execution. The regression-backed no-shedding
  correction is deployed, and the distinct 20-32C/Re≈102k/α14° target has
  produced accepted preliminary and final generations. The final attempt is
  canonical and publishable, its real fast/final deltas correctly settled as a
  non-critical comparison disagreement, 24 default media artifacts are stored,
  and its immutable evidence is a verified 1,660,050,186-byte Zstandard object
  in GCS. The exact closed-world terminal audit returned `completed` with no
  critical incident. The fresh production backup
  `app-postgres-1-aerodb-20260717T225517Z-222f9d0f.dump` is 291,330,004 bytes,
  has SHA-256
  `7e0db9a28283759d4f22322b2772570068ee5a33f68d141317dff34f9a8ac58f`,
  passed a strong scratch restore (83 tables, one sequence, 15 functions), and
  has a matching private off-VPS copy. Durable scheduling remains fenced at
  `enabled=false`, `max_concurrent_jobs=0`, and `cpu_slots=0` with zero
  in-flight jobs while the scheduler-priority, automatic-admission-breaker,
  and per-point UI changes are committed, deployed, and exercised. Do not
  claim the overall rollout complete until those changes pass production
  verification and bounded campaign burn-in.

  The old process-local RANS/PRECALC alternation and bounded finished-parent
  discovery let an already-durable preliminary obligation at rank 53 remain
  behind unrelated RANS and reconstruct the same starvation after restart. A
  regression-backed correction now selects due fast-URANS obligations first
  from their durable ledger. A durable automatic NEW-admission circuit breaker
  also latches capacity to zero for a current-generation critical/exhausted
  preliminary or final hazard while reconciliation, ingestion, retention, and
  accepted jobs continue. Current code also schedules an exact campaign-owned
  handoff from a shared/background parent, checks the circuit breaker at the
  actual local/remote engine-submit boundary, serializes explicit Resume
  against concurrent capacity edits, hides incident provenance from the public
  sweeper DTO, and holds local NEW admission when mesh capability is unknown.
  The additive 0075 migration was applied from 0000 to an isolated fresh
  database seeded with all 1,621 real profiles. Current-code regressions pass:
  database 118/118, API 285/285, web 352/352, and sweeper 605/605, including
  URANS ladder 33/33, admission breaker 9/9, predicate-transition ordering
  5/5, engine capabilities 30/30, the rank-53/background-parent cases, and
  every package typecheck. The exact operator canary uses an explicit
  maintenance lane that is admissible only while the ordinary scheduler is
  disabled with both durable capacity values at zero; it is never inferred
  from payloads and remains behind the same serialized hazard fence. Operator Resume
  clears the latch and restores saved capacity, but pre-admission checks
  immediately re-trip it when the hazard remains; legacy-generation hazards
  are excluded. Commit, deploy, and prove those scheduler changes before
  reopening bounded campaign capacity, then monitor subsequent fast/final work
  for recurrence. Any exhausted fast/final chain must remain a grouped red
  system-owned incident with a remediation version, never a review task or an
  unchanged user retry.
  Production per-point verification also exposed a legacy-read compatibility
  gap: terminal campaign rows without their optional attempt pin ignored the
  canonical current result attempt and painted accepted RANS evidence as a
  preflight critical incident. Keep scheduling fenced until a regression proves
  the canonical fallback without weakening an explicit point pin, deploy the
  correction, and retest the same production cell.
  The same production read exposed 26 immutable generation-1 incidents in the
  live generation-2 alert rail. Preserve them in engineering history, but scope
  the operational campaign alert to exact current-generation owners before
  resuming admission.

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
  500 GiB. The latest 2026-07-18 production measurement is 491.9 GiB usable,
  76% used with 121 GiB free. A one-shot lock-aware
  hydration-cache cleanup removed exactly 27,940,933,608 bytes from 550
  temporary cache entries and left 12,865,912,411 bytes in that cache. It
  deleted no canonical result, immutable solver evidence, GCS object, raw
  unarchived case, database row, or provenance. The 78-case successor RANS batch
  is terminal, the exact α14° fast/final canary passed, and durable general
  admission remains disabled while the new scheduling and recovery gates are
  verified and deployed. The restored margin was sufficient for the bounded
  canary; it does not make the VPS capable of
  retaining immutable artifacts for the complete 631,000-point campaign.
  Continue the verified migration one complete job at a time, preserve at least
  80 GiB free, and remeasure active-case growth before opening sustained
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
