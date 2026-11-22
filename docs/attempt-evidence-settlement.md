# Shortening settled attempt histories

Migration `0208_attempt_history_readthrough.sql` installs the forward transition
with shortening disabled. The existing hub report-storage worker runs the writer
using the configured evidence bucket and server credentials. Migration `0207`
continues to create and verify the original GCS copies.

The first cohort covers local, settled RANS attempts with an acknowledged mesh
recovery contract, four aligned `steady_history` arrays and no scientific or
replay dependency that still needs those arrays online. The SQL candidate query
returns a reason for each exclusion. Canonical selections, progressive fitting,
continuation and remote delivery are among the exclusions. The initial bounds
are 256 KiB of original JSON text, at least 4 KiB of removable history and at
least 1 KiB of net stored value savings.

## Rollout and one-attempt canary

Integrate the stable-ID API reader, the server consumer changes and the writer in
the same Node release. Use the normal control-plane deployment. Its migration
entry point is `scripts/deploy/vps-redeploy.sh`, which quiesces old writers and
runs this command with the configured Compose profile before starting the new
API and sweeper.

```sh
compose run --rm --no-deps node-api node --import tsx packages/db/src/migrate.ts
```

After confirming the serving API and sweeper are on the integrated revision,
run the following on the hub. `attempt_history` runs the installed CLI inside the
sweeper with its existing database and GCS configuration.

```sh
cd /opt/airfoils-pro/app
attempt_history() {
  docker compose --env-file /opt/airfoils-pro/state/.env.deploy -p app \
    -f docker-compose.deploy.yml exec -T sweeper \
    node --import tsx apps/sweeper/src/attempt-evidence-storage-cli.ts "$@"
}
attempt_history shortening-status
attempt_history shortening-candidates --pages 1
```

Follow `next` with `--after UUID` until an eligible pair appears or `complete`
is true. Each page examines at most 32 distinct archived attempts. An empty
complete scan means that the current cohort has no canary. Use a returned
`attemptId` and `archiveId` from the same pair for the following commands.

```sh
: "${ATTEMPT_ID:?set the eligible attemptId}"
: "${ARCHIVE_ID:?set its archiveId}"
attempt_history enable-shortening --consumer-contract 1 --id "$ATTEMPT_ID"
attempt_history shorten --id "$ATTEMPT_ID" --archive-id "$ARCHIVE_ID"
attempt_history shorten --id "$ATTEMPT_ID" --archive-id "$ARCHIVE_ID"
```

The canary policy permits new shortening only for the named attempt. The first
successful call returns a completed storage event and byte counts. The second
reads the active GCS generation through the app again and reports
`alreadyShortened: true` and zero additional bytes reclaimed. A normal
read of the attempt must return the archived full point after the switch.

## Stopped progressive RANS histories

Migration 0210 adds a separately enabled cohort. It requires a solved historical
RANS point with mesh version 3, a cancelled and ingested hub dispatch, an exact
recorded execution stop, a bound broker upload, a storage-only point receipt and
a later attempt on the same stage-3 unit. The writer verifies the signed report
sequence and point against the original attempt. The report projection must
reproduce both the application digest and every byte of the PostgreSQL source
text. Each transition retains the 0208 size floor and GCS and app readbacks.

The migration adds a BRIN Bloom index for the diagnostic-attempt lookup. The
writer records per-attempt storage savings when a transition completes.

Use the 0210 API, sweeper and isolated report-storage worker together. The
worker needs its existing hub reader for both archived reports and attempts.
The following preview works with shortening disabled. Page with `--after` and
use a returned attempt and archive ID for the canary.

```sh
attempt_history shortening-candidates --stopped-progressive true --pages 1
attempt_history enable-shortening --consumer-contract 1 --stopped-progressive true --id "$ATTEMPT_ID"
attempt_history shorten --id "$ATTEMPT_ID" --archive-id "$ARCHIVE_ID"
```

