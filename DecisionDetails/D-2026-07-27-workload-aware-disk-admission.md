# D-2026-07-27-workload-aware-disk-admission — Reserve measured remaining local work

## Decision

Supersede the fixed `24 GiB × active CPU-slot count` production admission
estimate with a workload-aware reserve for unfinished cases on the local engine.
Keep a 20 GiB system floor, reserve a conservative 24 GiB for the next
not-yet-composed local job, and retain a 95% emergency ceiling. Use these
per-remaining-case defaults:

- steady RANS: 320 MiB;
- fast preliminary URANS: 2 GiB;
- final URANS: 6 GiB;
- unknown or malformed work: the full 24 GiB fallback.

Count local engine jobs once regardless of their CPU-slot weight. Hub-issued
promises running on another solver do not consume a local-job reserve on
production: their completed Zstandard archive uploads directly to GCS. The
20 GiB floor covers the hub's bounded, short-lived fresh-generation
verification material in addition to PostgreSQL and Docker operating space.

If the Python engine's disk endpoint is temporarily saturated, measure the same
mounted results filesystem from the sweeper with `statfs`. Fail closed only when
both measurements are unavailable or invalid.

## Why

On 2026-07-27 the old guard reported 236 GiB required for eight accepted local
jobs even though their live engine directories occupied about 8.2 GiB and the
mix included one-case and two-case targeted work. It multiplied
`admission_cpu_slots`, an execution-capacity value, as if every slot were an
independent full 78-angle disk exposure. It also overwrote a healthy disk state
with “measurement unavailable” whenever the busy engine API exceeded its
15-second timeout.

Production's current immutable archives measured these p95 uncompressed sizes:
0.235 GiB for RANS, 1.196 GiB for fast URANS, and 3.739 GiB for final URANS.
The selected reserves are above those observed tails and reserve only growth
that has not happened yet; bytes already written are already reflected in
filesystem free space. A fresh 78-angle RANS sweep therefore still reserves
24.375 GiB, slightly more than the former whole-job allowance, while the
observed mixed workload reserves 85 GiB rather than 192 GiB.

Alternatives considered:

1. Keep 24 GiB per slot. This repeats the false capacity model and strands
   healthy disk and CPU.
2. Remove admission or use free bytes alone. This would recreate the July 15
   full-disk incident and provides no headroom for in-flight growth.
3. Charge remote promises as production jobs. This double-counts computation
   and storage owned by the remote node; production receives a direct-to-GCS
   archive and performs only bounded verification.
4. Use archive averages. Averages underprotect transient and final URANS tails.
5. Use conservative fidelity-specific p95-overhead reserves plus an unknown-job
   fallback. This is selected because it is efficient for small work, remains
   conservative for full sweeps, and fails safe for unclassified work.

## Verification

- Nine pure admission regressions cover the measured mixed workload, an intact
  78-angle RANS sweep, fidelity-specific remaining work, CPU-slot independence,
  malformed fallback, percentage and free-space gates, invalid measurements,
  and the `statfs` calculation.
- The sweeper TypeScript build passes.
- Production verification must show `disk_admission_blocked=false`, about
  129 GiB required for the observed eight-job mix before subsequent progress
  changes it, new local submissions resuming, and remote promise execution
  remaining independent.
