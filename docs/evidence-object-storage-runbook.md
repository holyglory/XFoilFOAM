# GCS Zstandard evidence migration runbook

This runbook moves finalized solver evidence from the production Docker volume
to immutable, content-addressed `tar.zst` objects in the private Google Cloud
Storage bucket `airfoils-pro-storage-bucket`. It applies to the OpenCFD 2606
rollout and to legacy gzip evidence already on the VPS.

The migration is intentionally fail-closed:

- only terminal jobs (`completed`, `failed`, or `cancelled`) are eligible;
- the Python migrator takes the job's non-blocking `.execute.lock`, so an active
  job is skipped/refused rather than changed;
- GCS uploads use create-only generation preconditions and record the exact
  generation, CRC32C, compressed SHA-256, and uncompressed-tar SHA-256;
- an initial generation-pinned archive download plus exact manifest/VTK restore
  proves the upload, but removes no local packaged source;
- the generated `tar.zst`, legacy gzip bundle, and packaged raw directories all
  remain local until Postgres has registered that exact GCS generation against
  the exact result attempt; and
- a second fresh remote restore plus a validated database acknowledgement is
  required before any of those local packaged sources are deleted.

Do not replace any step with a raw `docker compose up --force-recreate`, a
manual database insert, a bulk `rm`, or an unpinned GCS download.

## 1. Operator variables and audit directory

Run production commands on the VPS as the deployment operator. Use the same
explicit Compose target for every command:

```bash
set -Eeuo pipefail

export APP_DIR=/opt/airfoils-pro/app
export AIRFOILS_PRO_STATE_DIR=/opt/airfoils-pro/state
export ENV_FILE="$AIRFOILS_PRO_STATE_DIR/.env.deploy"
export COMPOSE_FILE="$APP_DIR/docker-compose.deploy.yml"
export COMPOSE_PROJECT_NAME=app
export BUCKET=airfoils-pro-storage-bucket
export OBJECT_PREFIX=solver-evidence/v1
export AUDIT_DIR="/opt/airfoils-pro/audit/gcs-evidence-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$AUDIT_DIR"

compose() {
  docker compose --env-file "$ENV_FILE" \
    -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

SOURCE_FIELDS="$(
  python3 "$APP_DIR/scripts/deploy/deployment-source-manifest.py" \
    --verify --root "$APP_DIR" \
    --manifest "$APP_DIR/.deployment-source.json" \
    | tee "$AUDIT_DIR/deployment-source.tsv"
)"
IFS=$'\t' read -r SOURCE_REVISION SOURCE_TREE_SHA256 SOURCE_FILE_COUNT \
  <<<"$SOURCE_FIELDS"
test "${#SOURCE_REVISION}" -eq 40
test "${#SOURCE_TREE_SHA256}" -eq 64
compose config --services >"$AUDIT_DIR/compose-services.txt"
compose ps | tee "$AUDIT_DIR/compose-before.txt"
df -B1 "$APP_DIR" | tee "$AUDIT_DIR/disk-before.txt"
```

If `docker compose` is unavailable, use `docker-compose` consistently; do not
mix project names or Compose files. Keep `AUDIT_DIR` outside `APP_DIR`. The
deployment workflow materializes an exact verified source under the sibling
`releases/` directory and atomically switches the `APP_DIR` symlink; it never
edits the live release tree in place. `ENV_FILE` is a mode-0600, non-symlink
state file outside every replaceable release.

The GitHub deployment also requires the `AIRFOILS_VPS_KNOWN_HOSTS` secret. On
an already trusted operator workstation, obtain the VPS public host-key line,
verify its SHA256 fingerprint through an independent trusted channel (for
example the GCE serial console or an earlier approved inventory record), and
only then save that exact line as the secret. For a non-default SSH port the
known-host name must be `[host]:port`. Check the prepared value before saving:

```bash
KNOWN_HOST_LOOKUP="$VPS_HOST"
if [[ "$VPS_PORT" != 22 ]]; then
  KNOWN_HOST_LOOKUP="[$VPS_HOST]:$VPS_PORT"
fi
printf '%s\n' "$OPERATOR_VERIFIED_KNOWN_HOST_LINE" > /tmp/airfoils-known-host
chmod 600 /tmp/airfoils-known-host
ssh-keygen -F "$KNOWN_HOST_LOOKUP" -f /tmp/airfoils-known-host
ssh-keygen -lf /tmp/airfoils-known-host -E sha256
rm -f /tmp/airfoils-known-host
```

Treat the displayed fingerprint as operator-verified input, not as something
the deployment workflow may discover on first contact. `ssh-keyscan` output by
itself is not trust evidence and is intentionally not used by the workflow.

## 2. GCE identity, IAM, and bucket policy

Production uses the service account attached to the GCE VM through Application
Default Credentials (ADC). Do **not** create, copy, mount, or set
`GOOGLE_APPLICATION_CREDENTIALS` to a downloadable JSON key.

