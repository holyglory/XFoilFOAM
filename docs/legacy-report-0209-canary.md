# One-page HZ canary for historical scientific reports

Use the integrated operator with the 0209 custody helper installed in the worker sweeper, migration 0209 present on HZ, and the normal worker archive reader active in both sweeper and node API. Check the installed source/build identities against the release being tested. The worker's API and sweeper must open the same persistent results volume. Keep the configured registration and fetch permissions as they are. The hub performs the pinned GCS read under its existing workload identity.

The commands use Bash, jq, and the targets and `legacy_reports` function in [the legacy operator instructions](legacy-report-storage.md). Run them from the integrated release checkout. Use the original frozen scope, the original copy receipt, its prior 0205 custody receipt, and the independently recorded private canary contract supplied with this page. Keep the contract and both receipts outside the canary directory. The contract fixes the job, object, interval, staged source, exact change set and scientific digests.

## Pin the input and establish the baseline

```bash
set -euo pipefail
umask 077
: "${CANARY_CONTRACT:?private canary-contract.json}"
: "${COPY_RECEIPT:?original immutable .receipt.json}"
: "${PRIOR_CUSTODY:?original 0205 .custody-applied.json}"
: "${HZ_SWEEPER_CONTAINER:?installed worker sweeper}"
: "${HZ_NODE_API_CONTAINER:?installed worker API}"
run=$(mktemp -d)
mkdir "$run/receipts"
receipt_sha=$(jq -er '.archiveReceiptSha256' "$CANARY_CONTRACT")
test "$(sha256sum "$COPY_RECEIPT" | cut -d' ' -f1)" = "$receipt_sha"
name=$(jq -er '"\(.archiveReceiptSha256).\(.object.sha256).\(.object.generation).receipt.json"' "$CANARY_CONTRACT")
cp -- "$COPY_RECEIPT" "$run/receipts/$name"
jq -ens --slurpfile c "$CANARY_CONTRACT" --slurpfile a "$COPY_RECEIPT" --slurpfile p "$PRIOR_CUSTODY" '
  $c[0] as $k | $a[0] as $r | $p[0] as $old | $old.proof.custody.custody as $sql |
  $r.object==$k.object and $r.memberCount==45 and $r.scopeSha256==$k.scopeSha256 and
  $r.sourceInstance==$k.sourceInstance and $r.solverId==$k.solverId and
  $old.archiveReceiptSha256==$k.archiveReceiptSha256 and $old.object==$r.object and
  ($sql.readMembers | map(.sequence))==[range($k.first;$k.last+1)] and
  all($sql.readMembers[]; .executionId==$k.job and .kind=="report") and
  ($sql.changedMembers|length)==9 and ($sql.skipped|map(.sequence))==$k.change and
  all($sql.skipped[]; .reason=="report_not_staged") and ($k.change|length)==36'
legacy_reports verify "${legacy_hub[@]}" --scope="$LEGACY_REPORT_SCOPE" \
  --receipt="$run/receipts/$name" > "$run/hub-before.json"
jq -es --slurpfile k "$CANARY_CONTRACT" '.[0] |
  .verified and .members==45 and .generation==$k[0].object.generation and .sha256==$k[0].object.sha256' "$run/hub-before.json"
jq '{version:1, sourceInstance:.proof.custody.custody.sourceInstance,
     solverId:.proof.custody.custody.solverId, scopeSha256, object, members:.proof.custody.verifiedMembers}' \
  "$PRIOR_CUSTODY" > "$run/expected-members.json"
worker_read() {
  ssh "$HZ_SSH_HOST" docker exec -i "$HZ_NODE_API_CONTAINER" node --import tsx \
    /app/apps/sweeper/src/legacy-worker-report-product-read-cli.ts < "$run/expected-members.json" > "$1"
  jq -es --slurpfile q "$run/expected-members.json" '.[0] |
    .verified and .readMode=="hub-local-reader" and .volumeObjectReads==1 and
    .memberCount==45 and .members==$q[0].members and .object.generation==$q[0].object.generation and
    .object.sha256==$q[0].object.sha256 and .storedBytesRead==$q[0].object.byteSize' "$1"
}
worker_read "$run/hz-before.json"
```

Take a read-only HZ snapshot scoped to the contract's job. Save the 45 ordered `sequence, content_signature, acknowledged_at, result_payload_hash, archived_at, archive_bundle_id` rows and catalog member identities. Require nine cold rows with their original bundle and exactly the contract's 36 warm rows, all referencing its `resultSha256`. Record a worker report outside the page referencing the same hash and the payload's byte size. Stop if this baseline has changed.

