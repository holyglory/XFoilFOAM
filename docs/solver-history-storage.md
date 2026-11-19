# Physical solver history storage

Force-history storage offloads only `force_history.t`, `cl`, `cd`, and `cm`. It keeps
that row's ID, exact result/attempt owner, sample count, means/RMS, shedding
metadata, and creation time in PostgreSQL. It does not change result
coefficients, classification, compatibility identity, canonical selection,
frame tracks, steady history, attempt payloads, or any progressive report.

The inventory commands below measure counts and exported JSON sizes against the
configured database. Retain their outputs in private operation receipts.

## Inventory and consumer map

| Stored data                                                   | Current consumers                                                                                                                                               | Storage behavior                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `force_history.t/cl/cd/cm`                                    | API simulation detail (`services/sim.ts`); immutable-value comparison on sync replay (`sync-routes.ts`)                                                         | Offload with one immutable pointer per retained row; both normal readers hydrate through `readStoredForceHistory` |
| `force_history` scalar fields and result/attempt IDs          | Detail; sync comparison; evidence-existence SQL                                                                                                                 | Always inline; row still exists after offload                                                                     |
| `results.steady_history`                                      | Detail parser; projections and ingestion reconciliation                                                                                                         | Managed separately by result-history storage                                                                      |
| `results.frame_track`                                         | URANS detail/frames and evidence certification                                                                                                                  | Managed separately by result-history storage                                                                      |
| `result_attempts.evidence_payload.force_history/forceHistory` | `polar-cache.ts`, `precalc-obligations.ts`, progressive fitting and exact fit-request validation, result interpretation, budget extension, outbound remote sync | Entirely inline, including all scalar validation inputs and arrays                                                |
| Other attempt payload fields and certificates                 | Physical acceptance, source geometry, provenance, raw evidence/media/download association                                                                       | Entirely inline                                                                                                   |
| Raw CFD bundles, media and downloads                          | Existing evidence stores/readers and download routes                                                                                                            | Unchanged; this archive is not a raw CFD bundle or acceptance receipt                                             |

The bounded page inventory transfers IDs and sizes, not sample arrays. The
explicit full census additionally reports serialized source totals for steady,
frame and attempt payloads and total relation sizes for the three tables.
Serialized sizes and relation sizes are different measurements. After offload,
the force-history source census counts remaining inline arrays; pointers and
scalar rows remain in the same table. Normal PostgreSQL vacuum can reuse dead
TOAST storage; no immediate filesystem shrink is promised and this code never
runs VACUUM/FULL, rewrites tables, or compacts production.

## Exact bytes and existing raw evidence

`pipeline._archive_case_evidence` archives OpenFOAM dictionaries, logs, raw
post-processing files, selected time directories/VTK and a manifest. The
manifest construction does not emit a PostgreSQL JSONB `::text` array object.
This source review establishes no byte identity for any existing production
bundle. An authenticated source comparison is required for each reused bundle.

Never infer that a coefficient TSV, equivalent JSON, reconstructed floats, or
a tar-member manifest is byte-identical to a PostgreSQL export. `compare`
compares an authenticated, extracted candidate member to the exact four-array
JSONB text export and reports both SHA-256 values and sizes. Absence of a
candidate is reported as unavailable, not identical. This implementation
therefore always creates a separate exact history object; it never reuses an
unverified raw bundle or deletes any original raw bundle.

JSONB already discarded original engine wire formatting and duplicate keys.
The preserved representation here is the exact PostgreSQL `::text` export,
including numeric precision, null `cm`, key order and spacing. The envelope
stores that text as a string, avoiding parse/stringify rounding during archival.

## Online transition and failure behavior

1. Read one bounded inline four-array source by stable force-history UUID.
2. Create a gzip object in `solver-histories/v1/<instance>/<row>/<stored-sha>.json.gz`
   using a create-only generation precondition. An existing object must pass
   the same verification; a metadata match alone never suffices.
3. Read the complete exact generation. Verify metadata, CRC32C, compressed
   size/SHA, envelope size/SHA, source size/SHA and exact result/attempt owner.
   SDK 7.16 rounds generation options through Number, so the shared reader
   overrides the final metadata/media requests with the original decimal
   generation string, including values beyond JavaScript's safe integer range.
4. Insert an immutable archive catalog record. A database trigger independently
   checks its source bytes and ownership against the still-inline arrays.
5. Freshly read the recorded generation again, including on catalog replay.
6. Atomically set `history_archive_id` and NULL only the four arrays if their
   owner, size and SHA still match. The short database update has a 1-second
   lock bound and 5-second statement bound. If a writer changed the arrays,
   nothing is removed and the source stays inline.

