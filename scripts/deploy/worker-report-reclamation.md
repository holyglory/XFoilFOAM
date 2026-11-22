# Reclaiming PostgreSQL space after report archival

Archiving a verified report replaces its large PostgreSQL body with a small
header and an immutable object reference. PostgreSQL can reuse the old pages
after vacuum. Returning space to the filesystem depends on the location of the
free pages.

## Measure the report table

Run the read-only audit from the operator host. It uses the existing SSH aliases
and measures the data volume that actually holds PostgreSQL. Keep the resulting
snapshots in a private operations directory.

```sh
python3 scripts/deploy/worker-report-reclamation.py --measure worker --output BEFORE.json
python3 scripts/deploy/worker-report-reclamation.py --measure hub --output HUB.json
```

The audit reports main-table, TOAST and index allocations. TOAST holds large
values outside the main row. The archive catalog gives exact original JSON and
compressed object sizes. The bounded table sample estimates how many bodies
remain online. Review active vacuum work and available disk before maintenance.

## Reclaim and verify

A native vacuum can release an empty file tail. Its truncation step can briefly
lock the table. The supplied SQL sets a lock-wait limit and statement timeout,
touches only the worker report table and its owned storage, and reports file
sizes before and after the operation.

```sh
ssh hz-solver2 'docker exec -i hz-solver2-postgres-1 psql -X -U aerodb -d aerodb' < scripts/deploy/reclaim-progressive-worker-reports.sql
python3 scripts/deploy/worker-report-reclamation.py --measure worker --output AFTER.json
python3 scripts/deploy/worker-report-reclamation.py --compare BEFORE.json AFTER.json
```

Report the measured allocation decrease as disk reclaimed. Interior free pages
remain available for future writes. For the hub, the existing
`compact-progressive-remote-reports.sh` can pack the table during a maintenance
window. Its full rewrite temporarily stops control-plane writers and requires
space for the replacement relation.

## HZ autovacuum for report and TOAST page reuse

On HZ, large report replacements produce dead TOAST chunks. The PostgreSQL 16 dead-tuple trigger is the base threshold plus the scale factor times the relation's estimated tuples. TOAST has its own tuple count. The stock 20% factor can leave tens of millions of dead chunks below the trigger. A 2% ceiling lowers that fraction tenfold while preserving the existing cost throttle. The command reads both catalog estimates, effective thresholds, cost settings and current vacuum phases. [PostgreSQL autovacuum](https://www.postgresql.org/docs/16/routine-vacuuming.html#AUTOVACUUM)

```sh
python3 scripts/deploy/worker-report-reclamation.py --autovacuum worker
python3 scripts/deploy/worker-report-reclamation.py --autovacuum worker --scale-factor 0.02 --apply --output worker-autovacuum.json
```

The first command is read-only. The second applies only pending decreases to the HZ worker report relation or its owned TOAST relation. A lower existing factor wins. TOAST keeps inheriting heap settings when it has no local options. If TOAST already has its own options, its scale factor is evaluated independently. Both commands use the existing HZ SSH target and verify the configured remote-solver deployment role. [PostgreSQL 16 TOAST option selection](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/postmaster/autovacuum.c#L2251-L2267)

A repeat at an effective setting returns `plannedChanges: {}` without a maintenance lock. An actual change uses the shared deployment lock, a bounded table lock compatible with ordinary report writes, and one short transaction. It checks the original options under lock, then verifies both physical file identities and all other reloptions before commit. If maintenance holds a conflicting lock or a concurrent operator changes the policy, rerun the read-only plan. Existing disabled autovacuum or statistics settings are visible in the receipt.

Dead tuple counts and thresholds are estimates. Autovacuum timing also depends on worker availability, active transactions and cost throttling. Use `vacuumPhase`, `lastVacuum`, and `lastAutovacuum` to observe progress. Plain vacuum makes eligible space reusable. Use the separate relation-file and data-volume comparisons above for an actual filesystem measurement.