From an authenticated Google Cloud operator workstation, discover the attached
identity and grant it only object creation and read access at the bucket. These
are workstation variables; record the resulting service-account email for the
VPS check below:

```bash
export BUCKET=airfoils-pro-storage-bucket
export PROJECT_ID=holyutils
export VM=airfoils-pro
export ZONE=europe-west3-b
export VM_SERVICE_ACCOUNT="$(
  gcloud compute instances describe "$VM" \
    --project "$PROJECT_ID" --zone "$ZONE" \
    --format='value(serviceAccounts[0].email)'
)"
test -n "$VM_SERVICE_ACCOUNT"

VM_SCOPES="$(
  gcloud compute instances describe "$VM" \
    --project "$PROJECT_ID" --zone "$ZONE" \
    --format='csv[no-heading](serviceAccounts[0].scopes)'
)"
case "$VM_SCOPES" in
  *cloud-platform*|*devstorage.read_write*) ;;
  *) echo 'VM OAuth scopes do not permit object creation' >&2; exit 1 ;;
esac

gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$VM_SERVICE_ACCOUNT" \
  --role=roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$VM_SERVICE_ACCOUNT" \
  --role=roles/storage.objectViewer
```

The application creates content-addressed objects and reads exact generations;
it does not need an application-level delete role. Keep destructive object
administration on a separate operator identity.

Verify the bucket is Standard storage in the EU multi-region, has uniform
bucket-level access, enforces public-access prevention, and has a 30-day
soft-delete window. There must be no lifecycle rule that deletes live solver
evidence:

```bash
gcloud storage buckets update "gs://$BUCKET" \
  --uniform-bucket-level-access \
  --public-access-prevention \
  --soft-delete-duration=30d

export BUCKET_AUDIT="${PWD}/airfoils-pro-storage-bucket.json"
gcloud storage buckets describe "gs://$BUCKET" --format=json \
  | tee "$BUCKET_AUDIT" \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["name"] == "airfoils-pro-storage-bucket"
assert d["location"] == "EU"
assert d["default_storage_class"] == "STANDARD"
assert d["uniform_bucket_level_access"] is True
assert d["public_access_prevention"] == "enforced"
assert int(d["soft_delete_policy"]["retentionDurationSeconds"]) == 30 * 86400
assert not d.get("lifecycle"), "remove live-object deletion lifecycle rules"
print("bucket policy verified")
'
```

On the VPS, confirm that ADC resolves to the intended attached identity. This
is read-only and does not expose a credential. Copy the email printed by the
workstation command into `EXPECTED_VM_SERVICE_ACCOUNT` (not a secret), and copy
the bucket audit JSON into the protected deployment audit directory:

```bash
export EXPECTED_VM_SERVICE_ACCOUNT='<service-account-email-from-workstation>'
curl -fsS -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email' \
  | tee "$AUDIT_DIR/vm-service-account.txt"
grep -Fx "$EXPECTED_VM_SERVICE_ACCOUNT" "$AUDIT_DIR/vm-service-account.txt"
```

If the VM has no service account, or the identity is wrong, stop. Attach the
intended service account to the VM through GCE maintenance and grant the bucket
roles above. A service-account key is not a fallback.

## 3. Production environment

Set these exact entries in `.env.deploy` before either deployment script runs:

```dotenv
AIRFOILFOAM_EVIDENCE_BUCKET=airfoils-pro-storage-bucket
AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1
AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10
AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true
AIRFOILFOAM_CONTROL_PLANE_TOKEN=<unquoted-random-secret-at-least-32-characters>
AIRFOILFOAM_EVIDENCE_HYDRATION_CACHE_MAX_GB=50
AIRFOILFOAM_EVIDENCE_HYDRATION_CACHE_TTL_SECONDS=86400
AIRFOILFOAM_EVIDENCE_GCS_TIMEOUT_SECONDS=900
OPENCFD2606_CUTOVER_PENDING=0
OPENCFD2606_CUTOVER_COMPLETE=0
OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=
OPENCFD2606_CANARY_ATTESTATION_ID=
OPENCFD2606_CANARY_RECEIPT_EXPECTED=0
OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256=
OPENCFD2606_CUTOVER_SOURCE_REVISION=
OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256=
```

`docker-compose.deploy.yml` fixes the cache path at
`/data/airfoilfoam/evidence-hydration-cache` for the gateway and workers. Verify
the effective values without printing unrelated secrets:

```bash
for key in \
  AIRFOILFOAM_EVIDENCE_BUCKET \
  AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX \
  AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL \
  AIRFOILFOAM_EVIDENCE_REMOTE_ONLY \
  AIRFOILFOAM_EVIDENCE_HYDRATION_CACHE_MAX_GB \
  AIRFOILFOAM_EVIDENCE_HYDRATION_CACHE_TTL_SECONDS \
  AIRFOILFOAM_EVIDENCE_GCS_TIMEOUT_SECONDS
do
  grep -E "^${key}=" "$ENV_FILE"
done | tee "$AUDIT_DIR/evidence-env.txt"

if grep -q '^GOOGLE_APPLICATION_CREDENTIALS=' "$ENV_FILE"; then
  echo 'Refusing a service-account key configuration' >&2
  exit 1
fi

compose config >/dev/null
```

