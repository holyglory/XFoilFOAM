# Reading HZ attempt histories from immutable worker reports

With migration 0224 the same watcher accepts `--include-settled-receipts`.
It keeps earlier supported receipts eligible and checks the immutable point
at its own acknowledged sequence plus the independently acknowledged final
stop of that assignment. The registered worker's native 0207 original,
generation, original byte length and SHA must match the signed projection.
The operator reads existing objects up to 8 MiB of original text and 1 MiB
compressed. Each report read is bounded at 32 MiB. A current selection and a
historical generation go through the same pre- and post-transition checks.

Use `plan --id UUID --include-settled-receipts` for a read-only preview.
At handoff, change the existing singleton watcher's mode. Its directory lock
also covers the new checkpoint. Pending events from all three worker recipes
are verified first. An earlier running report can prove an already received
point even when the normal final-only requeue command refuses that sequence.
An absent point receipt or an open claim keeps the original inline.

When a job lock delays confirmation after shortening, the watcher retries the
native confirmation with the same event and verified application read. A
persistently busy event stays in the database's pending-readback list. The
watcher revisits it between ordinary candidates and reports the source as
confirmed only after the native readback succeeds. A deployment or transfer
pause continues to fence the whole operation.

An attempt has an HZ attempt ID, an HZ result ID and an execution ID. The hub assigns its own IDs when it retains the delivered point. The worker acknowledgment records both pairs. A hub 0207 object contains the hub pair in its compressed envelope. Keep both pairs and their original roles when comparing or restoring the payload.

## Read one settled attempt

Run from a pinned checkout with its workspace dependencies installed. Supply the existing file containing the expected hub workload account name. The controller sends only its SHA-256 pin to the hub. The HZ node API reads its mounted results volume. The hub sweeper obtains its token from its own metadata service. Each database connection is read-only.

```sh
node scripts/deploy/verify-hz-attempt-history.mjs \
  --attempt "$HZ_ATTEMPT_ID" \
  --hub-account-file "$HUB_ACCOUNT_FILE"
```

The default SSH aliases are `hz-solver2` and `airfoils.pro`. Override them with `--hz-host` and `--hub-host`. The `--hz-api` and `--hub-sweeper` flags select the existing containers. The command sends the checkout's read-only resolver through SSH stdin and uses the installed domain and archive readers. This also permits checking a candidate reader before a deployment.

The command exits successfully only after four reads agree on the original PostgreSQL text. It reads the ordinary HZ attempt, the exact report member on the HZ volume, the same GCS report generation and the separately owned hub attempt generation. The hub checks its registered solver, actual dispatch, received point, canonical attempt and original archive. Each compressed object must match its bucket, key, generation, size, SHA-256 and CRC32C. Output contains stable identifiers, byte counts and verification results. Store any saved output in a private operator directory.

The bounded two-generation comparison follows an ordinary or storage-only acknowledgment for the exact local attempt, result, sequence and point. It requires a settled worker job, a closed scheduling promise, a locally archived final report with verified stop evidence and a mapped hub original. The archive-only operator handles genuine worker originals with no mapped hub result. Each check accepts one attempt of at most 256 KiB of PostgreSQL text. A bundle may contain up to 128 members, 16 MiB packed and 32 MiB decoded, with at most 4 MiB per reconstructed report. An unsupported, absent or conflicting source fails the check.

To measure one page of the full attempt table after the field-audit fix is deployed, run the existing storage audit on HZ. It returns grouped PostgreSQL field byte counts, inspected and skipped rows, and a continuation ID. Follow its continuation with `--after UUID` for the next page.

```sh
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no hz-solver2 \
  docker exec -i hz-solver2-sweeper-1 node --import tsx \
  /app/apps/sweeper/src/attempt-evidence-storage-cli.ts audit --limit 64 --pages 1
```

## Product read and retention

Server code can call `readStoredAttemptEvidenceText(db, hzAttemptId, { source: "worker-report" })`. It follows the attempt’s worker acknowledgment and staged association to the exact report bundle and member on the HZ volume. It verifies the assignment and point signature, applies the normal delivery projector, and asks PostgreSQL to serialize the result. It compares the bytes and digest with the original HZ source. No sampling, unit conversion, numeric token substitution or new delivery occurs.

An HZ source is the HZ result, attempt and execution recorded in the worker acknowledgment. Its staged point signature and the immutable worker-report member establish provenance independently of the hub's attempt ID. The HZ transition requires the original registered worker, closed promise, terminal acknowledged report and exact delivered point. It does not depend on a copy of the hub dispatch table on the worker.

## Move HZ originals out of PostgreSQL

Deploy the integrated reader, sweeper and migrations on both hosts first. Migration `0212_hz_attempt_history_custody.sql` follows `0211_progressive_attempt_receipt_sources.sql`. The controller runs in the operator's checkout and uses the same SSH aliases and hub-account file as the independent proof above. `HUB_BUCKET` must name the bucket configured on the hub sweeper. Use a separate private checkpoint directory for this operator.

