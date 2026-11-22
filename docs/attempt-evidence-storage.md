# Attempt evidence in GCS

Settled attempts with large history series are copied to immutable GCS objects.
Each object preserves the complete original PostgreSQL `evidence_payload::text`,
including point metadata, coefficients, artifact descriptors, certificates and
history arrays. PostgreSQL retains the original point and an independent archive
receipt. References never replace numeric arrays or masquerade as solver samples.

Migration 0207 establishes GCS custody. Its copy commands retain the full
PostgreSQL point and report zero online bytes removed. After migration 0208,
eligible histories can be shortened through the [settlement procedure](attempt-evidence-settlement.md).
The stable attempt ID continues to resolve the original point.

## Online storage measurements

Use `onlineStoredPayloadBytes` for PostgreSQL value storage and `sourceTextBytes`
and `historyBytes` for logical UTF-8 JSON text. Use `shortening-status` to read
the measured reduction for active shortened attempts. `remainingGcsSourceBytes`
measures the outstanding copy workload. Record the measurement time alongside
each counter.

For an individual attempt, bind the stable UUID as the `psql` variable
`attempt_id` and measure the existing value without exporting its contents:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '500ms';
SELECT id AS attempt_id,
       pg_column_size(evidence_payload) AS online_stored_payload_bytes,
       octet_length(evidence_payload::text) AS logical_payload_text_bytes
FROM result_attempts
WHERE id = :'attempt_id'::uuid;
ROLLBACK;
```

Retain a timestamped per-attempt byte export and reconciled totals in a private
measurement receipt. Reconciling every exported UUID and its stored byte count
to an exact database total requires the same snapshot for both reads; the paged
`use-audit` command remains a moving scan. Keep online bytes and outstanding
GCS-copy bytes separate; copying an object does not make the original payload
eligible for deletion.

## Current use and remaining work

`use-audit` reports each distinct combination of current uses:

- `canonical`: the attempt is selected by `results.current_result_attempt_id`.
- `fit_receipt`: a retained progressive CFD evidence receipt references it.
- `fit_model`: a stored progressive polar model references it.
- `campaign`: a campaign point references it.
- `continuation`: a precalculation obligation or submission references it.
- `settled`: the attempt is terminal and its producing job has completed
  ingestion without a live ingestion lease, or it has no local producing job.

Noncanonical attempts can remain inputs to real fitted models. Absence from
current selection does not authorize discarding their history or provenance.

The census separates `onlineStoredPayloadBytes` from logical `sourceTextBytes`
and recognized `historyBytes`. `remainingGcsSourceBytes` and
`remainingGcsHistoryBytes` count eligible settled sources without a matching
immutable receipt for the exact current owner, PG source hash and size.
`cataloguedRows` counts those verified receipts; it does not perform a live cloud
availability probe. Use `restore` for a fresh authenticated readback.

Every page fixes at most 128 IDs before examining payloads, uses a five-second
statement limit and 500ms lock limit, and returns only measurements. Follow
`next` until `complete`; a multi-page audit is a moving read-committed scan.
Oversized/uninspected counts must remain visible. Per-run measurements,
timestamps, source digests and validation results belong in private receipts.

## Storage and verification contract

1. Load one stable attempt UUID with a terminal status. Its job must be terminal,
   fully ingested and free of an active ingestion lease.
2. Preserve its complete exact PG text in a string envelope. Inventory only the
   recognized `force_history`/`forceHistory` coefficient arrays,
   `steady_history`/`steadyHistory` iteration/channel arrays and
   `frame_track`/`frameTrack` frames. Metadata and unknown arrays stay intact.
3. Write a private gzip temporary file with connected pipeline error propagation.
   Verify the complete local file before upload.
4. Upload with `ifGenerationMatch: 0` under
   `attempt-evidence/v1/<instance>/<attempt>/<source-sha>/<compressed-sha>.json.gz`.
   An existing object is reusable only after full verification.
5. Read the exact decimal GCS generation, with transparent decompression
   disabled. Verify metadata, CRC32C, compressed SHA/size, gzip completion,
   decoded envelope SHA/size, exact source SHA/size, array inventory and
   attempt/result/job ownership. The final SDK request overrides its numeric
   generation conversion, preserving all unsigned 64-bit digits.
6. Insert the immutable `attempt_evidence_archives` receipt. SQL independently
   rechecks the unchanged source, owner, settled writer and every inventoried
   array hash/size. It locks job then attempt only for this short registration;
   network operations run outside the transaction.
7. Verify the catalog's actual generation again before returning success.
   Replays restore the existing recorded generation instead of inventing a new
   receipt. Missing or corrupt bytes fail explicitly; online evidence remains.

Migration `0207_attempt_evidence_archives.sql` creates the catalog, its exact
source/inventory guard and immutable-update trigger. It changes no attempt
payload, coefficient, canonical pointer or classification. The catalog is solver
data for the explicit solver-domain reset workflow; configuration stays separate.

## Automatic retention

The existing report-storage worker supervises `runAttemptEvidenceStorageService`
using a separate one-connection database client. It starts on the hub when the
catalog and `AIRFOILFOAM_EVIDENCE_BUCKET` are available. Remote-solver deployments
remain inline. `AIRFOILFOAM_ATTEMPT_EVIDENCE_ARCHIVE=false` disables the loop before
database or GCS access.

Source identity defaults to `sync_api_settings.instance_id`;
`AIRFOILFOAM_HISTORY_SOURCE_INSTANCE` can supply a stable configured override.
Cloud credentials stay server-side in the existing authenticated GCS client.

Each pass scans 32 IDs and attempts at most eight copies with an 8 MiB soft source
budget. A first larger source can use one pass up to the hard 32 MiB source limit.
Automatic copies require at least 4 KiB of recognized history arrays. Small,
active, oversized and already-catalogued sources stay online. The keyset cursor
advances past failed copies and wraps so failures can be retried without starving
later sources. Passes yield between pages and wait 30 seconds after wrapping.
Shutdown stops between items and aborts active read streams.

## Operator commands

Use the intended explicit `DATABASE_URL` and existing GCS credentials. Audit and
restore read PostgreSQL without changing source rows. `archive` and `backfill`
write GCS objects and SQL receipts; they do not shorten online evidence.

```sh
# Print a bounded measurement query without opening a database connection.
corepack pnpm --filter @aerodb/sweeper exec tsx src/attempt-evidence-storage-cli.ts sql --limit 32

