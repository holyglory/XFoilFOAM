# Reading HZ attempt histories from immutable worker reports

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

The bounded reader covers completed, unselected steady RANS attempts from a settled cancelled worker job with a closed scheduling promise. It requires a storage-only hub acknowledgment for the exact local attempt, result, sequence and point, and a locally archived final report with verified stop evidence. Each check accepts one attempt of at most 256 KiB of PostgreSQL text. A bundle may contain up to 128 members, 16 MiB packed and 32 MiB decoded, with at most 4 MiB per reconstructed report. An unsupported, absent or conflicting source fails the check.

To measure one page of the full attempt table after the field-audit fix is deployed, run the existing storage audit on HZ. It returns grouped PostgreSQL field byte counts, inspected and skipped rows, and a continuation ID. Follow its continuation with `--after UUID` for the next page.

```sh
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no hz-solver2 \
  docker exec -i hz-solver2-sweeper-1 node --import tsx \
  /app/apps/sweeper/src/attempt-evidence-storage-cli.ts audit --limit 64 --pages 1
```

## Product read and retention

Server code can call `readStoredAttemptEvidenceText(db, hzAttemptId, { source: "worker-report" })`. It follows the attempt’s worker acknowledgment and staged association to the exact report bundle and member on the HZ volume. It verifies the assignment and point signature, applies the normal delivery projector, and asks PostgreSQL to serialize the result. It compares the bytes and digest with the original HZ source. No sampling, unit conversion, numeric token substitution or new delivery occurs.

The existing HZ rows already identify the report member through execution, sequence, report signature and point signature. This release uses the inline attempt as the independent full-source digest and length. Releasing that inline source would additionally require durable custody binding the HZ attempt and result, hub attempt and result, exact object generation and full-source digest, plus a guaranteed local working copy. Check the real stable-ID application read before and after a transition. Retain a working-volume reference independent of report-file reclamation before relying on the file as the last accessible copy.

Attempt shortening also requires the 0208 scientific checks for classification, payload equality, replay and the fitted polar. The HZ writer must account for worker delivery, outbox replay and existing interpretations of the exact attempt. The 0210 stopped-progressive predicate uses the hub's dispatch, stop and superseding attempt. A storage-only acknowledgment on HZ alone cannot establish that predicate. The operator here performs readback only. PostgreSQL continues serving its full original attempt and the existing point-history watcher runs independently.
