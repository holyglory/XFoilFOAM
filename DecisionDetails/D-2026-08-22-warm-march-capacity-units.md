# Warm-march capacity uses real execution units

## Decision

For warm-start steady RANS, one admission unit is one independently executable
chord×speed polar multiplied by its solver-process count. AoAs inside that
polar remain a serial marched sequence so the mesh and warm solution are
reused. For cold or transient work, independently executable
chord×speed×AoA cases remain the admission units.

Pin the engine request's CPU budget and case concurrency to that same effective
unit count. The remote node reaches its 64-slot capacity through independent
hub promises, within the separate 96-promise lease cap, rather than by claiming
that serial AoAs are concurrent.

## Evidence

On 2026-08-22 hz-solver2 had two 26-angle RANS jobs recorded with reservations
of 26 and 12 slots. Their live engine metadata identified
`resolved_policy=airfoil_parallel`, one reused mesh, and serial active AoAs;
each job held one real CPU token while the database reported the node at 64
reserved slots. The worker held about 26 real tokens and used roughly 2,600%
CPU. This was reservation-unit mismatch, not a CPU, memory, I/O, or storage
limit.

## Verification

- A 25-angle, one-speed, one-chord warm RANS request reserves and pins one
  solver-process group.
- A transient/cold 25-angle request retains bounded AoA case concurrency.
- One remote refill admits up to sixteen independent warm promises and later
  ticks can fill the unchanged 64-slot node without exceeding it.
- Production compares DB reservations, engine scheduling metadata, token
  leases, OpenFOAM process pressure, and container CPU instead of accepting the
  configured or displayed reservation alone.