# Measure current canonical/model/continuation uses and remaining exact copies.
corepack pnpm --filter @aerodb/sweeper exec tsx src/attempt-evidence-storage-cli.ts use-audit --pages 1

# Measure logical payload fields. Retain output as a private audit receipt.
corepack pnpm --filter @aerodb/sweeper exec tsx src/attempt-evidence-storage-cli.ts audit --pages 1

# Upload and verify one settled point; insert its immutable SQL receipt.
corepack pnpm --filter @aerodb/sweeper exec tsx src/attempt-evidence-storage-cli.ts archive --id ATTEMPT_UUID --bucket BUCKET

# One bounded GCS pass. Follow next or increase --pages for a larger operation.
corepack pnpm --filter @aerodb/sweeper exec tsx src/attempt-evidence-storage-cli.ts backfill --bucket BUCKET --pages 1

# Freshly authenticate a recorded generation and export the exact PG source text.
corepack pnpm --filter @aerodb/sweeper exec tsx src/attempt-evidence-storage-cli.ts restore --id ARCHIVE_UUID --output /absolute/new-attempt.json
```

`backfill.scanComplete` means that the selected ID range has been traversed.
Inspect failures and the use audit to determine remaining copies; scan exhaustion
alone does not establish complete custody. Existing archives and source rows are
never deleted by these commands.

## Verification

The focused suites are `test/attempt-evidence-archive.test.ts` and
`test/attempt-evidence-gcs.test.ts` in the sweeper workspace. They cover exact
numeric text, bounds, full-stream errors, uint64 generation pinning, real
PostgreSQL registration guards, unchanged classifier inputs, receipt replay,
writer races, current-use counts and remaining-copy bytes. Storage doubles prove
the protocol boundary; operational verification also requires an authenticated
GCS readback and the normal integrated checks. Retain those results privately.
The regression also compares the complete live payload and per-attempt stored
and logical byte counts before and after upload/replay, requires unchanged
online/history totals, and requires the bounded backfill to copy a real source.

The settlement integration suite exercises the subsequent SQL transition,
scientific dependency verification, exact replay and inline restoration.
