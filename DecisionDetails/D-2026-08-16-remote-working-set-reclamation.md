# Remote solver working-set reclamation

## Decision

Treat a dedicated remote solver as a bounded disposable execution cache. Once
the hub has settled a job-level delivery, reclaim the entire inactive engine
job directory instead of retaining a second local evidence archive. If the
mirrored promise is cancelled, transactionally mark every already-terminal job
as superseded so retention cannot strand its working directory; repair older
cancelled-promise rows idempotently.

Keep forecast admission as the first storage control. Destructive cancellation
is a later emergency backstop: it triggers only at the measured critical-use
threshold or below the absolute free-space floor. The earlier 80% cancellation
threshold is superseded because it can be lower than an otherwise safe,
workload-aware admission decision and therefore cancel a job immediately after
the same scheduler admitted it.

An explicitly requested disposable reset may stop both writers and the worker,
clear the dedicated broker and engine job directory, and restart missing work
through the normal controller without preserving solver outputs. Canonical
non-solver configuration and reconnection credentials remain intact.

## Why

On 2026-08-16 hz-solver2 had about 531 GiB free, but the 80% emergency rule
cancelled every newly submitted job at 85% measured use. Meanwhile 363 terminal
remote jobs remained unstripped. The dominant stuck state was a cancelled
mirrored promise with settled per-result deliveries but no job-level terminal
row; cancelled promises were no longer eligible for delivery reconciliation,
while retention required that row. Large eligible directories also timed out
while the generic strip path authenticated and retained local evidence.

Preserving those files was rejected because solver outputs are reproducible,
the hub is authoritative after exact delivery settlement, and local retention
consumed the capacity needed to recompute any missing point. Weakening evidence
acceptance was also rejected: newly published values must still come from real
solver evidence delivered through the existing exact-generation gate.

## Verification

- Cancellation and terminal job settlement commit in one transaction.
- A bounded replay repairs terminal jobs owned by older cancelled promises.
- Active unacknowledged remote work remains protected.
- Terminal acknowledged, superseded, and storage-cancelled jobs use guarded
  whole-directory deletion; local continuable work keeps the existing strip
  semantics.
- Forecast-only blocking never triggers destructive cancellation. Emergency
  cancellation still triggers at the critical percentage or absolute floor.
- Production reset proof covers empty stale job storage, healthy PostgreSQL and
  Redis, 64-slot capacity, renewed promises, real OpenFOAM progress, delivery,
  post-terminal reclamation, and sustained filesystem headroom.