Generate `AIRFOILFOAM_CONTROL_PLANE_TOKEN` with a cryptographically secure
generator (for example, `openssl rand -hex 32`) and write it directly into the
mode-0600 state file without printing it into an audit log. Write as the
deployment user; an atomic root-owned replacement must restore the existing
file's uid/gid before promotion, because the deployment preflight deliberately
rejects owner drift before any service mutation. The Compose files map that one
authoritative value to `ENGINE_CONTROL_PLANE_TOKEN` only inside the sweeper and
media-repair processes that acknowledge database registration; do not maintain
a second independently editable copy. The deployment preflight rejects
remote-only evidence when the token is missing, quoted, contains whitespace,
is shorter than 32 characters, or leaves the protected file under another
owner.

The empty certified-contract marker is valid only for this exact pristine,
pre-canary state. The guarded cutover writes it atomically with the durable
attestation id. Never calculate, copy, clear, or edit that hash manually: all
later control-plane deploys, engine rebuilds, and continuation replays must
reproduce the certified bucket, prefix, Zstandard level, and remote-only
disposition or fail closed.

The guarded engine rebuild independently rejects a missing bucket, unsafe
prefix, Zstandard level outside 1--22, or `REMOTE_ONLY` other than `true`.

## 4. Strongly verified Postgres backup

Migration `0067_solver_evidence_object_storage.sql` is additive, but it still
changes the live database. Before the control-plane deployment, use the
`postgres-docker-backup` skill (v2.1 or later) to create a database-scope custom
dump and prove it through a scratch-database restore. `POSTGRES_BACKUP_TOOL`
below is the absolute path to that skill's reviewed
`scripts/postgres_docker_backup.py`, staged on the VPS if necessary; it is not a
file from this repository.

```bash
export POSTGRES_BACKUP_TOOL=/secure/tools/postgres_docker_backup.py
test -f "$POSTGRES_BACKUP_TOOL"
PG_CID="$(compose ps -q postgres)"
test -n "$PG_CID"
PG_ID="$(docker inspect --format '{{.Id}}' "$PG_CID")"
PG_NAME="$(docker inspect --format '{{.Name}}' "$PG_CID" | sed 's#^/##')"

install -d -m 0700 "$AUDIT_DIR/postgres"
python3 "$POSTGRES_BACKUP_TOOL" backup \
  --container "$PG_NAME" \
  --expect-container-id "$PG_ID" \
  --database aerodb \
  --user aerodb \
  --out-dir "$AUDIT_DIR/postgres" \
  | tee "$AUDIT_DIR/postgres-backup.json"

PG_DUMP="$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["backup"])
' "$AUDIT_DIR/postgres-backup.json")"

python3 "$POSTGRES_BACKUP_TOOL" verify \
  --container "$PG_NAME" \
  --expect-container-id "$PG_ID" \
  --file "$PG_DUMP" \
  --test-restore \
  | tee "$AUDIT_DIR/postgres-verify.json"
```

Do not continue unless the backup, checksum/manifest verification, scratch
restore, catalog comparison, and scratch cleanup all succeed. Preserve the dump
and its `.manifest.json` outside the Docker volume until rollout is complete,
and copy both to protected operator-controlled storage off the VPS before
destructive migration. Do not place the database backup under the solver
evidence object prefix.

## 5. Deploy the control plane and migration 0067

Deploy the Node control plane first. This stops only the old Node writers while
`node-api` starts, applies all pending migrations (including 0067), and seeds;
it deliberately does not recreate `api` or any OpenFOAM worker:

```bash
cd "$APP_DIR"
scripts/deploy/vps-redeploy.sh 2>&1 | tee "$AUDIT_DIR/control-plane-deploy.log"
```

Verify the three new relations exist before any evidence migration:

```bash
compose exec -T postgres psql -U aerodb -d aerodb -v ON_ERROR_STOP=1 -Atc \
  "SELECT to_regclass('public.solver_evidence_blobs'),
          to_regclass('public.solver_evidence_archives'),
          to_regclass('public.solver_evidence_artifact_members');" \
  | tee "$AUDIT_DIR/migration-0067-relations.txt"
grep -F 'solver_evidence_blobs|solver_evidence_archives|solver_evidence_artifact_members' \
  "$AUDIT_DIR/migration-0067-relations.txt"

compose logs --no-color --tail=200 node-api \
  | tee "$AUDIT_DIR/node-api-after-migration.log"
curl -fsS http://127.0.0.1:4000/health >/dev/null
```

Never hand-create these rows. The backfill resolves one receipt to one existing
bundle artifact, result, attempt, job, case slug, and AoA, then applies the
ordinary evidence-registration path.