NULL arrays require a valid exact-owner pointer, enforced by migration 0204.
Partial NULL shapes and arbitrary offloaded inserts/retargeting are rejected.
Ingest replay can write complete arrays normally; its trigger clears the live
pointer while retaining immutable historical archive records. The next pass
can safely offload that exact generation again. Archive records cannot be
updated. Cleanup/reset must continue to respect the normal evidence ownership
and deletion rules; this code does not introduce any cleanup operation.

Read-through returns original scalar metadata plus restored arrays. An inline
read does not construct a GCS client or make a network request. An offloaded
read with unavailable, corrupt, mismatched or missing-generation bytes fails
explicitly, rather than returning an empty history or fabricated samples.
A concurrent ingester restoring inline arrays is handled by one bounded reread.

## Automatic backfill and integration

Apply `0204_solver_history_storage.sql` before enabling the supervised
`runSolverHistoryStorageService` loop. Both detail and sync replay readers must
support archived histories before the loop starts. The report-storage worker
owns the loop's AbortSignal and database-client shutdown.

The service returns before querying PostgreSQL or constructing Storage when
`AIRFOILFOAM_EVIDENCE_BUCKET` is empty, or when
`AIRFOILFOAM_FORCE_HISTORY_OFFLOAD=false`. Bucketless HZ and bucketless hub
therefore retain all histories inline. It does not broker history offload for
credentialless nodes. For a configured hub, source identity defaults to the
existing `sync_api_settings.instance_id`; an explicit stable
`AIRFOILFOAM_HISTORY_SOURCE_INSTANCE` can override it.

Each pass scans at most 32 eligible rows and processes at most eight uploads.
Default exported source budget is 8 MiB per pass, with one larger source
allowed alone up to the hard 32 MiB bound. Larger or malformed sources stay
inline. Owned attempts require terminal attempt/job state; active jobs stay
inline. A fair keyset cursor advances past failed/oversize rows and wraps only
after an empty tail query, so a full page of skipped rows cannot starve later
work. Passes run sequentially with a 250 ms yield after productive passes
without errors and a 30-second idle/error backoff. They never overlap and stop
between items on shutdown.
Repeated uploads and restarts reuse verified catalog/object identities.

## Operator commands

Use the intended explicit DATABASE_URL and existing authenticated GCS identity.
Archive/backfill perform real online array offload and require integrated
read-through readers; inventory/page/compare/restore do not change source rows.

```sh
# Full operator census (can read all TOAST; 60-second statement bound).
corepack pnpm --filter @aerodb/sweeper exec tsx src/solver-history-storage-cli.ts inventory

# Bounded remaining-inline source inventory; follow the returned cursor.
corepack pnpm --filter @aerodb/sweeper exec tsx src/solver-history-storage-cli.ts page --kind force_history --limit 100

# First authenticate/extract the candidate using existing evidence tooling.
corepack pnpm --filter @aerodb/sweeper exec tsx src/solver-history-storage-cli.ts compare --kind force_history --id ROW_UUID --raw-member /absolute/authenticated-member.json

# Explicit single-row offload; raw comparison is optional and absence is honest.
corepack pnpm --filter @aerodb/sweeper exec tsx src/solver-history-storage-cli.ts archive --kind force_history --id ROW_UUID --bucket BUCKET --source-instance INSTANCE_UUID

# One bounded pass; --after accepts the previous next cursor.
corepack pnpm --filter @aerodb/sweeper exec tsx src/solver-history-storage-cli.ts backfill --bucket BUCKET --source-instance INSTANCE_UUID

# Verify again, then export exact source text to a new private file; no SQL restore.
corepack pnpm --filter @aerodb/sweeper exec tsx src/solver-history-storage-cli.ts restore --id ARCHIVE_UUID --output /absolute/new-history.json
```

## Verification scope

Run the API exact-generation and sync validation suites
with their added offload journeys, plus the new sweeper
`test/solver-history-storage.test.ts`. The new suite uses an isolated PostgreSQL
schema, the real migration, real row transitions and a deterministic object
transport to exercise restore failure, wrong identity, large generation strings,
null/real `cm`, changed-source races before and after registration, replay,
reingestion, bounded backfill and bucketless service behavior. The API cases
exercise real routes and database rows, with deterministic archived bytes.
These fixtures do not prove real GCS access or production inventory. A live
GCS canary and integrated checks are required before operational qualification.
Retain run-specific results in private verification receipts. No physical fitting or accepted
status gate is relaxed or replaced by archive existence.
