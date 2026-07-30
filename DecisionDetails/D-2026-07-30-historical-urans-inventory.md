# D-2026-07-30 — Complete historical URANS inventory before remediation

## Decision

Use a read-only, keyset-paginated inventory of every `result_attempts` row
that explicitly declares `urans_precalc` or `urans_full`.  Report its exact
execution state, archive state, provenance compatibility, and a non-mutating
next-step label.  Only `done` + `solved` attempts can recommend the existing
automatic archive-reduction or FAST recovery workflows.  Failed, queued,
running, stale, local, malformed, and archive-free attempts remain visible but
cannot be silently promoted, retried, or omitted.

## Why

The existing executable scans intentionally inner-join a current authenticated
GCS archive, which is correct for admission but incomplete as an audit.  It
would hide archived failed/queued generations and attempts without a current
archive, making a migration report falsely appear complete.  Reusing the
writer paths for discovery would also risk durable queue admission before the
complete scope is understood.  A separate side-effect-free planner preserves
all evidence, supports an informed repair decision, and keeps fresh solving
strictly exact and bounded.
