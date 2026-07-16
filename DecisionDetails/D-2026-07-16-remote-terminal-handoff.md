# D-2026-07-16-remote-terminal-handoff

## Trigger and evidence

The 2406 `hz-solver2` deployment finished the accepted portion of AG24 but
then went idle with an empty engine queue. Production promise
`f0415d86-7eb8-4202-84b7-a9065ff69015` remained active at 18 of 26 fulfilled
points. The remote created 183 cancelled `[13,14,15]` placeholder jobs at
about 8.3-second intervals; every one ended with `remote promise had no locally
claimable AoAs`. `claimAoas` was correct: preliminary obligations already
owned those cells. The remote work-state projection incorrectly called the
same stale result rows ordinary RANS gaps.

Exact attempt inspection also found accepted URANS evidence for 13° and 14°
with valid manifests, while the canonical result pointer still named the older
provisional RANS generation. Remaining post-stall cells retained rejected
URANS attempt evidence. None of those outcomes was reaching the hub because
remote delivery selected only the current accepted pointer.

## Decision and contract

- A pending/running preliminary obligation owns the cell. The remote loop
  never composes another RANS request for it. A terminal wave-1 parent is
  rescanned so one rejected first preliminary solve can use the already
  approved second physical attempt.
- Accepted attempt evidence is discoverable by exact immutable generation,
  even when a stale/provisional result pointer failed to advance. Accepted
  URANS remains eligible for ordinary promise fulfillment.
- An exhausted rejected generation is streamed through the existing bounded
  multipart evidence path. The hub returns that exact angle in
  `terminalAoas`, retains its attempt, manifest, media, and classification,
  and records the promise point as cancelled with exact result/attempt
  pointers. It never advances an accepted polar pointer or fit cache.
- `/complete` remains all-accepted. When a mirror contains both fulfilled and
  terminally evidenced points, the remote durable cancellation outbox releases
  the authoritative lease only after every local point is settled.
- A cancellation without result/attempt evidence remains an ordinary gap. A
  zero-claim fallback cancels one bad mirror instead of producing unbounded
  local placeholder jobs, but it does not synthesize hub evidence.
- Solver heartbeat counts active mirrored promises and active promise angles;
  an empty engine queue no longer makes an owned lease look globally idle.

## Alternatives

Marking terminal rows accepted was rejected because it would place invalid CFD
in public polars. Cancelling immediately was the observed livelock because the
hub truthfully saw no result and reissued the same gap. A permanent
same-solver exclusion or cooldown was rejected because it would suppress work
without copying the evidence and could strand recoverable cells. Raising or
removing the two-attempt preliminary bound was rejected because the bound is a
physical reliability decision, not a scheduling retry counter.

## Operational mitigation and verification

Before changing code, the existing production backup
`aerodb-pre-continuous-hz-solver2-feed-20260716T204046Z.dump` was checksum
verified. AG24 alone was temporarily removed from the five-airfoil feed and
the stuck promise was cancelled through the authenticated sync endpoint. No
AG24 result, attempt, obligation, or artifact was deleted or modified. The
remote immediately claimed Clark Y as a 26-angle job and resumed real worker
CPU activity.

Regression coverage reproduces the zero-claim loop, historical accepted URANS
selection, second bounded preliminary recovery, terminal evidence handoff,
mixed-promise cancellation, exact replay/idempotency, accepted-only
`/complete`, and the false-positive guard that a plain cancellation remains
claimable. Production rollout verification must confirm the hub stores exact
terminal evidence, the remote advances to another airfoil, and no new repeated
placeholder-job sequence appears before AG24 is restored to the feed.
