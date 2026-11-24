# Lossless progressive report payload storage

## Worker lease reconciliation

The terminal-mirror reconciler selects a worker promise with `p.status='active'`. Every supported writer that sets a worker report's `archive_bundle_id` first requires the same registered worker's **local** promise to be fulfilled, cancelled or expired.

- The ordinary worker archiver checks `promise.status IN ('fulfilled','cancelled','expired')` in `closedScope`. Before writing the pointer, `archiveProgressiveReportBatch` repeats that query with `FOR UPDATE OF job,promise`. Its special cancelled-copy selector accepts only hub reports.
- Legacy registration in migrations 0205 and 0209 selects the source job `FOR UPDATE` and the matching solver, upstream and terminal promise `FOR SHARE`. An ineligible owner is skipped before the member is compacted. Migration 0209 supplies the current definition of `register_legacy_report_archive_custody`.
- Registered hub links from 0221 use `originalState(tx, link, true)` to recheck the terminal worker promise under a share lock. The closed-worker original publisher checks `p.status IN ('expired','fulfilled','cancelled')` in `workerSource` and repeats it under lock before retirement.

Registered assignment intake preserves an existing terminal promise on conflict. Heartbeats renew active owners, and the hub excludes stopped dispatches from its active assignment list. If an externally restored database presents an active owner with a compact source outside this lifecycle, reconciliation retains the lease. The compact header alone cannot establish the original report's evidence obligations.

## Stored reports and automatic cleanup

PostgreSQL keeps polar coefficients, report sequence numbers, signatures, rejection reasons and the records that tie a measured angle to its source. A completed execution can contain several angles. Cleanup checks each report's evidence before removing its full body from the database.

The hub archives reports from its own dispatch records. HZ uploads through the registered solver's authenticated connection to the hub. The hub owns the Google Cloud Storage credentials. An outbox acknowledgement can also mean the hub rejected a delivery. Each compacted report therefore has its own archive member, exact body digest and immutable object generation.

The sweeper processes bounded batches. It reads the full PostgreSQL JSON text, including explicit nulls and full-precision numbers. Consecutive snapshots with a long identical prefix or suffix store the shared text once in their gzip JSONL bundle. The writer reads the uploaded generation through to the end and verifies its compressed digest and member contents. A database transaction compares the original body to the verified archive member before replacing the body with its lookup metadata. Transient storage errors leave the original available for retry.

HZ also reopens the report through its own reader. When the hub disables evidence downloads, HZ keeps one compressed working copy per object on its persistent results volume. The sweeper flushes the file and its directory to disk, reads it back and verifies it against the cloud receipt before shortening the database row. Both the worker API and the sweeper can then read the original samples. GCS credentials stay on the hub.

A rejected delivery that contains the exact worker report can share that report's body immediately. The database compares their bytes, keeps the separate reason for rejection, and protects the reference to the original. Existing duplicate rejections are processed in batches. A rejection with different content retains its own body.

Retained-report downloads and historical solver reads use the execution ID, sequence and signature to restore the selected report. Live jobs and reports still needed for evidence delivery remain available during the transfer. Result or campaign resets have separate operator workflows. PostgreSQL can reuse pages freed by an update. Measure relation sizes and filesystem free space separately when returning space to the host.

Repeated live polls reuse the previous report when only the observation timestamp changes. A change in solver progress, coefficients, histories or stop evidence creates a new report.

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

Restart-retention reads of complete worker reports use
`public.resolve_progressive_report(to_jsonb(progressive_worker_reports.*))` and
the installed archive reader for archived bodies. Scalar selection predicates
remain raw. The `retention.ts` report query uses only pending acknowledgement
identity.

Deployment scripts' report-index completion, remote-engine maintenance guards,
and the backpressure diagnostic use only metadata. The reset classifier treats
payloads as solver/transport evidence and preserves the storage switch as
execution metadata. Storage normalization does not require a reset. The legacy report-pruning
function and CLI remain disabled.

## Settled status reports

After migration 0235, the ordinary report-storage worker on each role can shorten
an older running-status header whose exact report already resides in a verified
archive. The PostgreSQL delivery row keeps its execution, sequence, signature,
original timestamps, archive bundle and member. Its JSON keeps the signed owner
and assignment identifiers, null result and stop, and the status job ID, state,
total cases and completed cases. The full message, phase, scheduling data and
all original bytes remain available through the existing stable-ID reader.

The worker considers a status only after a later report exists for that owner.
The job must be terminal and ingested, the scheduling promise closed, and
execution stop independently recorded. The hub checks its dispatch, solver,
signed empty point inventory and progress acknowledgement. HZ checks its own
registration, assignment and upstream promise, worker acknowledgements, final
stop evidence and outstanding delivery obligations. A null result, zero completed
cases and ordinary engine progress message are required. The worker retains
terminal, latest, scientific or diagnostic reports, unknown status fields,
conflicts and their source rows, and reports that own receipts, staging or a
shared scientific source. It also checks the full original for exhausted solver
budgets and scheduling diagnostics that the earlier header omitted.

