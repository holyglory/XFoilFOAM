# Legacy worker report migration

This tool moves a fixed set of historical HZ worker reports to Google Cloud
Storage. PostgreSQL retains the identity and delivery state of each report.
Migration 0198 shares repeated result bodies. With migration 0205 and a
verified worker reader, eligible reports retain only a header and archive
reference in PostgreSQL. The original report remains available for replay.

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

For the full migration, run the following command on the operator host with the
existing SSH identities. It checkpoints each page and exits when it reaches the
last execution in the frozen scope.

```bash
legacy_reports migrate "${legacy_targets[@]}" \
  --scope="$LEGACY_REPORT_SCOPE" --directory="$LEGACY_REPORT_PROGRESS" \
  --worker-sweeper-container="$HZ_SWEEPER_CONTAINER" --until-complete \
  --rows=128 --pages=16 --max-bytes=134217728 --readers-ready --apply
```

Each pass respects its row, byte and page budgets. With `--until-complete`, a
deployment or a recognized temporary transport or cloud error triggers a delay
and retry. Authentication errors and integrity failures stop the transfer with
the last checkpoint and pending bytes preserved. Restart with the same scope,
source, destination and progress directory. Optional `--max-passes` and
`--max-seconds` limit a monitoring run.

Use `--readers-ready` after installing the archive readers on HZ and the hub.
The worker checks its live storage policy. The operator fetches the exact GCS
generation and records its checksum. HZ reopens the compressed file on its
persistent results volume and verifies every member. PostgreSQL checks each
source row before replacing its full body. Rows still needed for outstanding
evidence keep their online data. The checkpoint advances after the database
transaction and proof are durable.

PostgreSQL locks exact report rows and compares the original signature, full
JSONB digest and size with the verified archive. It reuses
`store_progressive_report_result` and the existing immutable representation
guards, then verifies the reconstructed body and every other storage column.
A changed or missing member rolls back the page. Lost acknowledgement after
commit is safe: the same frozen page is authenticated and reapplied
idempotently. A second SQL readback records actual report/payload identities.
When HZ's evidence-download permission is disabled, record
`--registered-get=denied`. HZ then relies on its verified compressed working
copy. Omitting `--worker-sweeper-container` selects 0198 sharing and leaves the
full data accessible inside PostgreSQL.

## Bounded migration of two separate executions

The default migration uses one custody worker. To qualify two workers, use the
existing bulk service, its frozen scope and its current progress directory.
Change the normal invocation for a finite pass at a durable page boundary.
The following invocation admits at most four page operations. Execute it
through the sole service that owns the directory lock.

```bash
legacy_reports migrate "${legacy_targets[@]}" \
  --scope="$LEGACY_REPORT_SCOPE" --directory="$LEGACY_REPORT_PROGRESS" \
  --worker-sweeper-container="$HZ_SWEEPER_CONTAINER" --registered-get=denied \
  --execution-slots=2 --rows=128 --pages=4 --max-bytes=268435456 \
  --slot-min-available-mib=8192 --slot-max-rss-mib=4096 \
  --until-complete --max-passes=1 --readers-ready --apply
```

One controller owns `copy.lock` and advances `checkpoint.json`. A pair
uses the current execution and one later execution. It inspects at most 16
frozen counts and chooses the nearest job that can cover as much of the
remaining front workload as possible. Intervening jobs stay on the ordered
front slot.
Reports and conflicts from each execution stay in order. Each page still
requires an immutable hub upload, exact generation readback, local volume
verification and the same guarded custody transaction or 0198 fallback.
A short peer can finish first. Its applied receipts wait for the preceding
execution's contiguous prefix. The next execution is admitted after that
pair joins. The per-pass page budget counts both slots and promotion of a
previously completed peer page. Per-pass worker and receipt counts can differ.

