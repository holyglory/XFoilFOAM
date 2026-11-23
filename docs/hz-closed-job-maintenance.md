# HZ closed-job duplicate storage maintenance

Run this operator from a committed checkout on the controller with the existing
`hz-solver2` SSH identity. It runs short-lived processes with `docker exec` in
the installed sweeper and gateway. The worker supplies a read-only witness of
its results volume and the exact device and inode of the job's execution lock.
The serving gateway, worker and sweeper keep running throughout. The operator
uses the existing hub download route and workloads' existing credentials.

## One job

Select one row from the operator's private inventory and use its stable job UUID and plan digest.

```bash
job=$(jq -er '.id' <<<"$candidate")
plan=$(jq -er '.plan' <<<"$candidate")
python3 scripts/deploy/hz-closed-job-maintenance.py proof "$job" "$plan"
```

A successful proof returns `status=proved`, `databaseReadOnly=true`,
`settled=false`, the current plan, and one fresh generation/size/SHA readback
per archive. The receipt includes the helper and deployed revisions, running
container IDs and images, and lock device/inode. Source or ownership drift,
a held execution or deployment lock, forensic bytes, unbound media, an
uncovered case or artifact, and a failed download all stop that job.

For a separately authorized removal, run the same operator with the exact
reviewed plan.

```bash
python3 scripts/deploy/hz-closed-job-maintenance.py reclaim "$job" "$plan"
```

The reclaim repeats the native preview and every full cloud read. It locks
the job row in PostgreSQL, rechecks the live ownership and the identical signed
receipt set, and holds that transaction while the native process applies the
plan under the engine's `.execute.lock`. A durable file intent precedes the
first unlink. Its completion precedes the PostgreSQL receipt. After a lost
reply, repeat the same job and plan. A matching committed receipt returns
`already-settled` with zero additional bytes. A refusal leaves the remaining
files available. Inspect its reason before retrying that job.

## Bounded batches

Use the operator's private `ready-candidates.jsonl` export. Each line carries
a stable job UUID and its verified plan SHA. Use the recorded SHA-256 for that private export. `batch` defaults to proof and processes at most eight
jobs serially. The next invocation takes the returned `nextOffset`. Save the
JSONL output on the controller.

```bash
umask 077
python3 scripts/deploy/hz-closed-job-maintenance.py batch "$inventory" \
  --sha256 "$inventory_sha256" \
  --offset 0 --limit 4 > proof-0.jsonl
```

Add `--apply` to run the separately authorized reclaim for those pinned rows.
Exit 1 reports one or more individual refusals. Each attempted row still emits
its own receipt. Exit 2 indicates a controller, host, package or transport
failure. Resume from the first row without a receipt using the same inventory.
The indicated bytes are gross logical file sizes. Filesystem allocation and
durable receipt overhead affect net volume space.

## Execution and custody

The SSH session holds the host's shared deployment lock during each job. It
pins the running Compose containers, verifies their common named results volume,
compares installed dependency hashes with reviewed source, and loads the
committed helper in memory in new processes. A nonce-bound MAC authenticates
both directions with the existing engine control-plane token. The token stays
inside the two services. Proof opens the existing lock read-only and acquires
an exclusive nonblocking flock. Reclaim invokes the installed engine retention
guard and checks that same worker lock identity inside the guard. The SQL
custody, per-artifact inventory, generation-pinned GCS download, file plan,
intent and replay checks are shared with the verified retention implementation.

The default sweeper continues using its installed retention backend. This
operator never retries a refusal through whole-job deletion or generic strip.
No migration, remote helper installation, new listener, or engine maintenance
window is needed for the matched HZ runtime.

## Single restartable inventory run

After verified canaries, use a controller service with a fixed, committed
checkout as its working directory. Keep the original inventory and its digest.
Send the following command through the controller's existing supervisor.
The absolute state directory must be private to the operator.

```bash
python3 scripts/deploy/hz-closed-job-maintenance.py run-inventory "$inventory" \
  --sha256 "$inventory_sha256" --state "$private_state" \
  --runtime-proof "$verified_canary_receipt" --apply
```

Use a successful read-only canary verification from this helper as the runtime pin. A changed container image triggers a new read-only verification of that canary with the original dependency, plan and science fingerprints. A dependency mismatch stops before removal.

The operator processes one job at a time under an exclusive controller lock.
A job with a positive plan gets a fresh complete read of each object before
removal. A separate read-only process then verifies the durable filesystem
completion, reads the immutable point coefficients and payload signatures,
and restores every archived object again. A matching previously committed
plan goes straight to verification. An individual refused plan is recorded
as deferred. A transport failure or post-removal verification failure leaves
a pending receipt and stops the pass. Restart the identical command to resume.
A runtime source or authentication mismatch requires checking the installed
version before resuming.