## 6. Guarded OpenCFD 2606 engine rebuild and remote-render canary

The Python gateway and workers need the new GCS/Zstandard code and locked
dependencies. Engine maintenance is allowed only through
`scripts/deploy/rebuild-engine.sh`. The script checks every configured and
known worker, rejects hidden profiled workers, drains the 2406-to-2606 cutover,
and proves the queue/process set idle before the build and twice before
recreation. A refusal means wait and retry; never bypass it.

For the first 2406-to-2606 cutover, supply the signed admin session cookie so
the script can pause, drain, attest, create exact successor campaign
generations, and restore the prior scheduler intent:

```bash
export BUILD_ID="prod-$(date -u +%Y%m%d)-${SOURCE_REVISION:0:12}"
read -rsp 'aero_admin cookie value: ' ADMIN_TOKEN; echo
export ADMIN_COOKIE="aero_admin=$ADMIN_TOKEN"
unset ADMIN_TOKEN

scripts/deploy/rebuild-engine.sh "$BUILD_ID" \
  2>&1 | tee "$AUDIT_DIR/engine-rebuild.log"
unset ADMIN_COOKIE
```

The cutover's serial RANS, two-rank MPI RANS, and forced-URANS canary must prove
all of the following before the 2606 pool remains enabled:

- the canonical artifact is `engine_evidence.tar.zst` with
  `application/zstd` and the expected bucket/content-addressed key;
- generation, CRC32C, compressed/tar checksums and sizes match;
- the generation-pinned remote restore reports `archive+vtk-restore` or
  `archive+manifest-restore`;
- full local stripping removes the live solver/VTK bytes with no unknown
  entries; and
- `/field-extents`, `/render-field`, and `/render-default-media` hydrate GCS
  evidence and return checksum-validated PNGs after that strip.

If the script exits before exact continuation proof, leave its durable cutover
marker and receipt untouched. Recovery state lives outside the rsync-managed
application tree in `/opt/airfoils-pro/state`; when
`OPENCFD2606_CANARY_RECEIPT_EXPECTED=1`, a missing pending receipt is a hard
stop rather than permission to rerun or substitute canaries. Follow the
script's message and resume only with the same build/receipt, using
`--certify-opencfd-2606-continuation` when instructed.

For an already-2606 installation where the guarded cutover did not itself run
the canary, run the same verifier while the engine queue is intentionally idle:

```bash
python3 scripts/deploy/openfoam_2606_canary.py \
  --gateway-url http://127.0.0.1:8000 \
  --expected-build-id "$BUILD_ID" \
  --expected-evidence-bucket "$BUCKET" \
  >"$AUDIT_DIR/openfoam-2606-canary.json"
chmod 0600 "$AUDIT_DIR/openfoam-2606-canary.json"
```

Do not migrate legacy evidence unless this remote-only render proof succeeds.

### High-storage first-cutover bridge

The ordinary cutover restores a previously running sweeper and waits for a
real result from the linked 2606 successor campaign. That proof requires a new
solver submission; the production storage safeguard correctly refuses every
new submission while the results volume is at or above 80% use. The standalone
2606 canary cannot substitute for successor evidence because it is not owned
by the campaign database.

If the drain leaves storage admission closed, do not lower the threshold and
do not let the ordinary one-hour continuation wait expire. Use the rebuild
script's tested, intentionally-stopped scheduler path:

1. Wait until every 2406 engine process is gone and every legacy database job
   has left `submitted`, `running`, and `ingesting`.
2. Stop the sweeper *before* invoking the guarded rebuild. The script records
   that prior intent, performs the complete 2606 build, remote-render canary,
   attestation, and successor-generation transaction, then leaves the sweeper
   stopped with the exact continuation marker pending instead of claiming
   success without evidence.
3. Start the new sweeper. While storage remains at or above 80%, it continues
   reconciliation and evidence cleanup but cannot admit CFD work. Run the
   one-job three-pass trial below, then migrate one complete job at a time
   through all three passes. Remeasure after every pass 3. Do not accumulate a
   25-job upload phase while capacity is tight: pass 1 retains the old archive
   and raw trees until database registration plus the fresh pass-3 restore.
4. Continue until the measured used percentage is comfortably below 80% and
   the full admission headroom check is open. The running sweeper may then
   submit the real 2606 successor job; incremental checksummed result evidence
   is sufficient for continuation proof, so the whole batch need not finish.
5. Stop the sweeper, replay the exact attestation with
   `scripts/deploy/rebuild-engine.sh --certify-opencfd-2606-continuation`, and
   confirm the pending marker clears. Because the recorded pre-cutover
   scheduler state was intentionally stopped, explicitly start the sweeper
   after certification to continue the campaign.

Keep the same protected `ADMIN_COOKIE` procedure for both rebuild invocations.
Never clear or edit the pending marker, reuse the canary as campaign evidence,
or manually link a result to make certification pass.

## 7. One-terminal-job three-pass trial

