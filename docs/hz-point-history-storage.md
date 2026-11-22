# HZ point history migration

The operator moves the four `force_history` sample arrays and the canonical `results.steady_history` and `results.frame_track` fields using migrations 0204 and 0206. A force selection uses `force_history.id`. A steady or frame selection uses `results.id`. Result coefficients, attempt evidence, classification, sample counts and other scalar facts keep their existing owners.

Run the CLI on the controller that already has SSH access to both hosts. The hub helper creates immutable objects with `ifGenerationMatch=0` and reads the exact recorded generation back to EOF using the confirmed hub workload identity. HZ retains one deduplicated gzip working file per compressed SHA-256 under `$MEDIA_DIR/point-histories/v1/` on its existing results volume. The sweeper fsyncs and reopens it. The API reads it from its read-only mount. The SSH sessions disable agent forwarding.

An existing 0204/0206 receipt for the exact source bytes and owner can supply the original generation, including an original-instance receipt already present in the HZ catalog. Otherwise the operator archives the exact UTF-8 PostgreSQL JSONB text. Both routes check the compressed size, SHA-256, CRC32C, envelope and source identities. Before shortening a row, the API helper verifies the working file and the worker locks and rechecks the current owner, job, ingest lease and source text. The controller holds the HZ host's shared deploy lock across the working-copy store, API read, database commit and final API read through the stored pointer. SSH, GCS and SQL verification require the installed release on the respective hosts. Missing or corrupt data stops the operation at the saved receipt.

## Controller setup

Use a checkout of the same operator source as the installed helpers. Set the SSH aliases and container names from the deployment. Supply the bucket and **email identifier** of the existing canonical workload account. The helper gets its token from the hub metadata service.

```bash
export HZ_SSH_HOST=hz-solver2 HUB_SSH_HOST=airfoils.pro
export HZ_SWEEPER_CONTAINER=hz-solver2-sweeper-1 HZ_API_CONTAINER=hz-solver2-node-api-1
export HUB_SWEEPER_CONTAINER=app-sweeper-1
: "${HUB_EVIDENCE_BUCKET:?export the configured evidence bucket}"
: "${HUB_SERVICE_ACCOUNT:?export the confirmed hub workload account email}"
: "${HZ_HISTORY_PROGRESS:?set an absolute private directory on the controller}"

hz_history() {
  corepack pnpm --filter @aerodb/sweeper exec tsx src/hz-point-history-storage-cli.ts "$@"
}
```

## Canary and acceptance

Use a fresh canary directory. The read-only `candidates` command returns stable row IDs. Inspect a selection before applying it. For a specific known row, set `HZ_HISTORY_ID` to that row's UUID. Capture the existing detail response for its stable result ID, including the displayed Cl, Cd, Cm and time samples. The first command below prints the plan locally. The second applies just that one history after the installed readers are ready. The third independently verifies the recorded GCS generation, actual HZ catalog pointer and normal API hydration.

```bash
hz_history candidates --kind=force_history --limit=1
HZ_HISTORY_ID=$(hz_history candidates --kind=force_history --limit=1 | jq -er '.items[0].id')
: "${HZ_HISTORY_ID:?an eligible force history is required}"
canary=(--kind=force_history "--id=$HZ_HISTORY_ID" --limit=1 "--directory=$HZ_HISTORY_PROGRESS/canary")
hz_history pass "${canary[@]}"
hz_history pass "${canary[@]}" --readers-ready --apply
hz_history verify --kind=force_history "--id=$HZ_HISTORY_ID"
```

Accept a new offload when the history event has `offloaded:true`, and independent `verify` reports `verified:true` and `api.throughCatalog:true`. Compare `GET /api/airfoils/{slug}/sim?resultId={resultId}` with the captured response for a publicly selectable point. Selected-attempt and raw result coefficients can legitimately differ. Each must equal its own pre-migration value. For canonical steady or frame histories repeat the canary with the corresponding kind, a result UUID and a new directory. An already authorized polar export should retain the same units, sample order and values. The `verify` command also works when that external export permission is disabled.

## Initial and ongoing migration

```bash
hz_history status
hz_history migrate --kind=all "--directory=$HZ_HISTORY_PROGRESS/bulk" --limit=8 --max-bytes=8388608 --readers-ready --apply
hz_history watch   --kind=all "--directory=$HZ_HISTORY_PROGRESS/bulk" --limit=8 --max-bytes=8388608 --readers-ready --apply
```

`migrate` finishes one bounded keyset sweep. `watch` runs on the authorized controller under the operator's normal service supervision. It wraps the three independent cursors and checks again after 30 seconds at the end of a sweep, so histories created below an earlier cursor or becoming terminal later are reconsidered. The controller must remain available for ongoing migration. The installed API can serve already migrated histories while it is offline.

Each pass selects up to 32 histories, with an 8 MiB logical selection budget and eight rows by default. One source can exceed the soft budget up to the 32 MiB hard per-source limit. 0206 keeps small histories inline when the compact representation would save under 1 KiB or the source is under 4 KiB. Active jobs and live ingestion stay inline. The `sourceBytes` counter measures selected source text for acknowledged transitions. PostgreSQL can reuse freed pages, and an OS disk-space measurement is separate.

The progress directory contains the checkpoint and immutable metadata receipts. A pending receipt is saved before any HZ source write. Restart with the same targets, selection and directory. The operator can verify or reconstruct a missing working copy from its existing recorded generation. For a targeted repair use a fresh canary directory and the already archived row ID. A verified replay reports `replayed:true`. A corrupt conflicting working file is preserved for investigation. Keep the working files pinned while their database pointers exist.

The read-only `candidates` operation scans at most 32 keys per page. If a page has no eligible row and `done:false`, pass the returned `after` value with `--after=UUID`. The read-only `status` operation counts current inline and archived rows, including small or ineligible inline histories. The controller retry path backs off on transient transport or deploy-lock failures. Permanent errors leave the current page available for inspection. SIGTERM finishes the current bounded item and saves progress. `--max-passes=N` limits an invocation. No schema or journal addition is needed beyond 0204 and 0206.

Run the repository's `hz-point-histories` governed graph to exercise the operator subprocesses, migrations, rejected custody, stored-generation replay, selected-result detail and sync export against disposable PostgreSQL.
