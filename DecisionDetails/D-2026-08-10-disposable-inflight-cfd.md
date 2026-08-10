# Disposable in-flight CFD work

## Decision

Treat active CFD jobs, promises, queues, checkpoints, live case directories,
and stored solver results as reproducible compute. During an explicitly
requested clean installation, reset, recovery, or solver-maintenance operation,
they may be cancelled or erased without backup and restarted as often as
needed. Preserve only canonical non-solver configuration and the credentials
needed to reconnect deployment roles unless the requested reset is broader.

An interrupted or erased run never becomes solver evidence. Every republished
coefficient, polar, image, or artifact must be produced again by a real solver
run and pass the normal evidence gates.

## Why

The compute cost of reproducing the current campaign is lower than the time and
operational complexity of checkpoint, archive, database-backup, and recovery
work. The prior preservation-first rule made clean recovery slower than simply
solving again. A disposable-runtime policy restores service quickly while the
existing no-fake and evidence-validation rules keep regenerated results
truthful.

## Operational evidence required

A clean recovery is complete only when the hub admits work at eight CPU slots,
the dedicated remote solver claims hub promises at forty CPU slots, real RANS
work executes, remote delivery reaches the hub, and interrupted work can be
requeued without stale ownership or zombie jobs.
