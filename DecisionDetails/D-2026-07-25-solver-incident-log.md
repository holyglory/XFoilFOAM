# D-2026-07-25-solver-incident-log

## Context

Health rendered grouped solver incidents as a large, permanently expanded
panel headed “System investigation required.” Production showed 21 backfilled
`non-publishable-evidence` and five `solver-execution-failed` occurrences from
July 16 as active critical rows, while two later final-URANS warnings were
already owned by automatic retry/continuation. The interface consumed the
first viewport, hid chronology and per-occurrence evidence, and implied an
administrator action that did not exist.

## Decision

Health and campaign surfaces use a compact collapsed **Solver recovery** status
bar. Its indicators distinguish unresolved solver-owned patterns from
automatic retry and clear state, and never instruct the user to investigate.
Expansion reveals a newest-first event log. Every event is independently
expandable and discloses the exact immutable debug evidence only on demand.

The authenticated
`GET /api/admin/solver-incidents?sinceHours=…&limit=…` endpoint returns those
individual events with operational state, solver/recovery identity,
owner/job/attempt references, recurrence counts, campaign attribution,
timestamps, and metadata. It explicitly reports
`userActionRequired: false` and describes its role as a runtime supplement to
`CompletionLedger.md`. Agents reconcile recurring unresolved patterns into one
ledger item per implementation/operational gap; the API never mutates the
source-controlled ledger.

## Why

The rejected alternative was to keep the grouped panel and merely replace
“investigation required” with softer prose. That would still consume
substantial space, conceal chronology, and prevent operators or agents from
reaching the exact evidence behind a recurrence. Another rejected alternative
was to copy runtime incidents directly into `CompletionLedger.md`; immutable
runtime history and the active implementation queue have different ownership
and lifecycles, so automatic copying would create stale or duplicated ledger
work.

Progressive disclosure keeps routine Health inspection compact while preserving
full forensic access. A dedicated authenticated JSON read model gives browser
and AI agents the same truthful source without exposing an unauthenticated
diagnostic channel.

## Verification contract

- Collapsed Health state occupies one status row and contains no
  “System investigation required” instruction.
- Indicators distinguish solver-owned recurrence, automatic retry, and clear
  state using real counts.
- Opening the bar reveals newest-first immutable occurrences.
- Opening an occurrence reveals exact technical metadata and stable ids.
- Wide and 390 px layouts do not overflow.
- The agent endpoint is admin-protected, newest-first, and marks every event
  `userActionRequired: false`.
- The endpoint/runbook explains how to supplement—not automatically rewrite—
  `CompletionLedger.md`.