Dry-run is the default for both migration commands. Select a terminal legacy
job whose plan names an actual gzip source. `sourceFormats` and `sourcePaths`
are ordered, parallel arrays, so this selection cannot accidentally choose a
job that contains only an already-Zstandard archive:

```bash
compose exec -T api python3 -m airfoilfoam.evidence_migration --limit 50 \
  2>&1 | tee "$AUDIT_DIR/trial-plan.jsonl"

export JOB_ID="$(python3 - "$AUDIT_DIR/trial-plan.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1], encoding="utf-8"):
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        # stderr is intentionally co-captured for the audit record.
        continue
    sources = zip(row.get("sourceFormats", []), row.get("sourcePaths", []))
    if row.get("status") == "planned" and any(
        compression == "gzip" and path in {
            "engine_evidence.tar.gz", "openfoam_evidence.tar.gz"
        }
        for compression, path in sources
    ):
        print(row["jobId"])
        break
PY
)"
test -n "$JOB_ID"
printf '%s\n' "$JOB_ID" | tee "$AUDIT_DIR/trial-job-id.txt"
```

One job may contain several evidence directories; `--job-id` intentionally
processes every eligible evidence directory owned by that exact job.

### Pass 1: transcode, upload, restore-proof, receipt

```bash
compose exec -T api python3 -m airfoilfoam.evidence_migration \
  --execute --job-id "$JOB_ID" \
  2>&1 | tee "$AUDIT_DIR/trial-pass1-python.jsonl"
```

Every row must be `awaiting-database-registration` (or idempotently
`already-complete`). In the awaiting state the exact GCS pointer and migration
receipt are durable, but the generated local `tar.zst`, legacy gzip source, and
packaged `VTK`, `openfoam`, and `time_directories` trees are all deliberately
retained. This is the rollback/recovery copy until the exact database
registration and second fresh remote restore both succeed in pass 3. Pass 1
therefore reclaims no local packaged evidence bytes.

### Pass 2: register the exact generation in Postgres

Plan first, then execute the Node backfill:

```bash
compose exec -T sweeper pnpm --filter @aerodb/sweeper exec tsx \
  src/evidence-storage-backfill.ts --job-id "$JOB_ID" \
  2>&1 | tee "$AUDIT_DIR/trial-pass2-node-plan.jsonl"

compose exec -T sweeper pnpm --filter @aerodb/sweeper exec tsx \
  src/evidence-storage-backfill.ts --execute --job-id "$JOB_ID" \
  2>&1 | tee "$AUDIT_DIR/trial-pass2-node.jsonl"
```

Every executed row must be `registered`. The backfill writes
`storage_migration.database.json` atomically only after the current archive,
blob, source bundle, and all logical archive-member mappings agree.

### Pass 3: validate registration, re-restore, remove local packaged sources

```bash
compose exec -T api python3 -m airfoilfoam.evidence_migration \
  --execute --job-id "$JOB_ID" \
  2>&1 | tee "$AUDIT_DIR/trial-pass3-python.jsonl"
```

Every row must be `migrated` or `already-complete`, with no `failed` result.
The finalizer validates the acknowledgement identities, downloads the pinned
generation again, revalidates the tar plus exact manifest and VTK restore
(when VTK members exist), and only then
removes the local Zstandard archive, legacy gzip, and packaged raw evidence
directories. The manifest, immutable GCS pointer, migration receipt, database
acknowledgement, and stored render media remain.

### Trial download and UI proof

Stream every trial archive through the gateway, which must hydrate GCS rather
than find a local archive, and compare it with the receipt SHA-256:

```bash
compose exec -T api python3 - "$JOB_ID" <<'PY' >"$AUDIT_DIR/trial-archives.tsv"
import json, pathlib, sys
root = pathlib.Path("/data/airfoilfoam/jobs") / sys.argv[1]
for path in sorted(root.glob("cases/**/evidence/storage_migration.json")):
    row = json.loads(path.read_text(encoding="utf-8"))
    assert row["state"] == "complete"
    rel = path.parent.relative_to(root).as_posix()
    print(rel, row["archive"]["storedSha256"], sep="\t")
PY

while IFS=$'\t' read -r evidence_path expected_sha; do
  actual_sha="$(
    curl -fsS --max-time 900 \
      "http://127.0.0.1:8000/jobs/$JOB_ID/files/$evidence_path/engine_evidence.tar.zst" \
      | sha256sum | cut -d' ' -f1
  )"
  test "$actual_sha" = "$expected_sha"
done <"$AUDIT_DIR/trial-archives.tsv"
```

Open the exact migrated result through Admin/Detail and exercise one stored
field or custom render. The deterministic API render gate is the stripped
2606 canary above; the trial confirms the legacy result's exact archive can be
downloaded through the same generation-pinned hydration layer. Stop if the
page loses a previously registered artifact, or if a render/download returns
404, 422, 502, or 503.

## 8. Bulk three-pass migration