For an individual canary, save the output of `proof` privately and pass
`--proof-receipt "$proof_file"` to `reclaim` to pin the earlier scientific
signature and container/lock identities. The read-only `verify JOB_UUID
PLAN_SHA256` command independently rechecks an already settled job.
`status.json` reports checked, verified and deferred counts, logical bytes,
unlinked file allocation, and allocation after accounting for receipt files
and directory blocks. Per-job receipts also record the volume's observed free
bytes. Concurrent solver writes can change that volume-wide measurement.

## Preserve local PNG media for one named job

The single-job commands support `--keep-media` for closed RANS jobs with
current, path-owned instantaneous PNG rows and a complete signed archive for
every attempt. The inventory-run and automatic selection use their existing
rules. The keep-set comprises the exact scaled files registered in PostgreSQL
and the original images declared by each matching engine result and archived
manifest. Uncovered media, a changed file, an unexpected link or directory,
a forensic package, an active writer or a live continuation refuses the job.

```sh
python3 scripts/deploy/hz-closed-job-maintenance.py proof --keep-media "$job" >"$private_proof"
plan=$(jq -er 'select(.status=="proved" and .databaseReadOnly and .plan.files>0 and .mediaSha256) | .plan.plan' "$private_proof")
python3 scripts/deploy/hz-closed-job-maintenance.py reclaim --keep-media \
  --proof-receipt "$private_proof" "$job" "$plan"
python3 scripts/deploy/hz-closed-job-maintenance.py verify --keep-media "$job" "$plan"
```

The proof pins the running read-only Node API container and the installed media and point-detail modules. It binds each image path, SHA-256 and length, the original media ID and
display metadata, and the working-file plan. It reads the stable media IDs,
legacy paths, engine file paths and point-detail links/legends. A
`reclaim` repeats the complete proof, including every pinned CFD archive,
takes the original SQL and engine locks, and removes only unreferenced,
hash-identical older saved fields and postprocessing files. It preserves the
latest restart fields and the job's shared mesh. The native peer inventories
the surviving images again before completing its durable receipt. A separate
read-only pass verifies the served bytes, point evidence and legends after
commit. The file allocation in the proof is gross; the completed receipt also
measures the filesystem allocation occupied by the durable controls.

## Follow a raw-file inventory with a media inventory

On the trusted controller, `scripts/deploy/hz-closed-job-media-queue.py CONFIG --sha256 DIGEST`
runs the two frozen operators in one supervised process. The private configuration
pins the original inventory, manifest, operator checkout and runtime proof,
and separately pins the media roster, keep-media checkout and successful media
canary verification. Individual media rows identify their exact job, expected
attempt count, media IDs and signed objects. Measured rows also carry the
native plan digest, file count, logical bytes and allocated bytes.

The controller can process one explicitly named, measured media job in a
vacant slot. It then runs the original inventory command against its existing
checkpoints. The remaining media jobs run only after every original row has
a terminal receipt. The media operator takes the original inventory lock,
requalifies its canary, and obtains a fresh proof and generation-pinned read
for each named job. A successful proof is persisted before applying its exact
plan. A lost response is recovered by a read-only verification of that plan.
Transport faults keep their pending receipts. Individual proof refusals are
recorded and the next media row can proceed. The same supervisor controls
quiescence and recovery for both inventories.

## Closed historical raw archives

Use `--historical-raw` for terminal jobs whose original registered solver stored the raw bundles under migration 0220. Use `--keep-media` as well when the job owns registered instantaneous images. Each terminal point must have a matching original archive or completed ordinary custody. An undeclared bundle, another case, unsettled delivery, conflicting owner or incomplete file proof holds the entire job.

The hub Node API serves the original owner's immutable receipt and generation. The HZ Node API authenticates the local gateway and binds the request to its exact report, attempt, directory, manifest and bundle. The HZ Python file-serving API needs both `airfoilfoam.api.main` and `airfoilfoam.historical_raw_restore` from the reviewed source. Reclaim verifies their installed digests and exercises the running gateway. The physical solver worker supplies its existing volume and lock witness.

```bash
operator=scripts/deploy/hz-closed-job-maintenance.py
python3 "$operator" proof "$job" --historical-raw >"$proof_receipt"
plan=$(jq -er 'select(.status=="proved" and .databaseReadOnly and .plan.files>0) | .plan.plan' "$proof_receipt")
python3 "$operator" reclaim "$job" "$plan" --historical-raw --proof-receipt "$proof_receipt"
```

The read-only proof bypasses the local copy at the original file URL and verifies the complete registered archive plus a manifest member when available. The worker's sync admission limit also applies to these reads. Under the job lock, the operator checks each candidate against the authenticated archive, creates the per-directory restore markers, and records the exact file plan before removal. The manifest, work directories, continuation inputs, retained media and core files keep their original paths. After removal the operator reopens the original file URLs and the HZ media download, and compares the scientific fingerprint and generation. The receipt reports net attributed allocated bytes separately from filesystem free-space changes caused by other work.