The progressive fitter and its stored model memberships require a CFD receipt.
These storage-only attempts have none. The job classifier and its polar fit
are compared before each removal. A future numerical link requires an exact
inline restore. Preparing an archived candidate for result publication restores
its original and removes it from the automatic cohort. To enable automatic
processing after the canary, repeat the enable command without `--id`. Omitting
`--stopped-progressive true` returns enablement to the original 0208 cohort.

## URANS attempts with immutable receipts

Migration 0213 adds a separately enabled hub scope for settled URANS sources.
It retains exact force times and channels, frame records and any steady
history in the existing attempt archive. Cycle certificates, selected
intervals, dispositions and other metadata keep their original values.
Classification, physical progress, force-table rows and stored media keep
their existing acceptance and ownership checks.

Preview the new scope with `shortening-candidates --receipt-urans true`.
After the matching readers are deployed, use the returned stable IDs for
a single-attempt canary. The inherited source limit applies by default. The
optional URANS limit is bounded at 8 MiB and affects only this scope.

```sh
attempt_history enable-shortening --consumer-contract 1 --receipt-urans true --id "$ATTEMPT_ID" --urans-max-source-bytes 8388608
attempt_history shorten --id "$ATTEMPT_ID" --archive-id "$ARCHIVE_ID"
```

Every removal still requires exact source custody, an authenticated
generation-pinned read, a working application read and positive stored
value savings. Archive interpretation of a pointerless result prepares the
original PG text before the scientific write. Publication rechecks the
attempt, result, archive and storage event, then applies the existing
cycle or no-shedding policy to that generation.

## Automatic mode and recovery

After a successful canary, enable the bounded automatic writer with the same
contract version and an unrestricted attempt scope.

```sh
attempt_history enable-shortening --consumer-contract 1
attempt_history shortening-status
```

`report-storage-worker.ts` starts `runConfiguredAttemptEvidenceSettlementService`
on the hub. It takes at most four attempts per pass by default. The policy is
checked again inside the shortening transaction. A manual pass uses the same
writer and returns its cursor, failures and measured bytes.

```sh
attempt_history shorten-pass --rows 1 --pages 1
```

To stop new removals and restore a canary to its original inline representation:

```sh
attempt_history disable-shortening
attempt_history restore-inline --id "$ATTEMPT_ID" --archive-id "$ARCHIVE_ID"
```

Disabling new removals preserves both the GCS originals and the app readers.
Before rolling back to an older reader release, restore **every** current
`result_attempts.evidence_archive_id` through `restore-inline` and verify the
pointer count is zero. Record run-specific receipts privately.

## Integrity and accounting

Each attempt gets a fresh full read of the pinned compressed generation, including
CRC32C, SHA-256, owner and original PostgreSQL text verification. The stable-ID app
reader is exercised before shortening. The server consumer verifier compares the
job's original and projected classifications and fit and verifies source equality.
SQL locks the job, result and attempt, repeats eligibility, and derives the
immutable projection from the exact full SQL source. The projection preserves
presence, JSON type, length and exact/semantic hashes. Ordinary metadata reads
use a single joined projection. Explicit equality checks normalize numeric scale
in PostgreSQL, preserving decimal equality and original GCS text.

A successful transition removes only the inventoried arrays. It records the
original and remaining stored payload sizes and the stored projection and
verification sizes. `payloadBytesReclaimed` measures the reduction in the live
JSONB payload. `netValueBytesReclaimed` also deducts the two metadata value sizes.
Heap, index and filesystem allocation are separate measurements. Insufficient
savings rolls back the whole SQL transition.

After commit the writer reads the normal app path and acknowledges that exact
event. A crash in this interval leaves a pending event for the worker to replay.
If the app cannot restore the exact bytes after a verified GCS read, the writer
restores the original inline source against the same event ID. Generation,
scientific, scope and usable-read failures before shortening retain the full
inline point. Receipts identify representation changes independently of scientific
changes, so a storage transition preserves the existing fit and classification.
