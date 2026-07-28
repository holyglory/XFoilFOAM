# D-2026-07-28 — Scheduler-delay truth and bounded campaign polling

## Context

The campaign hub rendered one unfinished scheduler cycle in three places and
described it as an engine problem:

- the global scheduler chip;
- a campaign-level `SLOW` badge; and
- a second explanatory sentence inside the same campaign card.

The underlying signal proves only that the sweeper heartbeat is fresh and
`lastTickStartedAt` has remained newer than `lastTickCompletedAt` for more than
five minutes. A scheduler tick includes database reconciliation, retention,
remote transfer, classification, and admission work as well as engine calls.
It does not identify the slow operation, it does not block the campaign, and it
does not require administrator action.

The same campaign read model repeatedly scanned a 1.26-million-row campaign
point set to discover sparse preliminary-URANS and review exceptions. On the
live campaign, the tier query took 8.39 seconds and the review query 1.46
seconds. Fixed-interval browser polling could start another request while the
previous request was still running and could fan that overlap into concurrent
coverage-matrix refreshes.

Production verification after the first control-plane deploy found two
independent contributors. The restart-triggered retention pass added about one
minute fifty seconds while `sweepSyncImportOrphans` checked large batches of
`solver_evidence_artifacts`, `result_media`, and `remote_asset_references`
storage keys. Subsequent ticks remained slow because cumulative engine result
payloads replayed already-staged points and artifacts. This decision removes
retention from scheduler liveness and eliminates the duplicate canonical
point/attempt evidence tail inside one payload. The same correction now gives
cross-tick cumulative replay its own durable exact-attempt completion proof.

## Decision

Treat an unfinished scheduler cycle as one global advisory named **Scheduler
delayed**. Show it once in the scheduler status surface, state that existing
solves continue while new scheduling waits for the current cycle, and point an
administrator to Solver details only if the delay persists. Keep it out of
campaign gates, campaign lifecycle copy, and campaign progress instruments. Do
not attribute the delay to the engine without an engine-owned signal, and do
not promise automatic recovery because the current loop has no tick watchdog.

Build campaign ladder counts from their sparse owning sources—classifications,
results, obligations, requests, repairs, and verify items—then map those rows
back to exact campaign cells. Keep the campaign-wide RANS count truthful, but
use a hashed symmetry subplan rather than one airfoil lookup per point. Disable
PostgreSQL JIT only inside the exact counter transaction because compilation
cost dominates this short-lived polling query.

Run independent campaign summary reads concurrently. Browser polling is
completion-relative and serial: one active request, at most one coalesced
follow-up, no fixed-interval overlap. Every polled fetch receives a bounded
abort signal so a connection that never settles cannot freeze future updates.
Coverage refreshes apply the same latest-only and bounded-abort rules.

Run retention in one independent process-local serial loop beside the scheduler
loop. Give admission startup priority, await each retention pass before starting
another, and drain the active pass before closing PostgreSQL on shutdown.
Retention therefore cannot suppress reconciliation, admission, heartbeat, or
tick completion. Keep the existing durable strip stamps, exact reference
rechecks, blob-stripe locks, and process-restart replay as the correctness
boundary. Add the missing `result_media(storage_key)` lookup index and keep
batch reference probes serial so maintenance uses at most one pooled database
connection at a time. Within one engine payload, reuse a canonical point only
after the duplicate attempt passes the existing exact immutable-evidence check;
do not repeat artifact, media, inventory, or force-history staging for the same
exact attempt.

For separate partial-result polls, keep projection completion outside immutable
solver evidence in `result_attempt_ingest_completions`. One row binds the exact
`(result_attempt_id, result_id)` owner to a projection version and full SHA-256
signature of the point payload, setup revision, and resolved solver runtime.
Always run immutable attempt replay validation first. Skip the expensive child
tail only when the current version and signature match. Write the completion
row only after artifacts, shipped media, field inventory, and force history
have all committed; do not backfill historical attempts. A missing marker
therefore takes the idempotent full path and fills crash-partial children.
Terminal GCS replays reconstruct their cleanup obligation from the exact stored
bundle/archive association and still pass full manifest/member validation
before asking the engine to reclaim local bytes.

Keep the point-to-campaign link, automatic RANS-to-PRECALC ownership, and
progress recomputation exact and transactional for every finalized point. Do
not run the campaign-wide completion decision after every point in a cumulative
engine payload. Accumulate affected campaign ids and run that decision once per
campaign after the payload has linked all of its committed points. Existing
single-point callers retain immediate completion semantics. If the process
stops between point settlement and the deferred decision, the campaign remains
conservatively active; the low-frequency campaign reconciler recomputes
progress and runs the same completion decision.