```sh
attempt_history() {
  node --import tsx apps/sweeper/src/hz-attempt-storage-cli.ts "$@"
}
attempt_history plan --until-complete
attempt_history plan --id "$HZ_ATTEMPT_ID"
attempt_history migrate --apply --id "$HZ_ATTEMPT_ID" \
  --bucket "$HUB_BUCKET" --hub-account-file "$HUB_ACCOUNT_FILE"
attempt_history status
```

A successful first canary returns the local attempt ID, local archive ID, exact GCS generation, storage event and reclaimed value bytes. Run the identical canary a second time. It should verify the existing event and report zero additional bytes. `status` reads the active HZ storage events directly and exposes confirmed and pending rows and their physical value-byte totals. These are PostgreSQL datum savings. Filesystem space depends on PostgreSQL vacuum and relation reuse.

For the finite initial pass and ongoing work, use the two commands below. The watcher rescans new UUIDs and attempts that settle behind an older scan cursor. Multiple controllers sharing one checkpoint directory are excluded by a local file lock.

```sh
attempt_history migrate --apply --until-complete --limit 8 \
  --directory "$HZ_ATTEMPT_STATE" --bucket "$HUB_BUCKET" --hub-account-file "$HUB_ACCOUNT_FILE"
attempt_history watch --apply --limit 8 --poll-seconds 300 \
  --directory "$HZ_ATTEMPT_STATE" --bucket "$HUB_BUCKET" --hub-account-file "$HUB_ACCOUNT_FILE"
```

The finite scan freezes the high-water UUID and binds the checkpoint to both SSH endpoints, containers, registered solver and hub identity. Each source comparison and commit handles one attempt. A page contains up to 64 candidate keys. The default is eight. `--pages N` limits a single invocation unless `--until-complete` or `watch` is selected. SIGTERM finishes or checkpoints the current bounded operation. Deploy-lock pauses and confirmed transient transport failures retry with backoff in the continuous modes. A source, credential or generation mismatch stops the pass.

The first apply registers the HZ 0207 receipt and enables only the worker cohort on HZ. An already enabled incompatible policy blocks the transition. The writer creates the native 0207 gzip from the original HZ PostgreSQL text. The GCS prefix, object metadata and HZ catalog bind the source instance, HZ attempt and result IDs, execution, sizes and hashes. The hub verifies the registered worker before creating an immutable object with a generation-zero precondition. It reads the exact recorded generation again after scientific verification. The HZ volume holds one fsynced gzip per complete receipt under `attempt-histories/v1`, independently of worker-report volume cleanup.

Before shortening, both the node API and sweeper must reconstruct the original. The writer replays the signed report, checks the 0208 immutable projection, compares job-scoped classification, promotion and fitted polar, then runs the locked 0208 shortening transaction. Only the four aligned steady-history arrays are eligible. The original source is capped at 256 KiB and the configured logical and physical savings floors still apply. Rejected rows stay inline. The ordinary HZ API, sweeper and 0211 projection readers all use the HZ working copy. Hub-side receipt-bearing RANS keeps its own policy and storage path.

## 0211 reader interface

The HZ adapter exports `readHzAttemptWorkingCopy(identity: AttemptEvidenceArchiveIdentity, signal?: AbortSignal): Promise<AttemptEvidenceCopySource>` from `apps/sweeper/src/hz-attempt-volume.ts`. It implements `AttemptEvidenceArchiveReader.read` using the exact locally admitted receipt. Timestamp changes during a fresh verification leave the storage identity intact. A change in bucket, generation, owner, checksum or size selects a different working copy and fails closed.

The existing signatures of `sweeperAttemptArchiveReader()` and `readOriginalAttemptForProjection(db, id, archiveId)` stay intact. The shared sweeper and API adapters choose this local implementation on the remote-solver role. Canonical repair, publication, fitting, signed delivery replay and pending-event recovery can therefore use the same source. The source pin retains both the PostgreSQL original hash and the application-level replay digest. The signed worker acknowledgment and exact report member remain independent provenance.

## Recovery

An interruption before registration is safe to repeat through conditional upload. A registered copy is reused by its recorded generation. After a SQL commit, an unconfirmed event is processed before the next scan page. The operator refreshes its working copy from the hub, reads the published stable ID from the node API, and checks the original again through the normal sweeper reader. A permanent failed post-commit probe restores the exact inline original. Each bounded HZ write RPC takes the worker host's shared deployment lock.

For operator-directed restoration, use the original HZ attempt ID. Restoration checks the current event under the normal job, result and attempt locks and reads the pinned GCS generation before restoring PostgreSQL.

```sh
attempt_history restore --apply --id "$HZ_ATTEMPT_ID" \
  --bucket "$HUB_BUCKET" --hub-account-file "$HUB_ACCOUNT_FILE"
```