At most two pages of up to 128 MiB each may run together. Each fresh
single-worker head can use the full configured 256 MiB budget. Recovery uses the budget recorded with each pending page,
including after a switch between 128 and 256 MiB. The supervisor samples
controller and worker host/cgroup headroom and RSS every half second during a
paired wave. Defaults require 8,192 MiB available on each host and limit the
controller process RSS and combined custody-worker RSS separately to 4,096 MiB.
The initial sample includes all current custody workers in the selected cgroup.
Their aggregate RSS plus the measured reservation for a new pair must fit the
RSS limit. The initial pair reservation defaults to 3,072 MiB and can be set
with `--slot-pair-reserve-mib`. Low initial headroom selects one worker.
Unavailable capacity measurements are reported as `capacity_unavailable`.
The ordinary head still verifies its exact source, cloud generation and
working-volume receipt. Authentication and host-key failures retain their
existing error categories. A measured breach during a paired wave allows the
in-flight transactions to finish and writes `execution-peer-memory-hold.json`.
Subsequent waves use one worker. After reviewing the host and receipt evidence,
the operator can clear that hold at a service boundary. These are sampled
admission limits. The operating system's cgroup limits govern allocations.

For a production trial, compare windows of the same ordinary 256 MiB command
with the candidate. The packaged `legacy_report_host_capacity.py` evaluator
accepts host and cgroup-v2 counter samples from a read-only operator observer.
It reports host free and available memory separately. For PostgreSQL it reports
anonymous memory, file-backed memory, shared memory and the inactive file
cache. It credits at most the lesser of inactive file pages and non-shared
file pages when estimating the working set. Actual cgroup high/max margins,
memory events, pressure, throttling, signed progress and solver CPU relative
to the ordinary window still bound admission. A cache-heavy PostgreSQL can
therefore coexist with a second worker while measured resource margins hold.


During a pair, `pending.jsonl.gz` is a directory with a transfer file per
active slot, exact archive receipts, and a short publication record. The
supervisor removes transfer bytes after durable application evidence. It
reopens uncertain generations and checks the application proof before linking
the ordinary receipt files into the existing inventory. The checkpoint moves
only after those links are durable. An interruption can leave an already
committed generation awaiting an idempotent replay. Failed proof or a missing
receipt holds the gap with its evidence on disk.

To return to one worker, use this release with `--execution-slots=1` and the
same targets, scope, and progress directory. It accepts a 256 MiB page budget,
finishes any uncertain work and joins its recorded peer receipts. During this
drain the public checkpoint can still be several pages behind an applied peer.
Older executables see the reserved pending directory and stop safely. They
can resume the ordinary version-1 checkpoint once the directory has been
joined and removed. A scalar pending file from an older run is always recovered
first using its original bytes.

For canary acceptance, compare the public checkpoint and its last receipt
before and after. Check the separate execution IDs, actual peak worker count,
peer receipt and generation, every normal member read, remaining warm counts
and the continuous signed publication and heartbeat frontiers. Compare the
observed headroom, worker/PG/controller memory and page time with recent
one-worker pages on the same sources. An early peer success should leave the
public cursor on the earlier execution. Resume with one worker and confirm the
old receipt chain covers the joined prefix and each original member exactly.
Keep the one-worker operating setting until these live observations pass.

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

To process a prefix that was already copied or normalized, use the same
worker-container option with `migrate-receipts`. It restores each page from
the exact GCS generation. `unappliedRemaining` counts receipts awaiting their
first application with that reader. `remaining` includes receipts with rows
still awaiting evidence settlement. The saved proof records each skipped
row's reason. An idempotent replay reports zero new releases for rows already
archived. The summary counts reports separately from conflict records.

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

The integrated migration sends the verified compressed page through the
operator's existing SSH connection to the HZ sweeper. The worker syncs the file
and directory, reads the complete page through the installed product reader,
then registers the object and eligible members in one database transaction.
The node API reads the same volume read-only. Both services receive the
deployment role from Compose.

For an independent read, pass the object identity and complete expected member
vector as JSON on standard input to the installed worker reader.

```sh
node --import tsx /app/apps/sweeper/src/legacy-worker-report-product-read-cli.ts < expected-members.json
```

The response includes each original row and report digest, the exact object
generation, the number of compressed bytes read, and the hash of the installed
reader. The command opens a read-only database session and leaves the archive
and its source intact.

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