Split the completion decision into a fast open-work gate and a terminal-only
snapshot. The ordinary active-campaign path runs only the partial-index-backed
requested-point `EXISTS`. Only a campaign with no open point evaluates lanes,
in-flight replacements, recovery obligations, rejected/blocked evidence,
preliminary work, and final verification. Recheck open work in the terminal
snapshot so a concurrent plan edit cannot cause premature completion.

This supersedes only the causal wording and campaign-level presentation in the
2026-07-07 liveness/progress decision. Its independent heartbeat, tick
timestamps, five-minute advisory threshold, and red process-death semantics
remain unchanged.

## Why

The alternatives were:

1. keep the repeated `SLOW` warnings and engine attribution;
2. hide the signal completely;
3. add a client-side timeout that abandons a still-running scheduler tick;
4. keep one honest global advisory and progressively disclose diagnostics.

The first option invents a cause, duplicates non-actionable text, and makes an
active campaign look blocked. The second removes useful operational evidence.
The third is unsafe while engine submission still has a narrow accepted-by-
engine/before-durable-DB-write gap: abandoning or killing that tick could
overlap reconciliation, orphan accepted work, or admit duplicates. A real
watchdog requires idempotent engine submission, phase progress timestamps, and
server-side cancellation at every blocking boundary. The fourth preserves
liveness truth without turning internal telemetry into a user task.

For performance, adding a longer poll interval would only mask expensive
queries and leave first load slow; caching the full response would make rapidly
changing campaign progress stale; and adding broad indexes without changing
the point-first access path would still ask PostgreSQL to walk the whole
campaign. Sparse source-first queries preserve live truth and scale with the
exceptional work they count. Serial completion-relative polling additionally
prevents a slow response from becoming self-amplifying load.

Keeping retention awaited before admission was also rejected. It made an
hourly, potentially exhaustive cache scan part of scheduler liveness even
though cleanup has its own durable idempotency and does not own new-work
admission. Allowing unbounded concurrent retention passes was rejected because
they could race the same cache and amplify database and filesystem pressure.
A detached single-flight promise was also rejected: it would let shutdown close
the shared database pool while destructive cleanup was still in flight. The
independent serial loop gives cleanup one owner, lets admission continue, and
provides an explicit shutdown join.

Treating an existing attempt row as sufficient proof of complete cross-tick
ingest was rejected. Attempt insertion precedes child artifacts, projection,
and remote cleanup acknowledgement, so a crash may leave an honest partial
stage that must be resumed. Counting expected rows was also rejected: artifact
kinds can evolve, media may legitimately be absent, and a count cannot prove
the exact immutable payload or GCS archive identity. The separate completion
row is a commit-after-children fence. It makes absence conservative, detects
payload/runtime drift, keeps RANS and URANS attempts isolated even at the same
AoA, and preserves remote cleanup rather than confusing projection completion
with local-byte reclamation.

Running the full completion snapshot once per finalized point was also
rejected. A 256-point cumulative payload could repeat the same campaign-wide
terminal scans 256 times per poll, and repeated partial polls compounded that
work. Skipping per-point campaign linking was not acceptable because a campaign
may begin owning a cell after its evidence was first ingested. The selected
boundary therefore preserves per-point ownership and counters but batches only
the global decision. Adding another point-ledger index was not selected:
production `EXPLAIN ANALYZE` measured the fast open predicate at 0.249 ms with
the existing partial index, so another write-amplifying index would not address
the repeated terminal scans.

## Evidence

Production read-only comparison on campaign
`c24047fa-743f-4ae5-bcd6-f3071ff79fb4`:

- tier counts: 8.39 s to 0.92 s, with exact old/new equality
  `{ransOpen: 627678, precalcOpen: 3100, verifyOpen: 532}`;
- review rows: 1.46 s to 128 ms, with exact old/new equality and zero current
  review rows;
- PostgreSQL JIT compilation alone accounted for about 508 ms on the former
  tier plan.

Regression coverage pins non-overlapping polls, coalesced follow-ups,
latest-only matrix refreshes, hidden-tab behavior, sparse-query source shape,
the absence of campaign-level scheduler-delay gates, a deferred retention pass
that cannot overlap or hold scheduler progress open, graceful shutdown drain,
and the indexed storage-key lookup used by cache reference checks. Exact ingest
regressions additionally prove crash-partial force history is filled before a
marker appears, exact cross-tick replay bypasses the child tail, changed
payloads fail immutable validation, same-AoA RANS and URANS attempts retain
separate markers, and terminal replay restores the identical GCS cleanup
association.

Completion-probe regressions additionally pin that an open campaign executes
only the fast query, the rare terminal snapshot rechecks newly-open work, and a
multi-point result-link batch deduplicates both dirty lanes and completion
decisions. The existing transaction regression proves automatic PRECALC
ownership and point/progress settlement remain one visibility boundary.
