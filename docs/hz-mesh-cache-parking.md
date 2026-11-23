# HZ mesh-cache parking for a report rewrite

This host operator copies a bounded set of cold mesh entries to the independent HZ root filesystem. It can then release their original ext4 blocks and restore their exact files. Every seed stays in the working cache. All mesh payloads, including evidence sidecars, have to pass independent readback. The cache retains its configured capacity and numerical recipes.

Use the matching HZ report-rewrite dry run and its independently verified mesh source attestation. The operator orders the eligible attested meshes by original manifest last use. It stops after covering the fresh PostgreSQL-device shortfall and the chosen extra margin. The entry and allocated-byte limits bound the page. A sufficient data volume selects zero entries. The parking filesystem needs its own configured reserve. Space on that device cannot fund PostgreSQL directly.

### Read-only plan

Run the checked-out script on the operator machine. `--ssh` streams the exact program and its worker-scope helper using the existing HZ identity. The default action is read-only. `GUARD` and `ATTESTATION` are local files. `RUN` identifies a new private directory under an existing HZ md3 directory.

```bash
P=scripts/deploy/park-hz-engine-cache.py
RUN=/var/tmp/airfoils-hz-mesh-parking-20261123
page=(--ssh --run-dir "$RUN" --guard "$GUARD" --attestation "$ATTESTATION"
      --margin-bytes "$EXTRA_MARGIN" --parking-reserve-bytes "$MD3_RESERVE"
      --max-bytes "$MAX_ALLOCATED" --max-entries "$MAX_ENTRIES" --min-age-days "$MIN_AGE")
python3 "$P" plan "${page[@]}"
```

The plan reports the source attestation SHA-256, chosen extents, data volume availability, independent parking ceiling, active task count, protected mesh keys, observed external handles and time for a complete second metadata check. Record the output with the rewrite dry run. A recently touched entry or a changed original requires a fresh selection.

### Coordinated execution and recovery

Start the following operations in the maintenance window announced by the deployment owner. Allow normal remote report delivery and promise reconciliation to complete before the rewrite owner takes its writer pause. Retirement and restoration take the existing HZ deployment lock. The safety copy can proceed while delivery and scientific ingestion continue. The two operators run successively.

1. Run `python3 "$P" prepare --all-attested "${page[@]}"` to copy the full bounded safety page. Omitting `--all-attested` copies the current required prefix. HZ rechecks the source identities, copies each selected mesh to a ZIP on md3, syncs it and reopens every member. It stores the complete ZIP SHA-256 and byte size in the private prepared receipt. Preparation uses a private copy lock and keeps every original in place. Repeating it reauthenticates and reuses the sealed ZIPs and preserves the original receipt. No science passes through the controller's SSH connection.
2. Obtain the current matching rewrite dry run. Run `python3 "$P" park --ssh --run-dir "$RUN" --guard "$GUARD"`. The operator recalculates the actual gap, reauthenticates the prepared ZIPs, and retires only a sufficient prefix of that page. An increased gap beyond the prepared extents returns an error. Check both `meetsRequiredBytes` and a new ordinary rewrite dry run. Net filesystem change includes concurrent writers.
3. Run the separate qualified HZ rewrite with its own source, space, identity, promise and control-plane guards. Its transaction, cancellation and exact writer restoration belong to that operator.
4. Run `python3 "$P" restore --ssh --run-dir "$RUN" --restore-reserve-bytes "$MD4_RESERVE"`. The operator builds each missing mesh privately on md4, reopens and hashes it, restores original modes, owners, xattrs and nanosecond modification times, and publishes the directory atomically. A later genuine cache hit can retain its newer last-use time. Regenerated conflicting entries stay at their live names. Their original checksum-verified ZIPs remain available, the receipt identifies conflicts, and other entries are restored. Keep the independent parking copy through final normal reader verification.

The source fence checks the actual installed mesh preparation and recovery functions. It derives a conservative set of reachable keys for each live task from the ordinary geometry, flow and mesher implementations, including finite-edge and alternate recovery meshes. The HZ Celery master deselects its one task queue. Its scheduled, reserved and active requests are checked again in that order. Existing jobs continue in their prefork processes. A selected reachable key, an unclassified task, an external open file, or an unknown results-volume consumer vetoes the switch. During the last inode check and atomic directory renames the operator stops only the bound Celery master, using its PID file descriptor. OpenFOAM processes, Node report delivery and the engine API continue running. The hard fence expires in 12 seconds. A separate watchdog restores the exact original queue binding on foreground failure.

A private hold on md4 keeps original directories across an interrupted switch. The prepared manifest, retirement intent and completed-switch receipt distinguish resumed work from an unrelated cache miss. Use the same run directory to retry or restore. If reader recovery is outstanding, run `python3 "$P" recover-readers --ssh --run-dir "$RUN"` first. Recovery checks the original engine and Celery process identity. Preserve all run files and both generations if they differ.

### Qualification

The `hz-cache-parking` check graph exercises two actual filesystems and the normal engine mesh reader, cache traffic during a lookup, replacement-generation preservation, archive corruption, interrupted directory moves, low space, real prefork admission and forced operator death. A disposable PostgreSQL 16 case rebuilds a real report-shaped table, compares every row fingerprint, and measures an incremental TOAST-shaped btree under interleaved value IDs and ascending chunk sequences.
