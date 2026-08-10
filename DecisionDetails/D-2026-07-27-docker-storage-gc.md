# D-2026-07-27-docker-storage-gc — Age-bounded Docker garbage collection

## Evidence

On 2026-07-27 the production root filesystem had 213 GiB free while storage
admission required 236 GiB. Docker reported 309 images but only nine active
images. Removing the unused image records exposed 80.23 GB of rebuildable
BuildKit cache; pruning that cache reclaimed 82.69 GB and increased root free
space to 298 GiB without restarting any service.

The former deployment path accumulated every superseded application image and
its BuildKit records. Solver evidence, PostgreSQL, Docker volumes, active
images, and active or stopped containers were not part of the cleanup.

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

Option 4 is selected. A systemd timer runs daily with a randomized delay,
removes only images unused by every container and older than 72 hours, and
bounds rebuildable BuildKit records to a 10 GB hot cache independent of age.
The job uses an exclusive lock, low CPU priority, and idle I/O priority. It
never prunes containers, volumes, networks, databases, solver results, or
evidence.

## Verification contract

- The first production cleanup increases real filesystem free bytes.
- Every production container remains running across cleanup.
- The timer is enabled, active, persistent across missed schedules and reboots,
  and points at the installed versioned script.
- A second cleanup is idempotent and reports no material reclaim.
- Runtime logs label the observed filesystem delta as a during-run measurement,
  not as Docker-attributed reclaimed bytes, because solver writes may overlap.
- The script rejects invalid retention and cache values.
- Shell syntax and systemd unit structure validate before installation.
