# D-2026-07-27-docker-storage-gc — Bounded deployment-host garbage collection

## Evidence

On 2026-07-27 the production root filesystem had 213 GiB free while storage
admission required 236 GiB. Docker reported 309 images but only nine active
images. Removing the unused image records exposed 80.23 GB of rebuildable
BuildKit cache; pruning that cache reclaimed 82.69 GB and increased root free
space to 298 GiB without restarting any service.

The former deployment path accumulated every superseded application image and
its BuildKit records. Solver evidence, PostgreSQL, Docker volumes, active
images, and active or stopped containers were not part of the cleanup.

The 2026-08-13 audit found the same unbounded lifecycle outside Docker: the hub
retained 185 immutable source releases plus stale staging trees, hz-solver2
retained more than 100 releases plus stale staging/incoming payloads, and the
remote host had no installed cleanup timer. Those sources are reproducible from
Git and are not runtime state. Docker also lives on a separate filesystem on
hz-solver2, so measuring `/` did not measure the resource being reclaimed.

## Alternatives considered

1. Keep manual pruning. This had already allowed deploy churn to close solver
   admission again and depends on an operator noticing the condition.
2. Run unrestricted `docker system prune`. This can remove stopped containers
   and networks and has a broader operational blast radius than the observed
   problem.
3. Prune every unused image immediately after deployment. This maximizes free
   space but removes the short local rollback window as soon as a container is
   replaced.
4. Run daily, age-bounded image and BuildKit cleanup. Container-referenced
   images remain ineligible, recent unused images provide a rollback window,
   and rebuildable cache is held to a small hot set.
5. Keep every sealed source release and rely on manual staging cleanup. This is
   safe per release but has no aggregate bound and had already accumulated
   thousands of redundant source megabytes.
6. Keep the live sealed release plus two newest rollback releases, and remove
   abandoned staging/incoming payloads after 24 hours while holding the same
   deployment lock. Git remains the durable source and the short local rollback
   path remains available.

Options 4 and 6 are selected. A systemd timer runs daily with a randomized
delay, retains the exact live source plus two most recent rollback releases,
removes isolated staging and incoming payloads older than 24 hours only while
the deployment lock is available, removes only images unused by every
container and older than 72 hours, and bounds rebuildable BuildKit records to a
10 GB hot cache independent of age. Docker free-space deltas use Docker's
reported root filesystem. The job uses an exclusive cleanup lock, the existing
deployment lock for source mutations, low CPU priority, and idle I/O priority.
It never prunes containers, volumes, networks, databases, solver results,
evidence, shared deployment state, or the live sealed release.

## Verification contract

- The first production cleanup increases real filesystem free bytes.
- Every production container remains running across cleanup.
- The timer is enabled, active, persistent across missed schedules and reboots,
  and points at the installed versioned script.
- A second cleanup is idempotent and reports no material reclaim.
- Runtime logs label the observed filesystem delta as a during-run measurement,
  not as Docker-attributed reclaimed bytes, because solver writes may overlap.
- The script rejects invalid retention and cache values.
- Exactly the live release plus at most two rollback releases remain; the live
  release remains manifest-verifiable and is never selected by age.
- Staging/incoming children younger than 24 hours survive; older isolated
  children are deleted only when the deployment lock is held. A concurrent
  deploy makes source cleanup a safe no-op.
- Free-space measurement targets Docker's reported root directory, including
  when it is a separate mount from `/`.
- Shell syntax and systemd unit structure validate before installation.