Keep the campaign running. The migrator only takes terminal, unlocked jobs and
does not touch pending/running jobs. Work in bounded batches first; increase the
batch size only after storage, GCS error rate, and solver throughput remain
healthy.

Do not page through the same sorted discovery set with `--limit`: completed
targets remain discoverable for idempotency, so a repeated limit would keep
selecting the same prefix. Instead, use explicit repeatable `--job-id` arguments
for each state-derived batch. Define this read-only selector once:

```bash
next_migration_jobs() {
  local phase="$1"
  compose exec -T -e MIGRATION_PHASE="$phase" api python3 - <<'PY'
import json, os
from airfoilfoam.evidence_migration import discover_targets

phase = os.environ["MIGRATION_PHASE"]
root = "/data/airfoilfoam/jobs"
selected = []
if phase not in {"upload", "register", "finalize"}:
    raise SystemExit(f"unknown migration phase: {phase}")
seen = set()
for target in discover_targets(root):
    evidence = target.evidence_dir
    try:
        receipt = json.loads(
            (evidence / "storage_migration.json").read_text(encoding="utf-8")
        )
    except FileNotFoundError:
        receipt = None
    receipt_state = receipt.get("state") if isinstance(receipt, dict) else None
    ack = (evidence / "storage_migration.database.json").is_file()
    source_or_pointer = any((evidence / name).is_file() for name in (
        "engine_evidence.tar.zst",
        "engine_evidence.tar.gz",
        "openfoam_evidence.tar.gz",
        "engine_evidence.remote.json",
    ))
    wanted = (
        phase == "upload"
        and source_or_pointer
        and receipt_state not in {"awaiting_database_registration", "complete"}
    ) or (
        phase == "register"
        and receipt_state == "awaiting_database_registration"
        and not ack
    ) or (
        phase == "finalize"
        and receipt_state == "awaiting_database_registration"
        and ack
    )
    if wanted and target.job_id not in seen:
        seen.add(target.job_id)
        selected.append(target.job_id)
        if len(selected) == 25:
            break
if selected:
    print("\n".join(selected))
PY
}

load_migration_jobs() {
  local phase="$1" output
  MIGRATION_JOBS=()
  if ! output="$(next_migration_jobs "$phase")"; then
    echo "migration selector failed for phase: $phase" >&2
    return 1
  fi
  if [[ -n "$output" ]]; then
    mapfile -t MIGRATION_JOBS <<<"$output"
  fi
}
```

`load_migration_jobs` deliberately captures and checks the selector's exit
status before populating the array. Do not replace it with
`mapfile < <(next_migration_jobs ...)`: Bash reports `mapfile`'s status, not a
failed process substitution, so a broken selector can otherwise look like an
honestly empty batch.

### Bulk pass 1: Python upload and restore proof

```bash
if ! load_migration_jobs upload; then exit 1; fi
PASS1_JOBS=("${MIGRATION_JOBS[@]}")
PASS1_ARGS=()
for id in "${PASS1_JOBS[@]}"; do PASS1_ARGS+=(--job-id "$id"); done
if ((${#PASS1_ARGS[@]} == 0)); then
  echo 'no upload batch remains'
else
  compose exec -T api python3 -m airfoilfoam.evidence_migration \
    --execute --continue-on-error "${PASS1_ARGS[@]}" \
    2>&1 | tee -a "$AUDIT_DIR/bulk-pass1-python.jsonl"
fi
```

Repeat until the intended legacy set has receipts in
`awaiting_database_registration` or is already complete. Investigate every
`failed` row before proceeding; `--continue-on-error` records independent
failures but does not make them acceptable.

### Bulk pass 2: Node database registration

```bash
if ! load_migration_jobs register; then exit 1; fi
PASS2_JOBS=("${MIGRATION_JOBS[@]}")
PASS2_ARGS=()
for id in "${PASS2_JOBS[@]}"; do PASS2_ARGS+=(--job-id "$id"); done
if ((${#PASS2_ARGS[@]} == 0)); then
  echo 'no database-registration batch remains'
else
  compose exec -T sweeper pnpm --filter @aerodb/sweeper exec tsx \
    src/evidence-storage-backfill.ts --execute --continue-on-error \
    "${PASS2_ARGS[@]}" \
    2>&1 | tee -a "$AUDIT_DIR/bulk-pass2-node.jsonl"
fi
```

Repeat until every awaiting receipt has an exact database acknowledgement.

### Bulk pass 3: Python finalization

```bash
if ! load_migration_jobs finalize; then exit 1; fi
PASS3_JOBS=("${MIGRATION_JOBS[@]}")
PASS3_ARGS=()
for id in "${PASS3_JOBS[@]}"; do PASS3_ARGS+=(--job-id "$id"); done
if ((${#PASS3_ARGS[@]} == 0)); then
  echo 'no finalization batch remains'
else
  compose exec -T api python3 -m airfoilfoam.evidence_migration \
    --execute --continue-on-error "${PASS3_ARGS[@]}" \
    2>&1 | tee -a "$AUDIT_DIR/bulk-pass3-python.jsonl"
fi
```

