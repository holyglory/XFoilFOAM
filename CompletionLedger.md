# Completion Ledger

- **Remote disk safety and sustained 40-slot execution:** Disk admission now
  remeasures after every accepted job and immediately before each engine call,
  accounting for the exact candidate's fidelity and case count. The worker is
  currently stopped for the solver-domain reset, so the complete production
  behavior is not yet proven. Remaining work: deploy the guarded retention and
  admission changes, restart the ordinary solver path, prove 40 real progressing
  CFD processes, and verify that completed-job cleanup keeps a positive storage
  margin indefinitely. The DB-backed pre-submit regression remains externally
  blocked by DevCoordinator report `bug-9ef3f1b1324b41db9f15c660849bc85c`.

- **Fresh solver-domain reset and quality rollout:** The user superseded the
  legacy archive-audit and result-specific recovery approach with a flat reset:
  preserve catalog/setup/campaign definitions, delete every old solver result
  and evidence generation, mark current points unsolved, and recompute only
  through the ordinary RANS → FAST URANS → FULL URANS ladder. The exact GCS
  manifest deleted all 17,532 obsolete generations (874,445,675,730 bytes),
  including the two old canonical selections, and an idempotent second pass
  found all 17,532 already absent. The hub DB reset committed: it deleted all
  857 old jobs and the asserted solver-domain graph, returned 631,410 current
  points to `requested`, retained 632,190 released campaign-history points,
  rebuilt progress to 631,410 requested, and retained the one operational
  canary attestation. A missing foreign-key-side index made hub job deletion
  slow; migration 0122, schema metadata, the reset script, and regressions now
  permanently carry that index for the remote and future resets. The obsolete
  “Solver recovery” rail and its dead component are removed from Health and
  campaign detail; focused UI contracts and typecheck pass. Remaining work:
  execute and verify the indexed remote DB reset; deploy the simplified control
  plane without recreating engine services; restore deliberate 8/40 admission;
  prove full CPU use, bounded storage, fresh GCS archival, clean-tail acceptance,
  and canonical publication through the ordinary ladder.
