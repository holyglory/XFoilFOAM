# Legacy worker report migration

This operator tool backs up a frozen set of historical worker reports and
normalizes their repeated result bodies with migration 0198. It preserves full
query/replay identities. It never creates a dispatch, claim, scientific result,
polar, or permission grant. `copy` remains an independent read-only export mode.

The controller uses its existing SSH aliases to the worker and hub. The worker
export reader uses read-only PostgreSQL transactions over one reused SSH session.
An explicitly selected `migrate` operation opens a separate operator SQL channel
for guarded representation changes. GCS upload/readback runs through the hub's
existing sweeper container and canonical metadata workload identity. The hub
does not SSH to the worker; no private key, cloud token, ADC file, or worker
credential is transferred. No helper installation or service restart is needed.

## Configure an operation

Run from a checkout with dependencies installed. Supply nonsecret targets and
an existing frozen JSON scope. Pin the canonical service account supplied by
normal deployment configuration; do not substitute an operator ADC identity.

```bash
cd "${XFOILFOAM_CHECKOUT:?set the checkout path}"
: "${LEGACY_REPORT_SCOPE:?set the frozen scope JSON path}"
: "${LEGACY_REPORT_PROGRESS:?set a private progress directory}"
: "${HZ_SSH_HOST:?set the existing worker SSH alias}"
: "${HZ_POSTGRES_CONTAINER:?set the existing worker PostgreSQL container}"
: "${HUB_SSH_HOST:?set the existing hub SSH alias}"
: "${HUB_SWEEPER_CONTAINER:?set the existing hub sweeper container}"
: "${HUB_EVIDENCE_BUCKET:?set the configured evidence bucket}"
: "${HUB_SERVICE_ACCOUNT:?set the canonical hub workload service account}"

legacy_reports() {
  corepack pnpm --filter @aerodb/sweeper exec tsx src/legacy-report-storage-cli.ts "$@"
}
legacy_targets=(
  "--ssh-host=$HZ_SSH_HOST" "--container=$HZ_POSTGRES_CONTAINER"
  "--hub-ssh-host=$HUB_SSH_HOST" "--hub-container=$HUB_SWEEPER_CONTAINER"
  "--bucket=$HUB_EVIDENCE_BUCKET" "--hub-service-account=$HUB_SERVICE_ACCOUNT"
)
legacy_hub=(
  "--hub-ssh-host=$HUB_SSH_HOST" "--hub-container=$HUB_SWEEPER_CONTAINER"
  "--bucket=$HUB_EVIDENCE_BUCKET" "--hub-service-account=$HUB_SERVICE_ACCOUNT"
)
```

Scope version 1 contains `sourceInstance`, `solverId`, `measuredAt`, and sorted
`executions`. Each execution records `executionId`, measured `reports`,
`reportHighWater`, `conflicts`, and `conflictHighWater`. Optional `reportAfter`
selects a bounded suffix for a canary. Source instance and solver identities
must come from the actual deployment/registration. Missing hub reports or
missing dispatches do not create an ownership assertion.

For a future cohort, `inventory-sql --side=worker|hub --rows=N --after=UUID`
prints bounded metadata-only inventory SQL. Run every page through the existing
owner read-only paths. `make-scope` accepts complete sorted worker/hub JSONL
inventories, source instance, registered solver ID and measurement timestamp.
It excludes IDs with either hub reports or dispatches. Optional
`--expected-executions=N` and `--expected-reports=N` are explicit audit checks;
measured cohort counts are never universal defaults. Keep private measurements
and immutable object identities in the operation's receipts.

## Canary and bulk migration

For historical scientific duplicates, use the [0209 one-page canary](legacy-report-0209-canary.md).

For a one-execution, one-page canary, use a separate scope selecting its exact
measured interval and a new progress directory. `CANARY_REPORT_ROWS` is the
number of selected reports, not an invented count of contiguous sequence IDs.

```bash
legacy_reports migrate "${legacy_targets[@]}" \
  --scope="${LEGACY_CANARY_SCOPE:?set the one-execution scope}" \
  --directory="${LEGACY_CANARY_PROGRESS:?set a separate progress directory}" \
  --rows="${CANARY_REPORT_ROWS:?set the measured interval count}" \
  --pages=1 --max-bytes=268435456 --readers-ready --apply
```