The stable-ID materializer authenticates the original PostgreSQL text, digest,
size, signed content and pinned generation before taking write locks. Existing
worker access rules apply, including HZ's verified working volume when general
downloads are disabled. The SQL trigger checks the archived identity, hashes the
original text, compares its prior header and rechecks the settled owner while
holding short locks. A failed read, changed owner, busy publisher or mismatched
proof leaves the report available in its prior representation.

| Consumer | Contract preserved |
| --- | --- |
| Ordered publication, acknowledgement, duplicate and late deliveries | The original primary key, signature, assignment and progress receipt survive. The latest report retains its prior header. Duplicate sends and order checks use their existing stored keys and exact materializer. See [remote publication](../packages/db/src/progressive-remote-reports.ts) and [worker publication](../packages/db/src/progressive-worker-reports.ts). |
| Stop, restart, incremental ingestion and recovery | The real terminal stop, latest row, unfinished jobs, active delivery owners and interpreted diagnostics stay intact. Full-body replay reopens the signed original. See [stop handling](../apps/sweeper/src/progressive-remote-stop-receipt.ts) and [outbox replay](../apps/sweeper/src/progressive-worker-outbox-replay.ts). |
| Frozen archive membership, conflict aliases and registered reuse | Member kind, row and report hashes, signatures, object generation and working-volume identity survive. FK targets keep the same row. Separate conflict and scientific dictionary owners remain protected. See [legacy custody](../packages/db/src/legacy-report-custody.ts) and [registered reads](../apps/sweeper/src/registered-worker-report-read.ts). |
| Scientific evidence, selection, fits and HTTP downloads | Result and attempt owners, evidence receipts and scientific anchors keep their original identities. The retained-science route continues to require a point source. Stable report reads still return the exact status original even when it has no point. See [retained science](../packages/db/src/retained-solver-reports.ts) and the [report reader](../packages/db/src/progressive-report-reader.ts). |

Each discovery turn examines up to 128 archive keys and starts at most eight
member reads totalling at most 1 MiB of original report text. Existing object
reader limits apply separately to the packed archive. The worker yields to a
due archive or copy after its current member and advances a role-specific cursor
in `progressive_status_header_cursors`. It revisits held and newly archived
members on subsequent sweeps. A restart reuses that cursor. An interrupted
update or repeat cannot reduce the same header twice.

To verify a rollout, record a settled nonlatest sequence and its member
signature, generation, original report digest and `pg_column_size(report)`.
Read it through the ordinary role-specific reader before and after the worker's
turn. Compare the entire original, delivery identity and any related receipt.
Also check a latest, unsettled or diagnostic sequence retains its old header.
The worker records committed PostgreSQL field bytes removed. Heap and index
allocation, dead tuples and filesystem free space require separate measurement.
Older archive-capable readers use the same stable identity. A worker rollback
can stop further reductions without expanding existing headers.

## Staged rollout and rollback

1. Apply `0198`. `progressive_report_storage_policy.normalization_enabled`
   defaults to false. Existing inline writers remain valid and unchanged.
2. Upgrade **every** reader, including the restart-retention read
   above, across the hub and remote workers. Verify mixed reads, transport
   signatures, evidence delivery, terminal settlement and retained downloads.
   Stop writers when needed to make this cutover atomic.
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
is a separate guarded maintenance operation after full migration proof; this CLI never
runs VACUUM FULL.

## Native sharing for closed HZ report histories

The HZ report-storage worker can share repeated historical results locally while the archive transfer proceeds. Each original report keeps its own sequence, content signature, status, stop proof, and acknowledgement. Its 0198 foreign key protects the full result in PostgreSQL. This operation sets no archive pointers and changes no scientific, dispatch, promise, or delivery records.

Discovery uses the worker report index to seek one execution and at most 129 sequence keys per call. The default looks for inline report values of at least 256 KiB, selects up to eight rows, and limits the selected stored values and matching expanded binary prefix to 96 MiB. The walker can inspect one boundary value to detect a mismatch or a byte limit. It stops before that row. At a page boundary, a single trailing report can reuse its immediately preceding protected result after an exact comparison. A different singleton stays inline. The ordinary per-row backfill remains available for explicit scope or restoration.

Applications require enabled 0198 normalization, a terminal ingested worker job, a closed promise, stopped execution evidence, acknowledged reports, and an available ingestion lease. Job/promise and report row locks cover the transaction. A locked sequence leaves the prefix uncommitted. A statement timeout preserves the cursor. The automatic worker retries with smaller batches down to two rows, then revisits the job on a later sweep. PostgreSQL compares exact JSONB images, including numeric scale, and reconstructs every original full report from the newly written reference. The ordinary full-report reader independently verifies the anchor's original signature before commit. The writer rolls back the whole prefix on failed readback or nonpositive measured value savings.

