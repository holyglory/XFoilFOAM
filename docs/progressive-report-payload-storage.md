# Lossless progressive report payload storage

## Full report history and automatic compaction

Migration `0200` adds immutable report archive bundles and members. On the hub,
the sweeper writes completed remote report histories as gzip JSONL bundles to
the configured `AIRFOILFOAM_EVIDENCE_BUCKET`. It verifies the generation,
metadata, compressed byte size and SHA-256 by reading the object back before
compacting the PostgreSQL report body.

The PostgreSQL row retains the execution id, sequence, signature, report
identity, inventory, source rows, custody rows and the GCS archive pointer. The
full report is removed from the row only after the archive member catalog is
durable. Worker copies on `hz-solver2` are compacted after their report has been
acknowledged by the hub and every evidence point is represented by a hub receipt
or a terminal delivery conflict. The remote solver has no GCS credentials and
does not receive any.

The retention service runs this process continuously. It selects only terminal
executions with a completed ingestion stamp, an expired or cancelled promise,
no live ingest lease and a verified stop report. Active reports and unresolved
evidence remain inline. Report result payloads are deleted only after no report
row references them.

The existing retained-report download route reads archived members from the
generation-pinned GCS bundle, so compaction does not remove the exact report
download or its signature verification. PostgreSQL `VACUUM FULL` is a separate
operator action after the archive backlog is drained. The archive process never
deletes solver result attempts, accepted polar points, evidence archives or
custody metadata.

Report history remains intact: sequence numbers, content signatures, creation and
receipt timestamps, acknowledgements, inventories, source associations, and their
foreign keys retain their existing identities. This implements architecture
decision `nc641c0a4dcbe8649`; the prohibition on report-history deletion in
`ne4afd84a6954d73a` still applies.

Migration `0198` adds an immutable, content-addressed
`public.progressive_report_result_payloads` table and a nullable
`result_payload_hash` foreign key on each report table. A normalized report keeps
its entire envelope and a result object containing only its original `state`
member (or an empty object when that member was absent). The referenced payload
contains the complete original result, including unknown fields. JSON null and
an absent root `result` remain distinct, inline, and unreferenced.

Payload digests and byte sizes describe PostgreSQL's UTF-8 JSONB text. They are
storage identities, separate from the original transport content signature.
Checks enforce the payload digest, byte size and object type; UPDATE/DELETE
triggers forbid changing payloads. Report UPDATE guards admit only a lossless inline to
referenced transition whose reconstructed JSONB equals the old report, with the
original content signature and immutable columns unchanged. Existing worker
acknowledgement rules remain in force.

## Reading and writing

Full-body reads use:

```sql
SELECT public.resolve_progressive_report(to_jsonb(report.*)) AS report,
       report.content_signature
FROM progressive_remote_reports report
WHERE report.sim_job_id = $1 AND report.sequence = $2;
```

Always use `alias.*`: `to_jsonb(report)` can bind the JSON column named `report`
instead of the whole row. The row overload supports legacy temporary fixtures
without the nullable reference column. Payload lookups and writes always use the
canonical `public` table, with a fixed function search path; a temporary payload
table cannot redirect them. Missing payloads and mismatched headers raise errors.
The two-argument overload accepts `(envelope, result_payload_hash)` directly.
Resolving functions are VOLATILE so same-statement payload insertion and guarded
representation conversion can see their own writes.

Scalar predicates continue to use the raw envelope. In particular, status,
identity, stop proof, `jsonb_typeof(report->'result')`, and `{result,state}` retain
their existing partial-index semantics. A selector first chooses bounded keys;
only its final body fetch reconstructs a result. Promotion recovery groups
referenced payload hashes before reconstruction, keeps the earliest report
sequence for each result, and still detects competing promotion scopes. No
promotion fields are read from the compact header.

The existing worker and hub writers still validate the complete transport report
and derive its original signature before INSERT. Their database INSERT trigger
normalizes only when the singleton storage switch is enabled. No API returns a
compact header in place of a full transport report.

## Reader audit and integration boundary

Full bodies are resolved in these production source files:

- DB: `progressive-worker-reports.ts`, `progressive-remote-reports.ts`,
  `progressive-remote-evidence.ts`, `progressive-remote-retention.ts`,
  `progressive-stopped-storage.ts`, `progressive-current-evidence-reuse.ts`,
  `progressive-ingestion-ownership-recovery.ts`,
  `progressive-publication-recovery.ts`, `progressive-cfd-recovery.ts`, and
  `retained-solver-reports.ts`.
- Sweeper: `progressive-delivery-selection.ts`, `progressive-evidence-reuse.ts`,
  `progressive-remote-jobs.ts`, `progressive-remote-observation.ts`,
  `progressive-remote-progress.ts`,
  `progressive-remote-settlement.ts`, `progressive-remote-stop-receipt.ts`,
  `progressive-worker-evidence.ts`, `progressive-worker-evidence-delivery.ts`,
  and `progressive-worker-outbox-replay.ts`.

These source files use only scalar envelope/identity/receipt state and stay raw:
`solver-reservations.ts`, `progressive-remote-inventory.ts`,
`progressive-remote-delivery.ts`, `progressive-numerics-transition.ts`,
`progressive-cfd-settlement.ts`, `progressive-storage-evidence-recovery.ts`,
`progressive-remote-stale-recovery.ts`, `progressive-evidence-wake.ts`,
`progressive-inactive-promise.ts`, `progressive-remote-admission.ts`,
`progressive-remote-reconciliation.ts`,
`progressive-archive-reclaim.ts`, `progressive-staging-selection.ts`,
`progressive-publication-selection.ts`, `progressive-progress-selection.ts`,
`progressive-stopped-storage.ts` (the sweeper file), and API `sync-routes.ts`.
API retained-report downloads call the reconstructed DB reader; artifact serving
uses stable evidence identities and stored artifacts.