A byte limit can stop a page before its row limit. A successful page is not a
claim that the whole scope is exhausted. Repeat the command to resume; an exact
row-count boundary can require a final metadata-only page. Omitting `--apply`
prints the operation plan without network or disk mutation.

The bulk command applies bounded pages until its invocation limit, saving
progress after every verified and normalized page:

```bash
legacy_reports migrate "${legacy_targets[@]}" \
  --scope="$LEGACY_REPORT_SCOPE" --directory="$LEGACY_REPORT_PROGRESS" \
  --rows=16 --pages=32 --max-bytes=67108864 --readers-ready --apply
```

Repeat this exact bounded command until `complete: true`. Each repetition is
safe after a lost connection or process termination. There is no automatic
unbounded retry loop. A failed operation stops at retained pending material.

Before applying, 0198 and all upgraded full-body readers must be installed and
its normalization policy must already be enabled. `--readers-ready` records
that operator prerequisite; it does not bypass the server policy check or turn
normalization on. The operation performs exact generation-pinned GCS readback,
syncs an archive receipt, executes guarded 0198 SQL, saves its normalization
proof, syncs progress, and only then drops its pending transfer bytes.

PostgreSQL locks exact report rows and compares the original signature, full
JSONB digest and size with the verified archive. It reuses
`store_progressive_report_result` and the existing immutable representation
guards, then verifies the reconstructed body and every other storage column.
A changed or missing member rolls back the page. Lost acknowledgement after
commit is safe: the same frozen page is authenticated and reapplied
idempotently. A second SQL readback records actual report/payload identities. Where registered
GET is known to be denied, add `--registered-get=denied`; otherwise the receipt
records `unproven`. This flag records eligibility only. Both cases select local
0198 sharing and record `coldBodyDeleted: false`; neither grants cold access.

## Adopt existing copy-only progress

Use `migrate --adopt-copy` with the same frozen scope, targets, and progress
directory previously used by `copy`. It verifies receipt coverage through the
saved copy cursor, normalizes those verified pages first, and only then changes
the checkpoint to its distinct migrate binding. New pages then follow the
normal integrated path. The original copy checkpoint is retained as an
immutable adoption artifact.

```bash
legacy_reports migrate "${legacy_targets[@]}" \
  --scope="$LEGACY_REPORT_SCOPE" --directory="$LEGACY_REPORT_PROGRESS" \
  --rows=16 --pages=32 --max-bytes=67108864 \
  --adopt-copy --readers-ready --apply
```

Adoption is bounded to 32 pending receipts per invocation. For a larger already
copied prefix, run the companion below in bounded passes until `remaining: 0`,
then repeat `migrate --adopt-copy`. Missing prefix receipts refuse adoption;
it never advances over unverified or unnormalized work.

```bash
legacy_reports migrate-receipts "${legacy_targets[@]}" \
  --scope="$LEGACY_REPORT_SCOPE" --directory="$LEGACY_REPORT_PROGRESS" \
  --pages=32 --readers-ready --apply
```

The companion consumes receipt-only pages, restores the exact GCS generation
into bounded memory, executes the same guarded SQL, and saves per-receipt
normalization proof. It does not require local gzip files or manual per-page
SQL. Completed receipt proofs make further passes restartable. If a later,
explicit rollback restores inline bodies, use a new normalization operation
rather than treating old completion receipts as current proof.

For backup without source writes, substitute `copy` for `migrate` and omit
`--readers-ready`. Copy and migrate checkpoints cannot be silently interchanged.

## Storage and losslessness

Each member retains original PostgreSQL storage-row text, complete resolved
report text, original content signature, execution/sequence, SHA-256 digests,
and byte sizes. Unknown fields, large integers, precise decimals, null versus
absent, timestamps and conflict reasons retain their stored JSONB bytes. The
database did not retain original HTTP whitespace; a JSONB storage digest is
separate from the original transport signature.