### Bounded operator step

The installed backfill CLI accepts `--native-prefix` on HZ. It defaults to a dry run. Use `--execution=UUID` to restrict it to one job or omit that option for ordered discovery. `--after-worker=UUID:SEQUENCE` continues within a job and `--after-worker=UUID:end` continues past it. `--rows`, `--batches`, `--max-bytes`, and `--min-stored-bytes` bound an invocation. Preserve `after` from the last acknowledged result. A retry reads the current representation before writing.

An existing HZ sweeper with the 0198 schema and full-report reader can run the same step before installing new application code. From the checked release on the operator host, emit the bounded CLI to a private file. Supply the active private cohort's frozen scope and the existing SSH/container names.

```bash
set -euo pipefail
umask 077
: "${PRIVATE_NATIVE_SCOPE:?path to the active private native-sharing-scope.json}"
: "${HZ_SSH_HOST:?existing HZ SSH alias}" "${HZ_SWEEPER_CONTAINER:?existing HZ sweeper}"
exclude=$(jq -er '.jobs | keys | select(length>0) | join(",")' "$PRIVATE_NATIVE_SCOPE")
step=$(mktemp)
trap 'rm -f "$step"' EXIT
node scripts/deploy/emit-native-report-prefix.mjs > "$step"
sha256sum "$step"
ssh -T -oBatchMode=yes -oStrictHostKeyChecking=yes "$HZ_SSH_HOST" \
  flock -s -w 5 -E 75 /tmp/airfoils-pro-deploy.lock \
  docker exec -i -w /app/packages/db/src "$HZ_SWEEPER_CONTAINER" \
  node --import tsx --input-type=module - --native-prefix --dry-run \
  "--exclude-jobs=$exclude" --rows=8 --batches=1 < "$step"
```

Use `--apply` for a reviewed write step. Both stdout and the worker log distinguish previewed matches from committed `normalized` and `binaryVerified` counts. The live values measured by `reportValueBytesReduced` are the difference between old report columns and persisted envelopes. `netValueBytesSavedAtLeast` also subtracts new reference-column bytes and conservatively charges all retained payload value columns when prior custody in PostgreSQL was unproven. The receipt binds the shared hash and digest of ordered sequence/signature pairs. Relation and index overhead, dead tuples, WAL and filesystem blocks have separate measurements. `physicalSpaceReleased` is null.

### Automatic discovery after handoff

Use the existing sweeper report-storage process with `AIRFOILFOAM_NATIVE_REPORT_SHARING=true` and `AIRFOILFOAM_NATIVE_REPORT_EXCLUDE_JOBS` set to the comma-separated execution IDs still owned by the private run. The installed CLI also honors this exclusion list. Automatic mode defaults off. It runs one local transaction at a time, independently of cloud I/O, and sleeps five minutes after a sweep. It remembers the inspected sequences of eligible jobs, retaining one boundary row for a later append. On restart it can rediscover from the index and recognize already shared values. Disabling native sharing does not disable normal 0198 writes or full readers.

The `progressive-report-archive` graph check `native-report-prefix` compares the prefix and original per-row algorithm on identical PostgreSQL rows in alternating rollback trials. It checks every full-body digest and exercises ordinary product reads, the portable CLI, locks, exclusions, rollback and replay.

## Closed historical staging copies

Migration 0217 tracks scheduling coverage separately from staging receipts. The automatic HZ backlog drain can cover up to 32 acknowledged, still-online snapshots in one transaction before taking an ingestion lease. It checks closed job and promise ownership, the stop proof, actual source attempt IDs and hub acknowledgements. The ordinary point reuse verifier authenticates the stored projection and evidence. Failed and rejected attempts keep their scientific classifications.

A covered row carries its own content signature, the genuine staged sequence and signature, the SHA-256 and byte size of the complete PostgreSQL result, and the exact point signatures. Each candidate must reconstruct its own canonical signature. Only the sequence and observation clocks may vary, including the elapsed solver seconds for the same budget case. Case membership, execution flags and granted limits remain part of the proof. Changed coefficients, case counts, AoA, failure state, stop proof, or other envelope content follow ordinary staging. A cold source additionally requires its existing 0209 authenticated witness and the normal archive reader. A cold target without prior coverage takes the ordinary path.

The selector and wake queries consult the indexed `progressive_worker_closed_staging_copies(sim_job_id, sequence)` view. A reopened promise becomes eligible again. Removing a genuine source, changing its attempt or setup, introducing a competing association, or withdrawing its hub receipt invalidates coverage. Explicit per-sequence staging and recovery continue to operate on the original full report. Apply 0217 before starting a sweeper that consults the view; the report producer has no new write obligation.
