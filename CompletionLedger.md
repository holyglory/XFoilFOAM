# Completion Ledger

- **Three-stage solver rollout and campaign burn-in:** The regression-backed
  RANS screening → fast preliminary URANS → final verified URANS controller,
  exact-generation continuation gate, automatic final scheduling, critical
  incident model, and compact per-point rail are complete locally but are not
  yet the production release. Preserve the immutable 2406 histories. Commit
  and push the current tree, take a fresh strongly verified production backup,
  apply migration 0076, deploy the control plane, and rebuild the 2606 engine
  only through `scripts/deploy/rebuild-engine.sh` after its idle guard passes.
  Then recover the exact 20-32C/Re≈102k/α20° continuation, obtain its accepted
  fast and final generations, resume the active campaign at bounded capacity,
  and monitor subsequent RANS handoffs plus fast/final results. Readiness
  requires no recurring current-generation blocked/critical chain; any new
  exhaustion remains a red system incident and must be investigated before
  ordinary new admission continues.

- **GCS Zstandard evidence migration:** Remote-only Zstandard finalization and
  verified restore are live, but the legacy corpus migration and local
  reclamation are incomplete. Continue one protected terminal job at a time,
  delete local raw/archive duplicates only after exact remote verification,
  and report final object/evidence counts and reclaimed bytes. Add a distinct
  attestation-backed cleanup for canary-only archives that have no canonical
  database owner; never invent an acknowledgement or register canary evidence
  as campaign data.

- **Production evidence capacity:** The 500 GiB VPS currently has about
  113 GiB free (77% used). Preserve at least 80 GiB free while the campaign is
  active, continue bounded hydration-cache cleanup and verified legacy
  migration, and remeasure active-case growth before increasing solver
  concurrency.

- **A18 low-angle alternate-branch correction:** Deploy and verify the
  classifier/cache/request/public-chart correction together with the guarded
  engine update. Confirm the five exact A18 requests produce real preliminary
  evidence and that provisional points remain visibly distinct and never join
  the accepted final polar curve.

- **OpenFOAM Foundation 14 production activation:** Keep OpenCFD 2606 as the
  scheduling default and the Foundation pool disabled until a real Foundation
  14 URANS canary proves transient force parsing, integer-period evidence,
  stored media, and partial publication/recovery end to end. Validate the
  pinned arm64 build before any Foundation worker is deployed on arm64.