**Parent integration required before activation:** in the separately owned
`apps/sweeper/src/progressive-restart-retention.ts`, replace the bounded lateral
projection `SELECT sequence, report FROM progressive_worker_reports` with
`SELECT sequence, public.resolve_progressive_report(to_jsonb(progressive_worker_reports.*)) AS report FROM progressive_worker_reports`.
Keep its scalar selection predicates raw. This patch intentionally leaves that
file, `retention-service.ts`, `retention.ts`, and their tests untouched. The
existing `retention.ts` report query uses only pending acknowledgement identity.

Deployment scripts' report-index completion, remote-engine maintenance guards,
and the backpressure diagnostic use only metadata. The reset classifier treats
payloads as solver/transport evidence and preserves the storage switch as
execution metadata. No reset is part of this change. The legacy report-pruning
function and CLI remain disabled.

## Staged rollout and rollback

1. Apply `0198`. `progressive_report_storage_policy.normalization_enabled`
   defaults to false. Existing inline writers remain valid and unchanged.
2. Upgrade **every** reader, including the parent-owned restart-retention read
   above, across the hub and remote workers. Verify mixed reads, transport
   signatures, evidence delivery, terminal settlement and retained downloads.
   The parent may stop writers to make this cutover atomic.
3. Only after that proof, explicitly activate normalized writes. There is one
   switch, shared by both report tables:

   ```bash
   corepack pnpm --filter @aerodb/db backfill:progressive-report-payloads --apply --enable-writes --readers-ready --stats-only
   ```

4. Check a real new execution, bounded to its latest reports:

   ```bash
   corepack pnpm --filter @aerodb/db backfill:progressive-report-payloads --table=worker --verify-execution=EXECUTION_UUID --rows=16
   ```

   Use `--table=remote` on the hub. The command reconstructs and validates each
   full report against its immutable execution envelope and original signature.
   It reports checked/normalized counts; an empty sample is not signature proof.
5. Review a dry-run batch, then apply bounded batches:

   ```bash
   corepack pnpm --filter @aerodb/db backfill:progressive-report-payloads --table=worker --rows=16
   corepack pnpm --filter @aerodb/db backfill:progressive-report-payloads --table=worker --apply --rows=16 --batches=100 --max-bytes=67108864
   ```

   Resume from the printed `resumeAfter` using `--after-worker=UUID:SEQUENCE`
   or `--after-remote=UUID:SEQUENCE`. Each transaction limits scanned rows and
   logical bytes, locks with SKIP LOCKED, and pins the cursor before a locked
   hole. A row larger than the byte budget refuses rather than silently advancing.
   Every converted row retains a SQL equality/readback SHA-256 proof and original
   content signature. Repeating a completed batch is safe. The command defaults
   to dry run and never deletes a report or invokes VACUUM.

Before activation, legacy service rollback is safe. After any normalization,
keep reconstructing readers installed until the bounded reverse migration has
finished and the canonical zero-reference proof passes:

```bash
corepack pnpm --filter @aerodb/db backfill:progressive-report-payloads --apply --disable-writes
corepack pnpm --filter @aerodb/db backfill:progressive-report-payloads --restore-inline --rows=16
corepack pnpm --filter @aerodb/db backfill:progressive-report-payloads --restore-inline --apply --rows=16 --batches=100 --max-bytes=67108864
corepack pnpm --filter @aerodb/db backfill:progressive-report-payloads --prove-inline
```

Resume reverse batches using the same printed per-table cursors as forward
batches. Restoration requires the switch to remain disabled. It expands the
exact original JSONB and clears only `result_payload_hash`; the reverse guard
requires equality to the old reconstructed report. Signatures, sequence,
acknowledgements, timestamps, foreign-key owners and payload rows stay intact.
The same logical-byte budget, locks, pinned cursor and equality/digest readback
proof apply in both directions. Restoring inline bodies needs their storage
capacity; keeping the new readers installed remains a valid rollback boundary.

`--prove-inline` scans reference metadata in **both canonical tables** without
loading payload bodies. It prints each remaining reference count and
`oldReaderRollbackSafe`; its exit code is nonzero unless normalization is disabled
and both counts are zero. A bounded sample or a completed batch is insufficient.
Only that zero-reference proof permits rolling back to old readers. Turning off
new normalization alone does not make normalized history readable by old code.
No step deletes reports, payloads or evidence.

## Storage measurement

Every backfill invocation prints bounded before/after samples with logical
result/report bytes, envelope bytes, normalized counts, report relation size and
shared-payload relation size. For an explicit complete per-table audit:

```bash
corepack pnpm --filter @aerodb/db backfill:progressive-report-payloads --stats-only --full-stats
```

This opt-in audit scans all inline legacy bodies; schedule it deliberately. For
normalized rows, logical result sizes come from immutable payload metadata rather
than decompressing each repeated result. Run before and after conversion and
retain both outputs alongside the per-batch proofs. A completed forward conversion
requires `inline_result_reports` to be zero on both tables; root null and absent
results are intentionally excluded from that count. These are logical storage
measurements, not a claim of OS disk space released. PostgreSQL can reuse pages
freed by UPDATE while the physical relation remains large. Any offline compaction
is a separate guarded parent operation after full migration proof; this CLI never
runs VACUUM FULL.
