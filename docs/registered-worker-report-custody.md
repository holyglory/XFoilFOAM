# Reusing a closed worker report's original hub archive

A registered remote solver can keep a native report on its persistent results volume when the hub already archived the identical signed PostgreSQL text. Migration 0221 records the worker identity, the separate hub instance and catalog ID, the original generation and the earlier point receipts. The native report keeps its execution, sequence, content and assignment signatures, and acknowledgement.

The operator runs on the controller. It uses the existing SSH aliases to reach each host independently. Only the hub sweeper reads Google metadata and media. Its workload identity must match the configured account. The HZ node API and sweeper read one fsynced, content-addressed gzip from their shared report volume. Keep this volume mounted across deployment and include the controller in the normal deployment stop/restore list before enabling continuous coverage.

## Admission

Both instances must have the actual closed assignment for the registered worker. The HZ job must have a later stopped report, terminal ingestion, a closed promise, no active ingest lease and all outbox acknowledgements. The candidate has an object result with one or more scientific points, no direct staging receipt, no conflict and a native inline body. Each point must have an earlier HZ staged attempt and a matching hub receipt with the same point signature, source sequence, native and hub result/attempt IDs, case and angle. The hub must have recorded the original report inventory and applied the exact signed sequence. Report retirement retains the earlier point sources, terminal report, publication state and scientific classifications.

The initial format is hub-origin gzip/JSONL. Bounds per operation are 128 members, 32 MiB compressed, 128 MiB decoded JSONL, 32 MiB per original report, 256 MiB across reconstructed members and 512 distinct points in the selected report. The reader verifies the entire compressed object, CRC32C, member bounds, ownership and every reconstructed signature. Scientific inventories use the original number tokens. Native shared results and already-staged reports remain under their existing storage workers.

## Run on the controller

Use a pinned source checkout with workspace dependencies. Confirm the read-capable revision is serving in both roles and that 0221 is installed. The CLI also compares its reader and helper sources with both HZ containers and the hub sweeper. Use the source's frozen-scope JSON to exclude the exact original migration ranges. Give this controller its own private directory.

```bash
umask 077
CLI=apps/sweeper/src/registered-worker-report-cli.ts
COMMON=(--directory="$STATE" --scope="$FROZEN_SCOPE" --hub-account-file="$HUB_ACCOUNT_FILE"
        --hz-host="$HZ_HOST" --hz-api="$HZ_API_CONTAINER" --hz-sweeper="$HZ_SWEEPER_CONTAINER"
        --hub-host="$HUB_HOST" --hub-sweeper="$HUB_SWEEPER_CONTAINER")
ONE=(one "${COMMON[@]}" --job="$EXECUTION" --seq="$SEQUENCE" --signature="$REPORT_SIGNATURE")

node --import tsx "$CLI" "${ONE[@]}"
node --import tsx "$CLI" "${ONE[@]}" --apply
node --import tsx "$CLI" "${ONE[@]}" --apply
```

The first invocation checks native bytes, restores the existing generation via the hub, and writes a private plan receipt on the controller. Applying stores the compressed object on HZ and registers the immutable link while the native row is warm. The HZ API-container reader and sweeper reader must return exact original bytes before the guarded 0202 update. Both then reopen the committed native report through the normal product registry. A successful repeat reports `already_retired`. The per-member receipt records the two actual reads, the generation, sizes and hashes. Each HZ write command holds the shared host deployment lock and each SQL write transaction rechecks the registered transfer fence.

```bash
node --import tsx "$CLI" pass "${COMMON[@]}" --apply --max-pages=1
node --import tsx "$CLI" watch "${COMMON[@]}" --apply
```

Each page inspects at most 128 catalog keys. One controller owns the directory lock. The cycle advances by ordered hub execution/sequence, processing one member at a time. A completed cycle revisits the catalog for new archives and new receipts. The local checkpoint binds the two instances, registered solver, SSH hosts, canonical account and frozen scope. The controller fsyncs the selected member and origin before transfer. On a lost reply, it repeats the exact generation and rechecks SQL and both readers before advancing. The watch backs off on transport, deployment and transfer pauses. A changed owner, generation, or checksum holds the pending record for inspection. SIGTERM finishes the current bounded operation or leaves that record for the next start.

## Verify and recover

From HZ, count actual native pointers where the local report and immutable link agree with the catalog. This query also counts staged links awaiting a native pointer.

```sql
SELECT count(*) AS registered_links,
       count(*) FILTER (WHERE b.id IS NOT NULL) AS native_pointers,
       count(*) FILTER (WHERE r.archived_at IS NULL) AS registered_still_warm,
       coalesce(sum(m.report_byte_size) FILTER (WHERE b.id IS NOT NULL), 0) AS original_text_bytes
FROM progressive_worker_hub_report_links l
JOIN progressive_worker_reports r USING (sim_job_id, sequence)
LEFT JOIN progressive_report_archive_members m ON m.bundle_id = r.archive_bundle_id
 AND m.source_kind = 'worker' AND m.sim_job_id = l.sim_job_id AND m.member_kind = 'report'
 AND m.sequence = l.sequence AND m.content_signature = r.content_signature
 AND m.report_sha256 = l.read_identity->>'reportSha256'
LEFT JOIN progressive_report_archive_bundles b ON b.id = m.bundle_id AND b.source_kind = 'worker'
 AND b.sim_job_id = l.sim_job_id AND b.bucket = l.read_identity->>'bucket'
 AND b.object_key = l.read_identity->>'objectKey' AND b.generation = l.read_identity->>'generation'
 AND b.stored_sha256 = l.read_identity->>'storedSha256' AND r.archived_at IS NOT NULL;
```

`original_text_bytes` measures original PostgreSQL text. Actual table and filesystem space require separate measurements. With a missing working file, repeat the exact `one --apply` command to restore it from the pinned hub generation. A corrupt same-name file is held for inspection. Preserve the damaged bytes before an operator-directed repair. An upstream-only cleanup probe retains linked files because registered general downloads may be disabled. Before rolling back either HZ reader, check the native pointer count and use a release capable of reading every existing reference.
