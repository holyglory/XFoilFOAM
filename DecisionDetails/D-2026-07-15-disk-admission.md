# D-2026-07-15-disk-admission — Storage reserves gate new solver jobs

## Evidence

On 2026-07-15 the production root filesystem reached 100%. PostgreSQL repeatedly
failed its end-of-recovery checkpoint with `No space left on device`, while the
sweeper and worker restart loops could not mount or update Docker state. The
results volume occupied about 280 GiB; PostgreSQL itself occupied about 1.2 GiB.
Safe full stripping had already removed live solver state from many terminal
jobs, but their immutable evidence still measured about 11 GiB per completed
78-point job. Six recent completed engine directories had not yet passed the
fresh-lock retention window.

The existing maintenance disk probe logged a warning above 80% but did not
participate in admission. The scheduler therefore kept filling all available
worker tokens even after storage had crossed the warning threshold.

## Alternatives considered

1. Keep warning-only monitoring and depend on an operator. This already failed:
   the disk filled between observations and took PostgreSQL, Docker restarts and
   solver scheduling down together.
2. Lower CPU slots or the concurrent-job cap. This slows growth but does not
   reserve disk for active jobs and eventually fills the filesystem.
3. Delete immutable OpenFOAM bundles or re-render VTK after ingest. That would
   break evidence downloads, custom rendering, and the project's no-fake,
   immutable-evidence contract.
4. Disable the sweeper at high use. This also disables reconciliation,
   incremental ingestion and automatic retention—the exact recovery paths that
   must remain alive under pressure—and makes an active campaign look manually
   paused.
5. Gate only new admission using a measured percentage ceiling plus explicit
   per-active-job and system reserves, while persisting the reason for the UI.

Option 5 is selected. Expanding or offloading evidence storage is still required
before the full all-airfoil campaign can finish; the admission gate is the
database-safety foundation, not a substitute for capacity.

The retention execution guard now holds the same non-blocking OS `flock` used
by `run_polar` for the complete strip/delete operation. This replaces the
six-hour mtime approximation: a released fresh lock is safe immediately, while
an actually executing task remains protected without a check/delete race.
Cancellation also changes a published partial result from `running` to
`cancelled` after reaping, preserving every published polar while allowing the
terminal job to enter normal retention.

During recovery the owner expanded the block device to 500 GiB. The root GPT
partition and ext4 filesystem were then extended online, yielding about 216 GiB
free at 56% use. This is sufficient to resume under the measured reserve, but
does not change the need for additional durable capacity before all 631,000
requested points can retain their evidence.

## Verification contract

- Invalid or unavailable disk measurements fail closed for new admission.
- At or above 80% used, no new solver job is submitted.
- Below 80%, admission still requires a 20 GiB system floor plus 24 GiB for
  every active job and one newly admitted job.
- Reconciliation, ingestion, retention and the independent heartbeat run while
  admission is blocked.
- A genuinely held solver lock refuses retention; a fresh but released lock
  does not delay cleanup. Cancelled partial result evidence stays present but
  becomes terminal.
- The last measured used percentage, free bytes, required bytes, timestamp and
  reason persist in `sweeper_state` and reach Queue, campaign hub and campaign
  detail payloads.
- The admin UI says `storage blocked` and shows the real reason; it must not say
  the scheduler is healthy/running or that the campaign was manually paused.
