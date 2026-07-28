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
and the absence of campaign-level scheduler-delay gates.