Run only a command whose selected array is nonempty. Inspect each batch for
failures, then repeat upload, register, and finalize until all three selectors
return empty. End only when reconciliation shows every migration receipt
complete, no awaiting database registration, and no legacy source bytes under
those completed evidence directories.

## 9. Reconciliation and monitoring

### Filesystem and receipt state

This read-only inventory distinguishes canonical receipts from disposable
local cache and reports any local legacy bytes still owned by migrated evidence:

```bash
compose exec -T api python3 - <<'PY' | tee "$AUDIT_DIR/local-reconciliation.json"
import json
from collections import Counter
from pathlib import Path

root = Path("/data/airfoilfoam/jobs")
states = Counter()
legacy_gzip = 0
local_zstd = 0
packaged_raw = 0
pointers = 0
unprotected_raw_dirs = 0
unprotected_raw_bytes = 0

def size(path):
    if path.is_file() and not path.is_symlink():
        return path.stat().st_size
    if path.is_dir() and not path.is_symlink():
        return sum(p.stat().st_size for p in path.rglob("*") if p.is_file() and not p.is_symlink())
    return 0

for receipt in root.glob("*/cases/**/evidence/storage_migration.json"):
    row = json.loads(receipt.read_text(encoding="utf-8"))
    states[str(row.get("state"))] += 1
    evidence = receipt.parent
    pointers += int((evidence / "engine_evidence.remote.json").is_file())
    legacy_gzip += sum(size(evidence / name) for name in (
        "engine_evidence.tar.gz", "openfoam_evidence.tar.gz"
    ))
    local_zstd += size(evidence / "engine_evidence.tar.zst")
    packaged_raw += sum(size(evidence / name) for name in (
        "openfoam", "time_directories", "VTK"
    ))

terminal = {"completed", "failed", "cancelled"}
for job in sorted(path for path in root.iterdir() if path.is_dir()):
    try:
        status = json.loads((job / "status.json").read_text(encoding="utf-8"))
    except Exception:
        continue
    if status.get("state") not in terminal:
        continue
    for evidence in job.glob("cases/**/evidence"):
        raw = sum(size(evidence / name) for name in ("openfoam", "time_directories", "VTK"))
        protected = any((evidence / name).is_file() for name in (
            "engine_evidence.tar.zst", "engine_evidence.tar.gz",
            "openfoam_evidence.tar.gz", "engine_evidence.remote.json",
        ))
        if raw and not protected:
            unprotected_raw_dirs += 1
            unprotected_raw_bytes += raw

cache = Path("/data/airfoilfoam/evidence-hydration-cache")
print(json.dumps({
    "receiptStates": dict(states),
    "pointers": pointers,
    "legacyGzipBytes": legacy_gzip,
    "localZstdBytes": local_zstd,
    "packagedRawBytes": packaged_raw,
    "terminalUnprotectedRawDirs": unprotected_raw_dirs,
    "terminalUnprotectedRawBytes": unprotected_raw_bytes,
    "hydrationCacheBytes": size(cache),
}, indent=2, sort_keys=True))
PY
```

Once every migration receipt is complete, `legacyGzipBytes`, `localZstdBytes`,
and `packagedRawBytes` must be zero. The cache is expected to fluctuate and is
not canonical evidence. `terminalUnprotectedRawDirs` must also be zero; a
terminal raw tree with no local archive or verified pointer is evidence that
cannot be migrated or safely deleted and requires investigation.

### Database truth

```bash
compose exec -T postgres psql -U aerodb -d aerodb -v ON_ERROR_STOP=1 -P pager=off -c \
  "SELECT b.backend, b.compression,
          count(*) AS blobs,
          pg_size_pretty(sum(b.byte_size)::bigint) AS stored
     FROM solver_evidence_blobs b
    GROUP BY b.backend, b.compression
    ORDER BY b.backend, b.compression;" \
  | tee "$AUDIT_DIR/database-evidence-storage.txt"

compose exec -T postgres psql -U aerodb -d aerodb -v ON_ERROR_STOP=1 -P pager=off -c \
  "SELECT a.state, count(*) AS archives
     FROM solver_evidence_archives a
    GROUP BY a.state ORDER BY a.state;" \
  | tee -a "$AUDIT_DIR/database-evidence-storage.txt"

compose exec -T postgres psql -U aerodb -d aerodb -v ON_ERROR_STOP=1 -P pager=off -c \
  "SELECT count(*) AS current_gcs_objects,
          pg_size_pretty(coalesce(sum(byte_size), 0)::bigint) AS stored
     FROM (
       SELECT DISTINCT b.bucket, b.object_key, b.generation, b.byte_size
     FROM solver_evidence_archives a
         JOIN solver_evidence_blobs b ON b.id = a.blob_id
        WHERE a.state = 'current' AND b.backend = 'gcs'
     ) objects;" \
  | tee -a "$AUDIT_DIR/database-evidence-storage.txt"
```