Conflict bodies resolve through `progressive_worker_conflict_storage` and the
0198 resolver. Existing `body_source_sequence` aliases therefore preserve the
full worker source body, even after normalization, alongside the original
conflict row. Missing or already cold sources refuse export instead of backing
up a compact header as a complete report.

New pages share SHA-256-addressed byte chunks across repeated result bodies.
Reconstruction concatenates original UTF-8 bytes and verifies every complete
row/report digest, without numeric JSON reserialization. Earlier full-text
legacy bundles remain readable. Per-page deduplication does not imply global
cross-page object deduplication; 0198 provides reusable local result sharing.

GCS keys are content addressed below `legacy-worker-reports/v1/`. Upload uses
`ifGenerationMatch=0`; existing keys are read and checked instead of overwritten.
Verification reads the exact recorded generation to EOF and checks metadata,
compressed size/hash, and all decoded members, following the
[Objects insert](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert)
and [Objects get](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get)
contracts. Authentication uses the existing
[metadata workload identity](https://docs.cloud.google.com/compute/docs/access/authenticate-workloads).

By default there is one pending gzip transfer page, not a retained copy of every
body on the controller. Receipt/progress metadata remains. `--keep-local` is an
explicit diagnostic opt-in and should be omitted for bulk migration. Pending
bytes survive failure after upload or normalization. Recovery authenticates
those bytes against the exact remote generation before completing progress and
cleanup. Corrupt or unrecoverable material is preserved and blocks further
capture. Kernel `flock` ownership releases on process death.

Defaults are 16 rows, 64 MiB of combined original-row/resolved-report bytes per
page, and one page per invocation. Limits are 128 rows, 256 MiB per decoded
page, 512 MiB archive JSON, and 32 pages per invocation. Oversized individual
rows refuse at their cursor and require an explicitly larger allowed budget
or a separately reviewed streaming path. Source statements have a 30-second
limit, 2-second lock limit and 45-second transport limit. Metadata calls use
5 seconds; storage requests 120 seconds; helper SSH 600 seconds; an operator
SQL page 120 seconds. No source, result or payload deletion is performed.

## Verify, recover and exact member reads

Set `LEGACY_REPORT_RECEIPT` to one saved archive receipt:

```bash
legacy_reports verify "${legacy_hub[@]}" \
  --scope="$LEGACY_REPORT_SCOPE" --receipt="$LEGACY_REPORT_RECEIPT"

legacy_reports recover "${legacy_hub[@]}" \
  --scope="$LEGACY_REPORT_SCOPE" --receipt="$LEGACY_REPORT_RECEIPT" \
  --output="${LEGACY_RECOVERY_FILE:?set a new absolute gzip path}"
```

Recovery never overwrites an existing file. `extract` accepts a local `--archive`
or the hub options above and selects `--kind=report|conflict --execution=UUID
--sequence=N`. It emits only that original full report; `--row` emits its original
storage row. This operator read does not grant a registered solver permission.

Reusable inspection is exported from `@aerodb/db/legacy-report-storage-codec`:
`inspectLegacyPage`, `decodeLegacyPage`, and `readLegacyPageMember`. The latter
requires the exact compressed identity, source/solver/scope, member key,
original content signature, and member digest/size. It checks the entire bundle
and returns one member. A caller must first authenticate the exact immutable
object grant and pin its download generation.

The integrated page hook is
`applyVerifiedPage(restoredPage, receipt, receiptFile, verifiedPackedBytes)`: exact readback and a
durable archive receipt precede it; checkpoint and pending removal follow it.
A separately verified custody registration/compaction implementation may use
this boundary. Before 0205 compaction, stream those exact verified compressed
bytes through the existing controller-to-worker SSH session into the installed
worker sweeper command:

```text
node --import tsx /app/apps/sweeper/src/worker-report-volume-cli.ts store SHA256 BYTE_SIZE
```

The arguments come from the verified packed object identity; stdin is that
packed byte buffer. Require the volume command's fsync/read/hash receipt, then
verify every member and replay through the real worker reader before custody
SQL can compact a source body. Retain the last locally accessible working copy.
An absent volume CLI, unavailable reader, failed member/replay check, denied
registered GET without a proven local reader, or missing terminal safety proof
keeps the operation on 0198. Neither an operator GCS read nor upload permission
proves registered GET eligibility. No endpoint or permission-config bypass is
part of this path. Until a permitted worker GET or the existing-volume reader, plus terminal evidence safety, are proven for a
page, the supported migration path keeps 0198 payloads local. It never marks
such rows cold, changes archive pointers/acknowledgements, or relies on the
normal registered broker being able to restore missing-dispatch history.
Non-aliased conflict bodies remain inline; existing aliases keep resolving.

The 0198 fallback adds no migration or journal entry. Optional 0205 custody
requires its separately maintained migration and reader rollout before compaction.
This tool does not edit shared archive services, existing brokers/readers, schema.ts,
sync permission or dispatch.
0198 normalization removes live repeated result bodies and lets PostgreSQL
reuse pages; physical OS reclamation is a separate operation. Bucket retention
and lifecycle policy are unchanged. Missing remote generations fail explicitly
while application readers retain their local 0198 data.

## Verification

Run `pnpm --filter @aerodb/sweeper exec vitest run
test/legacy-report-storage.test.ts` through the normal governed test graph. The
check requires `LEGACY_REPORT_STORAGE_DISPOSABLE_DB=1` and an empty disposable
PostgreSQL database; it refuses preexisting report tables and loads real 0198
functions and the 0203 source-resolution view. Coverage includes exact
normalization/reversal, aliases, dedup reconstruction, bounds, copy adoption,
missing receipt coverage, lost commit acknowledgement, pending recovery,
cleanup ordering, and exact-member rejection. No separate TOML template is
shipped. Static verification is `pnpm --filter @aerodb/sweeper exec tsc --noEmit`.

Telemetry separates work from data removal. `operation` identifies copy versus
migration; `reportRowsVerified` and `archiveMembersVerified` count completed
archive members during this invocation. `sourceReportRowsVerified` and
`sourceReportBodiesRetained` report exact SQL readback. `rowsNewlyNormalized`
comes from actual guarded UPDATE row counts, not from the number verified.
`migrationTransactionsCommitted` counts acknowledged operator transactions.
`archiveMembersReleased` counts actual archive-backed SQL body releases; 0198
sharing reports zero. Idempotent replay can verify many rows while newly
normalizing zero. Generic hooks that do not return application statistics report
unknown values as `null`, never fabricated zero or a fixed copy-only write flag.
The page hook may return `LegacyPageApplyStats`; `legacyNormalizationTelemetry`
converts a guarded 0198 proof to that contract. Counts are per invocation and do
not reset or replace the durable high-water cursor.

Each bounded worker SQL transaction holds the host deployment lock in shared
mode: `flock -s -w 15 -E 75 /tmp/airfoils-pro-deploy.lock`. Working-volume stores
use the same wrapper. The lock is taken on the worker host, before Docker/psql,
and released before the next batch. Deployment's exclusive lock blocks new
operator writes. A bounded wait expiry returns retryable exit 75 and a paused
message; completed checkpoints and the pending page remain intact. Repeat the
same bounded command after deployment. Read-only export queries stay separately
bounded and committed. The shared-lock execution wrapper is deliberately absent
from source/normalizer binding hashes, so existing receipts and checkpoints remain
reusable. Load updated code on the next invocation; it does not hot-patch an
already-running operator process. Custody writers must use the exported
`legacyOperatorWriteCommand` wrapper for their bounded host SQL command too.

For one worker read per page, the shared codec also exports
`readLegacyPageMembers`. Supply the complete expected member set and the packed
identity, read the retained volume once, and authenticate/inspect that buffer
once. The returned members preserve the original text and expected key order.
Return a bounded per-member proof manifest to the controller instead of sending
the entire packed object over SSH for every member. Missing supporting service,
database, normal reader, or member proof refuses compaction and keeps local 0198
access. Metadata-only zero-member cursor pages need no custody registration.
`retainVerifiedLegacyWorkerVolume` performs the exact packed-byte stream to the
installed store CLI; its store acknowledgement alone is never compaction proof.
