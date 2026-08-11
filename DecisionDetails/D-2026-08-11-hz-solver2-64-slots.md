# hz-solver2 64-slot capacity

## Decision

Run hz-solver2 with a 64-slot worker, case, Celery, and container-CPU contract.
Keep the capacity configurable but require all four controls to agree.

## Evidence and rationale

The host has 48 physical Zen 4 cores and 96 logical CPUs. At 40 slots it ran
about 38 OpenFOAM processes, used roughly 42% of logical CPU, had no measurable
I/O wait, and retained about 98 GiB of available memory. Forty therefore left
eight physical cores plus every SMT sibling unused. Sixty-four uses all
physical cores and up to sixteen SMT siblings while leaving 32 logical CPUs for
the control plane, database, packaging, and host work.

Using 96 slots would maximize the displayed logical-CPU percentage but risks
reducing aggregate solve throughput through execution-unit and memory-bandwidth
contention. Keeping 40 was safer but knowingly underused this dedicated host.
The 64-slot setting is reversible through the same validated deployment
capacity variables if measured completed-point throughput does not improve.

## Verification

After the disposable-work restart, verify the merged and live container quota,
all three concurrency variables, the remote database budget, registered hub
capacity, fresh heartbeat, active promises, real solve progress, memory and I/O
headroom, and completed-point throughput. Revisit the value if load stays below
roughly 60% with eligible work or if memory pressure, I/O wait, or per-point
completion time regresses.

## Production outcome

The disposable reset recreated the remote database from current migrations,
restored only its upstream registration and credentials, enabled the OpenCFD
2606 pool, and refilled to 64 jobs, 64 reserved slots, and 64 active promises.
The authoritative hub heartbeat then reported 69% logical-CPU load, 17% memory
use, zero measured I/O wait, 3.17 TB free storage, and 1,410 active AoAs. The
fresh run had already stored 141 result attempts and completed three delivery
outbox rows at the verification sample.