Save sorted IDs and row digests for this job's results, attempts, staged receipts and point associations, hub receipts, delivery claims, job and promise, and any dispatch. Check terminal ingestion, closed ownership, stopped namespace and settled delivery. The staging receipt must bind the original staged report signature. Recompute the point signatures with `progressiveReportedPointSources` on its restored result and match every signature to one actual same-job and same-engine attempt. Verify the frozen attempt ID. Capture these same projections after the transaction.

In the verified original page, check every exact report byte size and SHA, then its independent canonical signature. Use the original PostgreSQL text of the `result` field for its digest. Confirm eight null results and 37 copies of the one non-null value, including the staged sequence. Independently hash the UTF-8 JSON encoding of the ordered coefficient tuples `[aoa_deg, cl ?? null, cd ?? null, cm ?? null]` in each polar's point order followed by its attempt order. Compare both scientific digests to the private contract.

## Apply exactly one receipt and check the outcome

After the preflight matches, run only the receipt in the newly created directory. A listing without `--apply` reports pending work. The fresh hub and worker reads establish custody on the apply path. An unavailable reader, a fallback to 0198, or a different terminal/ownership state ends this canary.

```bash
page_args=("${legacy_targets[@]}" "--scope=$LEGACY_REPORT_SCOPE" "--directory=$run/receipts"
           "--worker-sweeper-container=$HZ_SWEEPER_CONTAINER" --registered-get=denied --pages=1)
legacy_reports migrate-receipts "${page_args[@]}" > "$run/plan.json"
jq -e '.receipts==1 and .remaining==1 and .applied==0' "$run/plan.json"
legacy_reports migrate-receipts "${page_args[@]}" --apply --readers-ready > "$run/applied.json"
jq -e '.receipts==1 and .remaining==0 and .applied==1' "$run/applied.json"
attempts=("$run"/receipts/custody-attempt-*.json)
test "${#attempts[@]}" -eq 1
jq -es --slurpfile k "$CANARY_CONTRACT" --slurpfile q "$run/expected-members.json" '
  $k[0] as $k | .[0] as $a | $a.proof.custody as $w | $w.custody as $r |
  $a.archiveReceiptSha256==$k.archiveReceiptSha256 and $a.object==$k.object and
  $w.mode=="custody" and $w.transactionCommitted and $w.coldReleaseComplete and
  $w.pageReads==1 and $w.replayMembersVerified==45 and $w.verifiedMembers==$q[0].members and
  $w.newlyNormalizedReports==0 and $w.remainingWarmReports==0 and $r.readMode=="hub-local-reader" and
  $r.duplicateReports==36 and $r.compactedReports==36 and $r.replayedMembers==9 and
  $r.registeredBundles==0 and $r.registeredMembers==36 and $r.compactedConflicts==0 and
  $r.aliasesRetained==0 and $r.skipped==[] and $r.prunedSharedPayloads==0 and $r.prunedSharedPayloadBytes==0 and
  ($r.changedMembers|map(.sequence))==$k.change and all($r.changedMembers[];
    .executionId==$k.job and .scientificSource.stagedSequence==$k.staged and
    .scientificSource.stagedReportContentSignature==$k.stagedContentSignature and
    .scientificSource.stagedReportSha256==$k.stagedReportSha256 and
    .scientificSource.resultSha256==$k.resultSha256 and .scientificSource.resultByteSize==$k.resultBytes)' "${attempts[0]}"
worker_read "$run/hz-after.json"
```

Require all 45 original report rows and one catalog member per sequence, with the same content signature, original full-report SHA and byte size as the pinned page. Check the nine previous archive pointers and all protected scientific/ownership projections against the baseline. Restore the staged sequence and the first and last newly cold reports through the API's installed full-report reader, then verify their individual full-body and canonical signatures and their common result and coefficient digests. The separate worker reference and its exact payload must still exist. Retain the private preflight, SQL receipt and post-read evidence together. Investigate any mismatch before another page. Following a lost acknowledgement, read back the identities and replay the identical pinned receipt.

Across later pages, a page containing the genuinely staged report can register its compact scientific proof even when 0205 already archived it. Revisit earlier skipped pages after that source is authenticated. A known shared payload can be deleted only by a newly compacted exact original releasing its final worker or hub reference. A replay-only page can report zero deletions. The receipt counts logical PostgreSQL payload bytes. Filesystem recovery is a separate measurement.