The restored row becomes eligible again when a new apply or watch pass reaches it. Stop the watch before restoring a row intended to stay inline. The catalog retains its immutable history. The accepted roll-forward and rollback evidence is the PostgreSQL event together with its confirmed product readback.

## Broader signed worker histories

Migration `0216_hz_retained_original_attempts.sql` follows the 0213 URANS consumer migration, the 0214 hub policy and the 0215 active-role correction. The wider HZ policy is opt-in. The canonical hub may retain a dormant worker registration. A worker backup always uses the actual remote-solver role, the active source instance identity and the registered producing worker.

The broader release gate accepts an ordinary retained-point acknowledgment as well as a storage-only acknowledgment. It verifies the local attempt, result, job, promise, signed point, independently restored registered worker report and HZ-owned 0207 original. A selected or live source, missing or conflicting custody, unsupported byte size, active scientific dependency or insufficient measured savings keeps the original inline. Source-only backups remain available independently with the original archive operator.

The worker compares the actual point status, source and regime with the immutable report projector. It checks the inventoried channels rather than choosing a result by its solver label. The normal API and sweeper must replay every original byte. The 0213 continuation checker preserves cycle certificates, force samples, selected physical windows and frame cadence. The shared job classifier, promotion decisions and fitted curve must agree on the original and projected inputs. After publication the worker rechecks the original through the normal sources, recomputes actual job decisions and verifies the selected point and its interpretations. The event's post-readback stamp requires those values to match the sealed before-proof. A failed post-transition check restores the exact original in a bounded transaction.

After the matching integrated release is running on both hosts, use the existing controller with the following options.

```sh
attempt_history plan --include-retained --until-complete
attempt_history migrate --include-retained --apply --id "$HZ_ATTEMPT_ID" \
  --bucket "$HUB_BUCKET" --hub-account-file "$HUB_ACCOUNT_FILE"
attempt_history status
```

Repeat the canary to verify its original generation and zero additional reclaimed value bytes. A wider fixed scan uses a separate checkpoint filename in the same operator directory. To run archive-only copying and wider scientific transitions sequentially in the same durable watcher, add `--originals-directory`. It gives bounded time slices to the original-copy controller between shortening pages and during the ordinary polling wait. A finite supplied `--originals-scope` preserves its exact membership. Without that option the original inventory periodically revisits newly created UUIDs and sources that settle later.

```sh
attempt_history watch --apply --include-retained --directory "$HZ_ATTEMPT_STATE" \
  --originals-directory "$HZ_ORIGINALS_STATE" \
  --bucket "$HUB_BUCKET" --hub-account-file "$HUB_ACCOUNT_FILE"
```

When transferring an already running standalone original-copy job into the combined watcher, quiesce that job at a bounded page during the coordinated operator handoff and reuse its directory and scope. PostgreSQL shortening measurements and original-copy progress have separate counters. The original-copy controller's `status` command can inspect its SQLite receipts while the combined watcher runs.


### Frozen original versions with an unsettled producing job

The archive-only supervisor can run a finite `versions` pass after its registered
backup drains. Use the frozen scope, checkpoint directory, canonical hub account
pin and SSH aliases from that backup. Run it in the same captured operator
service during an open transfer window.

```sh
python3 scripts/deploy/hz-attempt-originals.py versions --apply --until-complete \
  --directory "$HZ_ORIGINALS_STATE" --scope "$FROZEN_SCOPE" \
  --bucket "$HUB_BUCKET" --hub-account-file "$HUB_ACCOUNT_FILE"
```

For each deferred attempt, the HZ reader validates the native worker, signed
request, producing job and exact result and attempt IDs in a read-only snapshot.
The immutable object key binds its HZ source instance, local attempt, original
UTF-8 hash and compressed hash. The hub uses its existing identity for conditional
creation and fresh generation reads. The controller records the generation
before confirming the restored envelope, history inventory and current source.
The HZ transfer fence, deployment lock, frozen scope and per-source byte limits
apply on replay.

The `versionOnly` status counts come from `original_versions` in the existing
private SQLite checkpoint. `verified-current` means the frozen source still
matched at the final HZ observation. `verified-superseded` preserves the frozen
object and records the changed live source. `source-changed` means the frozen
bytes were already unavailable at capture. A new frozen selection can preserve a
later revision under its own object key. The version pass leaves PostgreSQL
payloads and application selections intact. Ordinary registration after settlement
can adopt the same object through its existing source check.


For an unscoped live inventory, add `--capture-live-versions` to the existing
`backup` or `cycle` invocation. Each completed inventory row already pins its
worker, attempt, producing job, result and original source digest and size.
The single backup lane authenticates those pins, processes outstanding generations
first, and prioritizes sources that had no archive at inventory. A deferred source
can receive a version-only object through the same signed-owner and readback path.
The ordinary registration and version receipt counters can overlap for a source
that later settles. Existing scans with older exclusion tallies report those
counts as unknown. A fresh inventory tallies each page exactly.