Every final migration receipt has already validated one exact current GCS
archive and all of its registered members. Any receipt left in
`awaiting_database_registration` is incomplete work, not reclaimed storage.

### GCS, disk, cache, and logs

Run GCS inventory with an operator identity that can list objects:

```bash
gcloud storage du --summarize "gs://$BUCKET/$OBJECT_PREFIX" \
  | tee "$AUDIT_DIR/gcs-bytes.txt"
gcloud storage ls --recursive "gs://$BUCKET/$OBJECT_PREFIX" \
  | tee "$AUDIT_DIR/gcs-objects.txt" | wc -l \
  | tee "$AUDIT_DIR/gcs-object-count.txt"

df -B1 "$APP_DIR" | tee "$AUDIT_DIR/disk-after.txt"
compose exec -T api du -sb /data/airfoilfoam/evidence-hydration-cache \
  | tee "$AUDIT_DIR/hydration-cache.txt"
compose logs --no-color --since=30m api worker sweeper \
  | grep -Ei 'evidence|gcs|zstd|hydration|upload|restore|error' \
  | tee "$AUDIT_DIR/evidence-logs.txt" || true
```

Monitor campaign solved/evidence counts and real solver phase progress at the
same time. The migration must not make completed-case evidence stop advancing,
raise blocked points, or starve the active worker through sustained disk I/O.

The hydration cache is bounded by both 50 GB and a 24-hour idle TTL. Archive,
member, and render leases prevent automatic eviction while a request uses an
entry. Do not manually `rm -rf` the cache under a running gateway; let automatic
cleanup evict it, lower the configured cap in a later guarded deploy, or stop
the gateway during approved maintenance before clearing disposable cache.

## 10. Continuations and active jobs

- Never pass a pending/running job to a destructive ad-hoc command. The
  migrator requires terminal status and a free `.execute.lock`.
- Never call `POST /jobs/{id}/strip` with `keep_case_state=false` on a
  budget-stopped job that may continue.
- Case-state-preserving retention keeps the shared mesh, `constant`, `system`,
  and saved numeric OpenFOAM time directories needed by `continue_from`.
- Derived live-case VTK is not continuation state: continuation staging skips
  it and can regenerate it from saved OpenFOAM fields. Once its immutable VTK
  is restore-proven in GCS, retention may remove that duplicate even when
  solver state is preserved.
- Pending/running jobs and their live continuation state are outside this
  legacy migration. Their live-case and evidence VTK remain untouched by the
  migration; do not count those local bytes as a migration failure.

## 11. Stop conditions and rollback

Stop immediately, without deleting or retrying around the guard, if any of
these occurs:

- Postgres backup or strong scratch restore is not verified;
- ADC resolves to the wrong service account, or GCS create/get is denied;
- bucket policy, soft delete, or the deployment evidence env fails validation;
- `rebuild-engine.sh` reports queue/process activity or an inconsistent cutover
  marker;
- the canary fails provenance, GCS, strip, download, or remote rendering;
- a migration row is `failed`, a receipt/pointer/acknowledgement differs, or a
  database archive/member set is not exact;
- a migrated API artifact cannot download/render, a checksum differs, or GCS
  answers with an unexpected generation; or
- disk reserve, solver liveness, evidence publication, or campaign progress
  materially worsens during a batch.

Rollback is conservative:

1. Stop launching migration commands. Keep
   `AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true`; the approved production design does
   not retain a second unbounded packaged copy on the VPS, and the guarded
   engine deploy correctly rejects a local-retention downgrade. If GCS cannot
   accept and generation-verify new evidence, pause new solver admission while
   leaving reconciliation and existing remote reads available; do not restart
   the engine ad hoc.
2. Before pass 3, keep every legacy gzip bundle. Leave verified GCS objects,
   pointers, receipts, additive migration-0067 rows, and acknowledgements in
   place; they are safe and idempotent.
3. After pass 3, do not roll back to application code that cannot hydrate GCS
   evidence. Roll forward with the GCS-capable version, or restore the strongly
   verified Postgres backup only as part of a separately approved transactional
   recovery that also preserves object/pointer identities.
4. Never delete or overwrite a content-addressed object to “retry.” If an
   operator accidentally deletes one, restore its **exact recorded generation**
   during the 30-day soft-delete window:

   ```bash
   gcloud storage restore "gs://$BUCKET/<recorded-object-key>#<recorded-generation>"
   ```

   Then re-run the generation-pinned download/checksum/render verification.
5. A GCS outage does not authorize fabricated media or a local substitute.
   Keep the pointer and database rows immutable, report evidence unavailable,
   and retry after service recovery.

Migration is complete only when all intended terminal legacy evidence has a
complete receipt and current GCS archive, no migrated local gzip/Zstandard/raw
duplicate remains, API downloads and remote renders succeed, object/database
counts reconcile, reclaimed bytes are measured, and the active campaign
continues producing evidence without new storage-related blocking.
