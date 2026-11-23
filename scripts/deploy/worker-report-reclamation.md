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

## Observe a worker vacuum and defer interior packing

Create a private baseline before maintenance. Repeat this check during an active vacuum and once it finishes. The existing `--measure worker` receipt is also accepted as a baseline. The command records actual relation allocations, WAL and the host filesystems containing the heap, TOAST, indexes, and WAL. It also records the HZ containers' exact identities, states, start times and restart counts, along with live promises, ingesting jobs, outbox backlog and delivery claims.

```sh
python3 scripts/deploy/worker-report-reclamation.py --return-check worker --live-values --output before.json
python3 scripts/deploy/worker-report-reclamation.py --return-check worker --prior before.json --live-values --output after.json
```

Match the vacuum's relation OID, PID and backend start. Confirm completion using the advanced TOAST autovacuum timestamp or the PostgreSQL completion log for that worker. A missing progress row by itself is ambiguous. The log's removed-page count identifies truncation by that particular vacuum. File sizes and filesystem availability also include concurrent writes. [PostgreSQL vacuum progress](https://www.postgresql.org/docs/16/progress-reporting.html#VACUUM-PROGRESS-REPORTING)

The tail probe examines up to 32 pages per relation through a bounded tuple-ID range plan. A visible tuple in the final block gives a zero upper bound for an empty tail at that observation. A missing visible tuple leaves the true tail size unknown. The optional 12-second, single-worker live census counts compressed report fields in the parent heap. Its snapshot has its own timestamp. If PostgreSQL cancels that scan, the receipt retains the physical measurements and reports an unavailable census. Interior holes can become available to PostgreSQL for new writes. [PostgreSQL storage columns](https://www.postgresql.org/docs/16/ddl-system-columns.html)

Use `reviewSignals` to schedule a fresh assessment when file allocation falls, a vacuum completes, ingress drains or workspace improves. A private, independently established workspace budget can be supplied with `--review-free-bytes N`. Include the replacement heap, TOAST and indexes, index construction workspace, additional WAL retention and continuing workload growth. The combined budget comparison requires a common volume and default temp tablespace. `freeMinusCurrentAllocationBytes` compares against the existing allocation. `freeMinusLiveReportValuesBytes` charges only the stored report fields. Neither comparison establishes a packed replacement size. PostgreSQL can exceed `max_wal_size` during heavy activity. [PostgreSQL WAL settings](https://www.postgresql.org/docs/16/runtime-config-wal.html)

All return checks are read-only. Keep ordinary HZ ingress and the engine services available while waiting. Coordinate any future pause with its owner and record the actual containers, external writers, active leases and restoration window before it begins. Use the HZ physical rewrite procedure below for a separate, explicitly authorized maintenance window.

### HZ physical rewrite

The named `hz-worker-report-rewrite` graph provisions an empty disposable PostgreSQL 16 database, runs the worker rewrite and recovery tests, checks the existing hub lifecycle, and tears down its database. To reproduce it, supply the absolute path to the checkout in this command.

```sh
devcoordinator2 call test.start --params '{"path":"/absolute/path/to/XFoilFOAM","test":"hz-worker-report-rewrite"}'
```

Run the worker command from the operator machine that owns the report maintenance user units, with the usual host-key-checked HZ and upstream SSH access. Start with the live, read-only plan. `--growth-bytes` is the reviewed allowance for other filesystem writes over the whole window. Supply the value in bytes. Save the JSON in a new private file.

```sh
python3 scripts/deploy/rewrite-hz-worker-reports.py --dry-run \
  --checkpointed-units "$CHECKPOINTS" --growth-bytes "$growth_bytes" --sample-identity --output "$plan_file"
```

A restarting operator service appears in the dry run with its systemd state and a pause refusal. Disk and lease measurements remain available. Recovery checks each captured writer directly, so an unrelated service transition can be reported after the original writer is released.

Supply `--checkpointed-units "$CHECKPOINTS"` on the dry run and on execution when persistent archive services hold the shared HZ deploy lock over SSH. This private JSON maps each systemd service name to its actual restart checkpoint. A service with a separate durable progress record may use an object with `checkpoint` and `receipt` absolute paths. Choose the live controller's current paths. A fresh unchanged-data scan needs a real progress receipt from that scan. The operator records content hashes of the effective unit definition and the checkpoint, including a SQLite WAL when present. Keep this file and the run directory on the operator's persistent filesystem.

```json
{
  "archive-writer.service": {
    "checkpoint": "/absolute/private/state/archive.sqlite3",
    "receipt": "/absolute/private/state/completed-page.json"
  }
}
```

Active checkpointed services stop gracefully before other maintenance processes are frozen. PostgreSQL gets the original exclusive deploy lock only after remote readers release it. The lock wait is bounded, and a refusal before any HZ writer stop still restores the previously running checkpointed services. Recovery verifies the exact stopped checkpoint and unit definition before starting the service. The durable run records its new invocation and the next changed progress receipt. If the receipt arrives late, `--recover RUN_DIR` can finish verification without repeating the SQL. Previously inactive or already frozen services keep their captured states.

The plan binds the HZ registration on both instances, the configured remote-solver role, the PostgreSQL 16 primary, and the exact heap, TOAST and index files of `public.progressive_worker_reports`. It resolves their actual Docker mount and device, WAL and sort workspace, usable filesystem bytes, archive mode and replication slots. It reports local collection and outstanding delivery, physical solver processes, operator units and both hosts’ earliest active promise expiry. A running physical solver can keep computing throughout the rewrite.

Space for the old relation remains occupied until PostgreSQL commits the replacement. The default plan reserves a second copy equal to the current allocation, separate index scratch, additional retained WAL, external growth and the free-space floor. A reviewed `--replacement-bytes` can budget a smaller packed copy including indexes. The command also checks this estimate against current stored report sizes and heap/index allowances. PostgreSQL page fill, concurrent growth, TOAST and WAL can change the actual peak. Treat a packed budget as an estimate, and count parking on a separate device only after it produces measured free bytes on the PostgreSQL device. The plan reports the maximum affordable replacement and any additional bytes needed. `--wal-bytes` and `--stop-free-bytes` set the additional WAL budget and the cancellation reserve. PostgreSQL's `max_wal_size` is a soft checkpoint target. [PostgreSQL VACUUM](https://www.postgresql.org/docs/16/sql-vacuum.html) · [PostgreSQL WAL configuration](https://www.postgresql.org/docs/16/wal-configuration.html)

With a reviewed packed budget, the census reports a second, independent planning figure. It uses the installed cluster's block and maximum TOAST chunk sizes, rounds **each** stored report up to whole pages at four full chunks per page, then adds the entire current allocation outside the TOAST heap. This charges inline headers again and keeps existing heap and index allowances. Recently dead tuples still visible to older snapshots and changes in physical packing can add bytes. The dry run records outstanding prepared transactions and the age of other snapshots. Actual free space and WAL remain under observation throughout the rewrite. [PostgreSQL TOAST storage](https://www.postgresql.org/docs/16/storage-toast.html)

Allow time for the pre- and post-rewrite identity proofs, the SQL command, restoration, and a normal heartbeat. Defaults are 1,800 seconds for **each** proof and 5,400 seconds for the rewrite. `--identity-seconds` and `--rewrite-seconds` set their deadlines. The bounded identity sample measures database hashing on one small set of rows. Whole-table proof and rewrite times can differ substantially. A window that will outlive the earliest captured active promise is refused. During maintenance a shortening upstream lease, a cancellation request, low usable space or excess WAL triggers cancellation. Sustained lock contention also stops the attempt. Interrupted or expired solver work keeps its ordinary controller and evidence semantics.

After user notice, approval, workspace preparation and a fresh passing plan, execute with the **same reviewed budgets** and a new private directory. Add `--unit NAME` on both commands for an additional operator-side HZ maintenance writer. The operator records the exact prior user unit status, timers and service invocations. It stops triggering timers and checkpointed SSH writers, then freezes the other originally running maintenance service cgroups. On HZ a detached, time-limited service takes the existing deploy lock and stops the captured running control-plane containers by ID. It preserves engine and worker processes, Redis, database, prior maintenance settings and already stopped services. During the pause the sweeper cannot collect or deliver intermediate reports or renew promises. After restoring writers the command checks their actual availability, registration, policy and collection process, and observes a subsequent stored sequence when a sampled execution produces one. The receipt distinguishes a quiet execution.

```sh
python3 scripts/deploy/rewrite-hz-worker-reports.py --execute \
  --checkpointed-units "$CHECKPOINTS" --growth-bytes "$growth_bytes" --run-dir "$new_private_directory"
python3 scripts/deploy/rewrite-hz-worker-reports.py --status "$new_private_directory"
python3 scripts/deploy/rewrite-hz-worker-reports.py --cancel "$new_private_directory"
python3 scripts/deploy/rewrite-hz-worker-reports.py --recover "$new_private_directory"
```

Status is read-only. Cancellation targets this run’s server unit and uniquely tagged SQL session. Recovery restores the captured identities and prior states after an interrupted operator. Only the original submission can rewrite the table. Run it after loss of the operator process or SSH once the original server is reachable. The durable operator marker records the run directory and protects frozen external writers while server restoration is unknown. A previously inactive service stays inactive. A previously frozen maintenance process keeps its original frozen state. Existing sessions may have disconnected during the pause, and overdue calendar timers can fire when restarted.

Before and after SQL the server streams ordered PostgreSQL binary row digests in repeatable-read snapshots. Every report’s owner, sequence, stored content signature, timestamps, acknowledgements and storage bindings participate, as do referenced/archived headers, shared results, conflicts, staging, archive/delivery receipts and linked stored scientific rows. Both ends of each storage representation also get independent full stored-body checks. Add `--all-report-bytes` to both commands for an independent digest of **every** inline body, budgeting both full scans. The proofs run on HZ, return compact manifests, and use the existing stored evidence. The monitor journals available bytes, WAL directory size, and tagged PostgreSQL lock/progress during the operation. [PostgreSQL rewrite progress](https://www.postgresql.org/docs/16/progress-reporting.html#CLUSTER-PROGRESS-REPORTING)

`rewrite-commit.json` records SQL completion. The OID and physical file identity also distinguish a committed replacement after a lost client response. A cancellation before the replacement commits leaves the old relation in place. After commit, a failed proof or service recovery remains a failure requiring inspection. A committed replacement is permanent. `space-result.json` separately records the verified reduction in relation allocation and the observed change in filesystem availability, which also includes unrelated writes. Regular vacuum's reusable page space becomes an OS return only when files shrink or disappear. Retain the private receipts and progress journal through handoff.
### TOAST-only physical rewrite

Use `--toast-only` on both the plan and the separately authorized operation to compact the worker report table's out-of-line PostgreSQL values. The exact SQL on PostgreSQL 16 is:

```sql
VACUUM (FULL, PROCESS_MAIN false, PROCESS_TOAST true) public.progressive_worker_reports;
```

The existing whole-table path remains the default. The TOAST-only form locks the named parent and processes its auxiliary heap and chunk index. It still needs the coordinated writer stop, source receipts, lease reserve, WAL monitoring and original-state restoration. The PostgreSQL scan and sort budget includes the auxiliary heap, its own btree and separate sort space. The replacement model reads sizes from the parent without fetching the large JSONB values, charges the final partially filled page of each value separately, and accounts for fixed-width chunk-index entries and auxiliary forks. An operator-supplied smaller budget still has to cover this model. [PostgreSQL 16 VACUUM](https://www.postgresql.org/docs/16/sql-vacuum.html) · [PostgreSQL 16.14 vacuum.c](https://github.com/postgres/postgres/blob/REL_16_14/src/backend/commands/vacuum.c#L2058-L2131)

The before and after manifests include every TOAST chunk's value ID, sequence and data. PostgreSQL orders the chunk hashes by their primary key, returns one hash per external datum and computes the comparison on HZ. The unchanged parent is bound by its original file, all parent index files, each report slot and version, all signed metadata and the complete bodies that could fit on a heap page. The existing scientific and delivery checks still run. `--all-report-bytes` adds complete decoded-body hashing. `--sample-identity` in TOAST-only mode measures two bounded disjoint groups of complete TOAST values and their warm repeat. The index-ordered proof plan is checked before the operation. Extrapolating a small warm sample to a full cold-volume scan does not establish a duration guarantee.

The auxiliary OID must remain stable and its physical file and chunk index files must change. The parent heap and all its indexes must retain their original OIDs, file nodes and allocations. A missing SQL acknowledgement is classified from those same file identities. Conflicting or incomplete evidence remains unresolved. The space receipt distinguishes retired allocated filesystem blocks, logical relation-size reduction and actual available space on the shared data volume. A cancelled rewrite last seen in progress requires the original auxiliary files and restoration receipts to be verified before any future consideration.

Run `hz-worker-report-rewrite` for the actual operator, service restoration and lost-acknowledgement cases. Its fixture is an empty database named `aerodb`. The separate governed `hz-worker-toast-cost` rehearsal uses a migrated database named `hz_rewrite_cost` and consumes the same private corpus described below. It compares 11 real parent index memberships, original PostgreSQL report hashes, scientific results, coefficients and histories, and exercises cancellation in an actual auxiliary rewrite. Only the disposable fixture's own source pages can receive cold-read advice. Use both the actual runtime and the preparation-time local and registered upstream promise horizons when choosing SQL and proof deadlines. A dry run gives a current review receipt. It does not schedule another production operation.

## Read-only sizing and timing

The production operator's space and lease guards measure capacity. They do not establish how long PostgreSQL will take to rebuild expression and partial indexes. Before proposing a longer window, compare a **complete** disk-backed PostgreSQL 16 rehearsal with the observed heap-copy phase and a completed index from the same table definition. Include both identity proofs, index creation, ANALYZE, writer restoration and a heartbeat. Check the largest external filesystem decline over that entire proposed pause and the earliest live lease on both instances. Extending only the SQL deadline can admit an undersized disk or lease window.

The `hz-worker-rewrite-cost` graph runs complete table rewrites on a named disposable database. Supply a private sample manifest containing the reviewed original `job` UUID and integer `seq` for each row. The reader captures bounded neighbouring sequences through the existing HZ SSH path with a read-only PostgreSQL session. It retains binary PostgreSQL data, exact stored and resolved SHA/length, original content signatures, the cataloged cold-member SHA/size, shared payloads and the live index definitions. Treat the corpus as private production evidence. Keep the files in a private directory and expose that directory only to the governed graph. The graph's retained artifact contains timing, file and row-count measurements rather than report bodies.

```sh
python3 scripts/deploy/capture-hz-rewrite-corpus.py \
  --reference "$reviewed_sample" --output "$new_private_corpus"
mkdir -p .codex-artifacts
ln -s "$new_private_corpus" .codex-artifacts/hz-rewrite-cost-corpus
devcoordinator2 call test.start --params '{"path":"/absolute/path/to/XFoilFOAM","test":"hz-worker-rewrite-cost"}'
```

The graph compares the current representation, lossless sharing of genuinely byte-identical adjacent historical results through the existing 0198 format, stored index-membership metadata, and the combination. For historical sharing, eligibility comes from the captured closed worker job, promise, delivery and stop conditions. A source row qualifies only when the adjacent original was independently present and byte-identical. Exact PostgreSQL report bytes and the original scientific content signature survive. An archived header and its immutable catalog binding are checked in place. The original cold bundle is outside this storage-I/O experiment. Real production backfill uses the existing bounded `backfillWorkerReportPrefix` path, with all of its ownership and immutable-record checks.

The metadata experiment stores the exact SQL truth value of each distinct current body-dependent predicate in the disposable relation. It compares membership for **every** captured row against each original expression before timing. All ordinary indexes, including the primary key and TOAST index, rebuild. Physical repetitions receive a separate storage-only key to preserve the original scientific job and sequence, and retained data is checked again against every row after PostgreSQL swaps the files. Both orders of the four modes run to reduce simple cache-order bias. Checkpoint/WAL settings, the disposable tablespace and storage amplification belong to the benchmark receipt. An application migration still has to maintain metadata correctly for insert, acknowledgement, normalization and archive transitions, qualify its readers, and measure the cost of deploying it.

Use the operator's existing `--all-report-bytes` mode for a separate exhaustive inline-body proof only when both scans have been timed into the pause. During a real rewrite, `pg_stat_progress_cluster` reports completed indexes. The counter can stay constant for an entire expensive partial-index scan. Check the exact backend and its parallel workers' CPU and storage reads before diagnosing a stall. PostgreSQL may use a parallel index-build worker even with parallel query gathers disabled. [PostgreSQL progress reporting](https://www.postgresql.org/docs/16/progress-reporting.html#CLUSTER-PROGRESS-REPORTING)
