# D-2026-08-11 Disposable storage headroom

## Decision

Keep solver storage as a bounded working set rather than a retention archive.
After the hub authenticates, stores, and returns the signed exact binding for a
remote case, the remote engine may reclaim that inactive case's packaged and
unpacked evidence while later cases in the same multi-angle job continue. The
signed receipt, exact manifest/archive hashes, generation-pinned hub readback,
case identity, and inactive-case check remain mandatory.

The workload-aware admission forecast stops new submissions before their
expected growth consumes the reserve. Per-case reserves use measured production
p95 plus explicit packaging headroom, and the unknown next-job reserve covers
one ordinary FAST-URANS batch. The sweeper re-measures and recomputes all active
future growth before every refill submission so one permissive decision cannot
authorize a multi-job burst. A separate measured emergency
high-water mark defaults to 80% filesystem use. At that mark the sweeper
cancels a bounded batch of active reproducible jobs, releases their claimed
points for restart, and bypasses ordinary age and remote-terminal retention
fences only for the exact pressure-cancellation marker. It never publishes an
interrupted run.

Local solver-database dumps, deployment staging payloads, images, caches, and
releases are operational working data with explicit count or age bounds. They
must not accumulate as an informal backup system. Canonical non-solver
configuration and reconnect credentials remain outside disposable cleanup.

## Why

`hz-solver2` reached 100% on its 3.3 TiB Docker filesystem and made PostgreSQL
unhealthy. The engine had already delivered most completed points, but
case-level reclaim returned HTTP 409 until each entire multi-angle job became
terminal. Nineteen retained reclaim rows plus still-running job state consumed
the remaining volume. Admission correctly stopped new work, but it could not
stop already-admitted OpenFOAM children from growing their directories.

The selected design makes successful incremental delivery release storage at
the same granularity at which evidence is published, while the independent
high-water action bounds failure paths where transfer or reconciliation cannot
keep up. Archiving reproducible working files was rejected because it adds a
second storage authority and takes longer than restarting the work. Waiting
only for terminal-job retention was rejected because one long remaining angle
retains every earlier accepted case. Admission-only protection was rejected
because active jobs can continue writing after admission closes.

Treating every remaining FAST-URANS case as 2 GiB was also rejected after the
2026-08-11 hub run: completed cases occupied 0.5–0.62 GiB each and the recorded
production p95 was 1.196 GiB, so the old reserve unnecessarily withheld an
otherwise safe eighth-slot refill. The selected 1.5 GiB reserve remains 25%
above p95 and over twice the observed run, while the next-job reserve increases
from 24 GiB to 40 GiB to cover a 26-case FAST-URANS batch.

## Verification

Regression coverage proves that a running job reclaims only a completed,
inactive case; the active and missing cases remain 409 conflicts. Sweeper
coverage distinguishes forecast-only blocking from measured emergency use and
proves pressure-cancelled remote jobs bypass the ordinary delivery/age fence
with `keep_case_state=false`. Coverage also pins the observed eight-job
FAST-URANS shape and per-refill re-evaluation. Production proof requires healthy PostgreSQL and
Redis, 8/40 active slot limits, fresh remote heartbeats and promises, real job
progress, successful delivery/reclaim, and measured disk headroom after the
delivery cycle.
