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
