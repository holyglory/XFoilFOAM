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
- an initial generation-pinned archive download plus exact manifest and
  all-member restore proves the upload; newly finalized results may then
  remove their unpacked raw evidence, but retain the complete local
  `tar.zst` until Postgres acknowledges every exact association;
- the legacy migrator is stricter during pass 1: its generated `tar.zst`,
  legacy gzip bundle, and packaged raw directories all remain local until
  Postgres has registered that exact GCS generation against the exact result
  attempt; failed or unpublished generations are discarded and rerun; and
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

For current production backups, run
`/opt/airfoils-pro/state/tools/production-db-backup-to-gcs.sh`. It uses private
VPS space only as temporary `pg_dump` and test-restore staging, uploads the
verified dump and manifest to `database-backups/production/` in the existing
private GCS bucket, retains the two newest complete backup sets, and removes the
local staging files only after the GCS uploads have been verified. Do not retain
finished database dumps on the VPS or use the solver-evidence object prefix for
database backups.

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
- every artifact carries the producer's exact
  `remote-copy-plus-local-archive-pending-database-ack` disposition and an
  `archive+manifest+all-members-restore:<count>` proof whose count equals the
  archive's bundled-file count; a canary must not claim per-artifact
  `remote-only` before database acknowledgement;
- full local stripping removes the live solver/VTK bytes with no unknown
  entries while deliberately retaining the complete local archive pending
  database acknowledgement;
- the Node attestation independently repeats that full strip and requires the
  idempotent marker response (`no_op=true`, `kept_case_state=false`, and zero
  unknown entries) before accepting the producer-shaped receipt; and
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

## 8. Bulk three-pass migration

Keep the campaign running. The migrator only takes terminal, unlocked jobs and
does not touch pending/running jobs. Work in bounded batches first; increase the
batch size only after storage, GCS error rate, and solver throughput remain
healthy.

Do not page through the same sorted discovery set with `--limit`: completed
targets remain discoverable for idempotency, so a repeated limit would keep
selecting the same prefix. Select exactly one legacy job and a deterministic
exact subset of its evidence targets, keep that job/subset pinned through
upload, database registration, and finalization, and only then select another
subset. Every executor receives one `--job-id` plus the same repeatable
`--evidence-path` arguments. Exact selection resolves the complete sorted,
deduplicated requested set before yielding a target; an unsafe path, missing
path, cross-job path, or partial match stops before mutation. `--limit` is
forbidden with exact selection.

A selectable job must still be homogeneous: every target returned by
`discover_targets(..., job_ids={job_id})` must be legacy-gzip-owned. A job that
mixes legacy evidence with native Zstandard/canary evidence is unsafe for this
runbook even when the selected subset contains only legacy targets. Exact
partitioning is solely a capacity boundary, never a way to hide mixed ownership
or corrupt siblings.

Write a complete read-only inventory before every cycle. The inventory is also
the fail-closed incident artifact: any active mixed job, invalid receipt,
missing/zero-byte legacy source, or individual evidence target above the 4 GiB
gzip-input cap stops all selection before mutation. A valid homogeneous job
whose aggregate upload input exceeds 4 GiB is `partition-required`, not corrupt:
the selector packs its lexically ordered, same-phase targets into a deterministic
subset whose aggregate gzip input is at most 4 GiB. Do not skip a blocking row
or repeatedly select it without resolving the recorded reason. Define the
inventory, selector, capacity planner, and verifier once:

```bash
write_migration_inventory() {
  compose exec -T api python3 - <<'PY'
import json, re, sys
from collections import defaultdict
from pathlib import Path
from airfoilfoam.evidence_migration import discover_targets
from airfoilfoam.evidence_store import read_remote_pointer

root = Path("/data/airfoilfoam/jobs")
phase_rank = {"finalize": 0, "register": 1, "upload": 2}
max_upload_bytes = 4 * 1024 * 1024 * 1024
gzip_names = ("engine_evidence.tar.gz", "openfoam_evidence.tar.gz")
jobs = defaultdict(list)

def read_json_object(path, errors, label):
    if not path.exists() and not path.is_symlink():
        return None
    if path.is_symlink() or not path.is_file():
        errors.append(f"{label} is not a regular file")
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"cannot parse {label}: {exc}")
        return None
    if not isinstance(value, dict):
        errors.append(f"{label} is not a JSON object")
        return None
    return value

def pack_same_phase(rows, phase):
    selected = []
    selected_upload_bytes = 0
    for row in rows:
        if phase != "upload":
            selected.append(row)
            continue
        target_bytes = row["localGzipBytes"]
        if target_bytes > max_upload_bytes:
            continue
        if selected_upload_bytes + target_bytes > max_upload_bytes:
            break
        selected.append(row)
        selected_upload_bytes += target_bytes
    return selected, selected_upload_bytes

# MUST-CATCH algorithm self-test: a clean aggregate-over-cap job partitions;
# aggregate size alone creates no blocker, and the exact lexical prefix stays
# within the hard cap.
partition_probe = [
    {"evidencePath": "cases/a/evidence", "localGzipBytes": 3 * 1024**3},
    {"evidencePath": "cases/b/evidence", "localGzipBytes": 2 * 1024**3},
]
probe_blockers = []
probe_selected, probe_bytes = pack_same_phase(partition_probe, "upload")
assert sum(row["localGzipBytes"] for row in partition_probe) > max_upload_bytes
assert probe_blockers == []
assert [row["evidencePath"] for row in probe_selected] == ["cases/a/evidence"]
assert 0 < probe_bytes <= max_upload_bytes

for target in discover_targets(root):
    evidence = target.evidence_dir
    errors = []
    receipt_path = evidence / "storage_migration.json"
    ack_path = evidence / "storage_migration.database.json"
    pointer_path = evidence / "engine_evidence.remote.json"
    receipt_present = receipt_path.exists() or receipt_path.is_symlink()
    ack_present = ack_path.exists() or ack_path.is_symlink()
    receipt = read_json_object(receipt_path, errors, "migration receipt")
    ack = read_json_object(ack_path, errors, "database acknowledgement")

    local_gzip = []
    local_gzip_sizes = {}
    for name in gzip_names:
        path = evidence / name
        if not path.exists() and not path.is_symlink():
            continue
        if path.is_symlink() or not path.is_file():
            errors.append(f"{name} is not a regular file")
        else:
            local_gzip.append(name)
            try:
                local_gzip_sizes[name] = path.stat().st_size
            except OSError as exc:
                errors.append(f"cannot stat {name}: {exc}")
                local_gzip_sizes[name] = 0
            if local_gzip_sizes[name] <= 0:
                errors.append(f"{name} is zero bytes")

    pointer = None
    if pointer_path.exists() or pointer_path.is_symlink():
        if pointer_path.is_symlink() or not pointer_path.is_file():
            errors.append("remote pointer is not a regular file")
        else:
            try:
                pointer = read_remote_pointer(pointer_path)
            except Exception as exc:
                errors.append(f"cannot parse canonical remote pointer: {exc}")

    source_archives = []
    if receipt is not None:
        source_archives = receipt.get("sourceArchives", [])
        if not isinstance(source_archives, list) or not all(
            isinstance(row, dict) for row in source_archives
        ):
            errors.append("receipt sourceArchives is not an object array")
            source_archives = []
        allowed_sources = {
            "engine_evidence.tar.zst": "zstd",
            "engine_evidence.tar.gz": "gzip",
            "openfoam_evidence.tar.gz": "gzip",
        }
        for source in source_archives:
            path = source.get("path")
            if path not in allowed_sources or (
                source.get("compression") != allowed_sources[path]
            ):
                errors.append(f"invalid source archive identity: {source!r}")
            if not re.fullmatch(r"[0-9a-f]{64}", str(source.get("sha256", ""))):
                errors.append(f"invalid source archive SHA-256: {source!r}")
            if not isinstance(source.get("byteSize"), int) or source["byteSize"] <= 0:
                errors.append(f"invalid source archive byte size: {source!r}")
    receipt_gzip = [
        row for row in source_archives
        if row.get("compression") == "gzip" and row.get("path") in gzip_names
    ]
    legacy_owned = bool(local_gzip or receipt_gzip)
    state = receipt.get("state") if receipt is not None else None
    if receipt is not None:
        for key, expected in {
            "schemaVersion": 1,
            "jobId": target.job_id,
            "evidencePath": target.relative_evidence_path,
        }.items():
            if receipt.get(key) != expected:
                errors.append(f"receipt {key} does not match exact target")
        if pointer is not None:
            if receipt.get("remote") != pointer.to_dict():
                errors.append("receipt remote identity does not match pointer")
            if receipt.get("archive") != {
                "storedSha256": pointer.stored_sha256,
                "storedByteSize": pointer.stored_size,
                "uncompressedTarSha256": pointer.tar_sha256,
                "uncompressedTarByteSize": pointer.tar_size,
                "zstdLevel": pointer.zstd_level,
            }:
                errors.append("receipt archive identity does not match pointer")
    if ack is not None:
        for key, expected in {
            "schemaVersion": 1,
            "jobId": target.job_id,
            "evidencePath": target.relative_evidence_path,
        }.items():
            if ack.get(key) != expected:
                errors.append(f"acknowledgement {key} does not match exact target")
        if ack.get("state") != "registered":
            errors.append(f"unsupported acknowledgement state: {ack.get('state')!r}")
        if pointer is not None:
            if ack.get("storedSha256") != pointer.stored_sha256:
                errors.append("acknowledgement stored SHA-256 does not match pointer")
            if ack.get("generation") != str(pointer.generation):
                errors.append("acknowledgement generation does not match pointer")
    required = None
    if receipt_present and receipt is None:
        errors.append("migration receipt exists but is invalid")
        if legacy_owned:
            required = "upload"
    elif receipt is None and legacy_owned:
        required = "upload"
        if ack_present:
            errors.append("database acknowledgement exists before a receipt")
    elif receipt is not None:
        if state == "awaiting_database_registration":
            required = "finalize" if ack_present else "register"
            if pointer_path.is_symlink() or not pointer_path.is_file():
                errors.append("awaiting receipt lacks a regular remote pointer")
        elif state == "complete":
            if pointer_path.is_symlink() or not pointer_path.is_file():
                errors.append("complete receipt lacks a regular remote pointer")
            if not ack_present or ack is None:
                errors.append("complete receipt lacks a valid database acknowledgement")
        else:
            errors.append(f"unsupported receipt state: {state!r}")
            if legacy_owned:
                required = "upload"
    if state in {"awaiting_database_registration", "complete"} and (
        legacy_owned and not receipt_gzip
    ):
        errors.append("legacy receipt does not retain gzip source provenance")
    if state == "awaiting_database_registration":
        for source in receipt_gzip:
            if source["path"] not in local_gzip:
                errors.append(
                    f"receipt-recorded gzip source is missing: {source['path']}"
                )
    if receipt is None and ack_present and not legacy_owned:
        errors.append("database acknowledgement exists without a valid receipt")

    jobs[target.job_id].append({
        "evidencePath": target.relative_evidence_path,
        "legacyOwned": legacy_owned,
        "localGzip": sorted(local_gzip),
        "localGzipBytes": sum(local_gzip_sizes.values()),
        "receiptState": state,
        "requiredPhase": required,
        "errors": errors,
    })

rows = []
blocking_jobs = []
for job_id in sorted(jobs):
    targets = sorted(jobs[job_id], key=lambda row: row["evidencePath"])
    legacy = [row for row in targets if row["legacyOwned"]]
    corrupt = any(row["errors"] for row in targets)
    if not legacy and not corrupt:
        continue
    required_rows = [row for row in legacy if row["requiredPhase"] is not None]
    active = bool(required_rows)
    required_phase = (
        min(
            (row["requiredPhase"] for row in required_rows),
            key=phase_rank.__getitem__,
        )
        if active else None
    )
    phase_rows = [
        row for row in required_rows if row["requiredPhase"] == required_phase
    ]
    phase_upload_bytes = sum(
        row["localGzipBytes"] for row in phase_rows
        if row["requiredPhase"] == "upload"
    )
    blockers = []
    if active and len(legacy) != len(targets):
        blockers.append("mixed_legacy_and_nonlegacy_targets")
    if active or corrupt:
        for row in targets:
            blockers.extend(
                f"{row['evidencePath']}: {message}" for message in row["errors"]
            )
    if active:
        for row in required_rows:
            if row["requiredPhase"] == "upload" and not row["localGzip"]:
                blockers.append(
                    f"{row['evidencePath']}: missing_or_zero_legacy_gzip_input"
                )
            if (
                row["requiredPhase"] == "upload"
                and row["localGzipBytes"] > max_upload_bytes
            ):
                blockers.append(
                    f"{row['evidencePath']}: exact_target_exceeds_4_GiB_gzip_input_cap"
                )
        if required_phase == "upload" and phase_upload_bytes == 0:
            blockers.append("selected_phase_has_zero_legacy_gzip_input")

    selected_rows, selected_upload_bytes = pack_same_phase(
        phase_rows,
        required_phase,
    )
    if active and not selected_rows:
        blockers.append("no_exact_targets_fit_the_selected_phase")
    partition_required = (
        required_phase == "upload"
        and phase_upload_bytes > max_upload_bytes
        and not blockers
    )
    row = {
        "kind": "job",
        "jobId": job_id,
        "active": active,
        "requiredPhase": required_phase,
        "uploadGzipBytes": selected_upload_bytes,
        "phaseUploadGzipBytes": phase_upload_bytes,
        "partitionRequired": partition_required,
        "selectedTargetPaths": [row["evidencePath"] for row in selected_rows],
        "allTargetPaths": [row["evidencePath"] for row in targets],
        "legacyTargetPaths": [row["evidencePath"] for row in legacy],
        "nonLegacyTargetPaths": [
            row["evidencePath"] for row in targets if not row["legacyOwned"]
        ],
        "targets": targets,
        "blockingReasons": sorted(set(blockers)),
    }
    rows.append(row)
    if blockers:
        blocking_jobs.append(job_id)

# MUST-CATCH partition invariant: aggregate over-capacity alone is never a
# corruption blocker. A valid oversized upload phase always exposes a nonempty
# deterministic subset whose exact input remains within the hard 4 GiB cap.
for inventory_row in rows:
    oversized_valid_upload = (
        inventory_row["active"]
        and inventory_row["requiredPhase"] == "upload"
        and inventory_row["phaseUploadGzipBytes"] > max_upload_bytes
        and not inventory_row["blockingReasons"]
    )
    if oversized_valid_upload:
        assert inventory_row["partitionRequired"], inventory_row
        assert inventory_row["selectedTargetPaths"], inventory_row
        assert 0 < inventory_row["uploadGzipBytes"] <= max_upload_bytes, inventory_row
    if inventory_row["partitionRequired"]:
        assert inventory_row["blockingReasons"] == [], inventory_row
        assert inventory_row["phaseUploadGzipBytes"] > max_upload_bytes, inventory_row
        assert 0 < inventory_row["uploadGzipBytes"] <= max_upload_bytes, inventory_row

payload = {
    "schemaVersion": 1,
    "jobs": rows,
    "blockingJobs": blocking_jobs,
}
print(json.dumps(payload, sort_keys=True))
if blocking_jobs:
    print(
        "bulk migration inventory contains blocking jobs: "
        + ", ".join(blocking_jobs),
        file=sys.stderr,
    )
    raise SystemExit(1)
PY
}

next_migration_jobs() {
  local phase="$1"
  python3 - "$MIGRATION_INVENTORY" "$phase" <<'PY'
import json, sys
path, phase = sys.argv[1:]
if phase not in {"upload", "register", "finalize"}:
    raise SystemExit(f"unknown migration phase: {phase}")
payload = json.load(open(path, encoding="utf-8"))
assert payload.get("schemaVersion") == 1, payload
assert payload.get("blockingJobs") == [], payload.get("blockingJobs")
candidates = []
for row in payload.get("jobs", []):
    if row.get("active") and row.get("requiredPhase") == phase:
        weight = row.get("uploadGzipBytes", 0) if phase == "upload" else 0
        assert isinstance(weight, int) and weight >= 0, row
        selected = row.get("selectedTargetPaths")
        assert isinstance(selected, list) and selected == sorted(set(selected)), row
        assert selected, row
        if phase == "upload":
            assert 0 < weight <= 4 * 1024**3, row
        candidates.append((weight, row["jobId"]))
if candidates:
    print(min(candidates)[1])
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

plan_migration_capacity() {
  local job_id="$1" phase="$2" expected_targets_json="$3"
  compose exec -T -e MIGRATION_JOB_ID="$job_id" \
    -e MIGRATION_EXPECTED_PHASE="$phase" \
    -e MIGRATION_EXPECTED_TARGETS_JSON="$expected_targets_json" \
    api python3 - <<'PY'
import ctypes
import ctypes.util
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

from airfoilfoam.config import get_settings
from airfoilfoam.evidence_migration import discover_targets
from airfoilfoam.evidence_store import inspect_tar_zst, read_remote_pointer

jobs_root = Path("/data/airfoilfoam/jobs")
job_id = os.environ["MIGRATION_JOB_ID"]
expected_phase = os.environ["MIGRATION_EXPECTED_PHASE"]
expected_paths = json.loads(os.environ["MIGRATION_EXPECTED_TARGETS_JSON"])
gzip_names = ("engine_evidence.tar.gz", "openfoam_evidence.tar.gz")
max_gzip_input = 4 * 1024**3
minimum_reserve = 80 * 1024**3
phase_rank = {"finalize": 0, "register": 1, "upload": 2}
settings = get_settings()
cache_root = settings.resolved_evidence_hydration_cache_dir()
assert settings.data_dir / "jobs" == jobs_root, settings.data_dir
assert Path(tempfile.gettempdir()) == Path("/tmp"), tempfile.gettempdir()

def strict_json(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict), path
    return value

def source_archives(receipt):
    if receipt is None:
        return []
    rows = receipt.get("sourceArchives", [])
    assert isinstance(rows, list) and rows
    allowed = {
        "engine_evidence.tar.zst": "zstd",
        "engine_evidence.tar.gz": "gzip",
        "openfoam_evidence.tar.gz": "gzip",
    }
    for row in rows:
        assert isinstance(row, dict)
        path = row.get("path")
        assert path in allowed and row.get("compression") == allowed[path], row
        assert re.fullmatch(r"[0-9a-f]{64}", str(row.get("sha256", ""))), row
        assert isinstance(row.get("byteSize"), int) and row["byteSize"] > 0
    return rows

def legacy_owned(evidence, receipt):
    local = any(
        (evidence / name).is_file() and not (evidence / name).is_symlink()
        for name in gzip_names
    )
    recorded = any(
        row.get("compression") == "gzip" for row in source_archives(receipt)
    )
    return local or recorded

def gzip_tar_identity(path):
    digest = hashlib.sha256()
    size = 0
    with gzip.open(path, "rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    assert size > 0, f"empty tar stream in {path}"
    return size, digest.hexdigest()

def load_compress_bound():
    candidates = [ctypes.util.find_library("zstd"), "libzstd.so.1", "libzstd.so"]
    errors = []
    for candidate in candidates:
        if not candidate:
            continue
        try:
            library = ctypes.CDLL(candidate)
            function = library.ZSTD_compressBound
            function.argtypes = [ctypes.c_size_t]
            function.restype = ctypes.c_size_t
            return function, candidate
        except Exception as exc:
            errors.append(f"{candidate}: {exc}")
    raise RuntimeError("cannot load libzstd ZSTD_compressBound: " + "; ".join(errors))

def nearest_existing(path):
    candidate = Path(path)
    while not candidate.exists():
        parent = candidate.parent
        if parent == candidate:
            raise RuntimeError(f"no existing parent for {path}")
        candidate = parent
    assert not candidate.is_symlink(), f"capacity path traverses a symlink: {candidate}"
    return candidate

def measurement(label, configured_path):
    anchor = nearest_existing(configured_path)
    usage = shutil.disk_usage(anchor)
    return {
        "label": label,
        "configuredPath": str(configured_path),
        "measuredAt": str(anchor),
        "device": str(anchor.stat().st_dev),
        "freeBytes": usage.free,
        "totalBytes": usage.total,
    }

report = {
    "schemaVersion": 1,
    "jobId": job_id,
    "expectedStartPhase": expected_phase,
    "expectedTargetPaths": expected_paths,
    "gzipInputBytes": 0,
    "targets": [],
    "filesystems": [],
    "blockingReasons": [],
}
try:
    assert expected_phase in {*phase_rank, "finalize_or_complete"}, expected_phase
    assert isinstance(expected_paths, list) and expected_paths
    assert expected_paths == sorted(set(expected_paths)), expected_paths
    all_job_targets = list(discover_targets(jobs_root, job_ids={job_id}))
    assert all_job_targets, "exact job no longer has discoverable evidence targets"
    for job_target in all_job_targets:
        receipt_path = job_target.evidence_dir / "storage_migration.json"
        assert not receipt_path.is_symlink(), receipt_path
        receipt = strict_json(receipt_path) if receipt_path.is_file() else None
        assert legacy_owned(job_target.evidence_dir, receipt), (
            "exact job gained a nonlegacy/mixed target: "
            + job_target.relative_evidence_path
        )
    targets = list(discover_targets(
        jobs_root,
        job_ids={job_id},
        evidence_paths=set(expected_paths),
    ))
    actual_paths = sorted(target.relative_evidence_path for target in targets)
    assert actual_paths == expected_paths, {
        "expected": expected_paths,
        "actual": actual_paths,
    }

    measurements = {
        "jobs": measurement("jobs", jobs_root),
        "cache": measurement("hydration-cache", cache_root),
        "tmp": measurement("fresh-restore-temp", Path("/tmp")),
    }
    jobs_device = measurements["jobs"]["device"]
    assert all(
        str(target.evidence_dir.stat().st_dev) == jobs_device for target in targets
    ), "a target uses a nested filesystem not represented by the jobs measurement"
    requirements = {"jobs": 0, "cache": 0, "tmp": 0}
    required_phases = []
    compress_bound, compress_bound_library = load_compress_bound()

    for target in targets:
        evidence = target.evidence_dir
        receipt_path = evidence / "storage_migration.json"
        assert not receipt_path.is_symlink(), receipt_path
        receipt = strict_json(receipt_path) if receipt_path.is_file() else None
        assert legacy_owned(evidence, receipt), (
            f"nonlegacy target entered exact job scope: {target.relative_evidence_path}"
        )
        state = receipt.get("state") if receipt is not None else None
        ack_present = (evidence / "storage_migration.database.json").is_file()
        if receipt is None:
            required = "upload"
        elif state == "awaiting_database_registration":
            required = "finalize" if ack_present else "register"
        elif state == "complete":
            required = None
        else:
            raise AssertionError(f"unsupported receipt state {state!r}")
        pointer = None
        if state in {"awaiting_database_registration", "complete"}:
            pointer_path = evidence / "engine_evidence.remote.json"
            assert pointer_path.is_file() and not pointer_path.is_symlink(), pointer_path
            pointer = read_remote_pointer(pointer_path)
            assert receipt is not None and receipt.get("remote") == pointer.to_dict()
            assert receipt.get("archive") == {
                "storedSha256": pointer.stored_sha256,
                "storedByteSize": pointer.stored_size,
                "uncompressedTarSha256": pointer.tar_sha256,
                "uncompressedTarByteSize": pointer.tar_size,
                "zstdLevel": pointer.zstd_level,
            }
        if required is not None:
            required_phases.append(required)

        target_row = {
            "evidencePath": target.relative_evidence_path,
            "requiredPhase": required,
            "gzipInputBytes": 0,
            "uncompressedTarBytes": None,
            "zstdCompressBoundBytes": None,
            "canonicalAdditionalBytes": 0,
            "cacheAdditionalBytes": 0,
            "freshRestoreAdditionalBytes": 0,
        }
        if required == "upload":
            gzip_paths = []
            for name in gzip_names:
                path = evidence / name
                if path.exists() or path.is_symlink():
                    assert path.is_file() and not path.is_symlink(), path
                    gzip_paths.append(path)
            assert gzip_paths, "upload target has no regular legacy gzip source"
            identities = [gzip_tar_identity(path) for path in gzip_paths]
            assert len(set(identities)) == 1, (
                f"legacy gzip tar identities disagree at {target.relative_evidence_path}"
            )
            tar_size, tar_sha256 = identities[0]
            bound = int(compress_bound(tar_size))
            assert bound >= tar_size and bound > 0, (tar_size, bound)
            gzip_input = sum(path.stat().st_size for path in gzip_paths)
            report["gzipInputBytes"] += gzip_input
            target_row["gzipInputBytes"] = gzip_input
            target_row["uncompressedTarBytes"] = tar_size
            target_row["zstdCompressBoundBytes"] = bound

            canonical = evidence / "engine_evidence.tar.zst"
            if canonical.exists() or canonical.is_symlink():
                assert canonical.is_file() and not canonical.is_symlink(), canonical
                record = inspect_tar_zst(canonical, level=settings.evidence_zstd_level)
                assert (record.tar_size, record.tar_sha256) == (tar_size, tar_sha256)
                archive_upper_bound = record.stored_size
            else:
                archive_upper_bound = bound
                requirements["jobs"] += bound
                target_row["canonicalAdditionalBytes"] = bound

            pointer_path = evidence / "engine_evidence.remote.json"
            if pointer_path.exists() or pointer_path.is_symlink():
                assert pointer_path.is_file() and not pointer_path.is_symlink()
                pointer = read_remote_pointer(pointer_path)
                assert (pointer.tar_size, pointer.tar_sha256) == (tar_size, tar_sha256)
                if canonical.exists():
                    assert (
                        record.stored_sha256,
                        record.stored_size,
                        record.tar_sha256,
                        record.tar_size,
                    ) == (
                        pointer.stored_sha256,
                        pointer.stored_size,
                        pointer.tar_sha256,
                        pointer.tar_size,
                    )
                archive_upper_bound = max(archive_upper_bound, pointer.stored_size)
            requirements["cache"] += archive_upper_bound
            requirements["tmp"] += archive_upper_bound
            target_row["cacheAdditionalBytes"] = archive_upper_bound
            target_row["freshRestoreAdditionalBytes"] = archive_upper_bound
        elif required in {"register", "finalize"}:
            assert receipt is not None and pointer is not None
            requirements["tmp"] += pointer.stored_size
            target_row["freshRestoreAdditionalBytes"] = pointer.stored_size
        report["targets"].append(target_row)

    actual_phase = (
        min(required_phases, key=phase_rank.__getitem__) if required_phases else None
    )
    if expected_phase == "finalize_or_complete":
        assert actual_phase in {"finalize", None}, {
            "expectedStartPhase": expected_phase,
            "actualStartPhase": actual_phase,
        }
    else:
        assert actual_phase == expected_phase, {
            "expectedStartPhase": expected_phase,
            "actualStartPhase": actual_phase,
        }
    report["compressBoundLibrary"] = compress_bound_library
    if report["gzipInputBytes"] > max_gzip_input:
        report["blockingReasons"].append("exact_job_exceeds_4_GiB_gzip_input_cap")

    devices = {}
    for role, item in measurements.items():
        device = item["device"]
        current = devices.setdefault(device, {
            "device": device,
            "freeBytes": item["freeBytes"],
            "paths": [],
            "requiredAdditionalBytes": 0,
        })
        current["freeBytes"] = min(current["freeBytes"], item["freeBytes"])
        current["paths"].append(item)
        current["requiredAdditionalBytes"] += requirements[role]
    for device in sorted(devices):
        item = devices[device]
        item["projectedFreeBytes"] = (
            item["freeBytes"] - item["requiredAdditionalBytes"]
        )
        item["minimumReserveBytes"] = minimum_reserve
        if item["projectedFreeBytes"] < minimum_reserve:
            report["blockingReasons"].append(
                f"device_{device}_would_fall_below_80_GiB_reserve"
            )
        report["filesystems"].append(item)
except Exception as exc:
    report["blockingReasons"].append(f"capacity_preflight_error: {exc}")

report["blockingReasons"] = sorted(set(report["blockingReasons"]))
print(json.dumps(report, sort_keys=True))
if report["blockingReasons"]:
    raise SystemExit(1)
PY
}

verify_migration_job() {
  local job_id="$1" phase="$2" expected_targets_json="$3"
  compose exec -T -e MIGRATION_JOB_ID="$job_id" \
    -e MIGRATION_EXPECTED_PHASE="$phase" \
    -e MIGRATION_EXPECTED_TARGETS_JSON="$expected_targets_json" \
    api python3 - <<'PY'
import hashlib
import json
import os
import re
from pathlib import Path

from airfoilfoam.config import get_settings
from airfoilfoam.evidence_migration import discover_targets
from airfoilfoam.evidence_runtime import evidence_object_store
from airfoilfoam.evidence_store import (
    manifest_bundle_member_set_sha256,
    read_remote_pointer,
)

root = Path("/data/airfoilfoam/jobs")
job_id = os.environ["MIGRATION_JOB_ID"]
phase = os.environ["MIGRATION_EXPECTED_PHASE"]
expected_paths = json.loads(os.environ["MIGRATION_EXPECTED_TARGETS_JSON"])
assert phase in {"uploaded", "registered", "finalized"}, phase
assert isinstance(expected_paths, list) and expected_paths
assert expected_paths == sorted(set(expected_paths)), expected_paths

def strict_json(path):
    assert path.is_file() and not path.is_symlink(), path
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict), path
    return value

def validate_sources(receipt):
    sources = receipt.get("sourceArchives", [])
    assert isinstance(sources, list) and sources
    allowed = {
        "engine_evidence.tar.zst": "zstd",
        "engine_evidence.tar.gz": "gzip",
        "openfoam_evidence.tar.gz": "gzip",
    }
    for source in sources:
        assert isinstance(source, dict)
        path = source.get("path")
        assert path in allowed and source.get("compression") == allowed[path], source
        assert re.fullmatch(r"[0-9a-f]{64}", str(source.get("sha256", ""))), source
        assert isinstance(source.get("byteSize"), int) and source["byteSize"] > 0
    return sources

def legacy_owned(evidence, receipt):
    sources = validate_sources(receipt)
    return any(row.get("compression") == "gzip" for row in sources)

def job_target_legacy_owned(target):
    evidence = target.evidence_dir
    receipt_path = evidence / "storage_migration.json"
    assert not receipt_path.is_symlink(), receipt_path
    local_gzip = False
    for name in ("engine_evidence.tar.gz", "openfoam_evidence.tar.gz"):
        path = evidence / name
        if path.exists() or path.is_symlink():
            assert path.is_file() and not path.is_symlink(), path
            assert path.stat().st_size > 0, path
            local_gzip = True
    if not receipt_path.is_file():
        return local_gzip
    receipt = strict_json(receipt_path)
    return local_gzip or legacy_owned(evidence, receipt)

def nonempty_string(value):
    return isinstance(value, str) and value and value == value.strip()

def file_identity(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()

def validate_ack(ack, target, pointer, receipt, receipt_path):
    expected = {
        "schemaVersion": 1,
        "jobId": job_id,
        "evidencePath": target.relative_evidence_path,
        "storedSha256": pointer.stored_sha256,
        "generation": str(pointer.generation),
    }
    for key, value in expected.items():
        assert ack.get(key) == value, (target.relative_evidence_path, key)
    state = ack.get("state")
    if state == "registered":
        for key in (
            "resultId", "resultAttemptId", "sourceArtifactId", "archiveId",
            "registeredAt",
        ):
            assert nonempty_string(ack.get(key)), (target.relative_evidence_path, key)
    else:
        raise AssertionError((target.relative_evidence_path, state))
    if receipt.get("state") == "complete":
        assert receipt.get("databaseAcknowledgement") == ack

rows = []
all_job_targets = list(discover_targets(root, job_ids={job_id}))
assert all_job_targets, "exact job no longer has discoverable evidence targets"
for job_target in all_job_targets:
    assert job_target_legacy_owned(job_target), (
        "exact job gained a nonlegacy/mixed target: "
        + job_target.relative_evidence_path
    )
targets = list(discover_targets(
    root,
    job_ids={job_id},
    evidence_paths=set(expected_paths),
))
actual_paths = sorted(target.relative_evidence_path for target in targets)
assert actual_paths == expected_paths, {"expected": expected_paths, "actual": actual_paths}
store = evidence_object_store(get_settings())
assert store is not None, "remote evidence store is not configured"
for target in targets:
    evidence = target.evidence_dir
    receipt_path = evidence / "storage_migration.json"
    receipt = strict_json(receipt_path)
    assert legacy_owned(evidence, receipt), target.relative_evidence_path
    sources = validate_sources(receipt)
    state = receipt.get("state")
    pointer = read_remote_pointer(evidence / "engine_evidence.remote.json")
    store.verify_remote_pointer(pointer)
    assert receipt.get("schemaVersion") == 1
    assert receipt.get("jobId") == job_id
    assert receipt.get("evidencePath") == target.relative_evidence_path
    assert receipt.get("remote") == pointer.to_dict()
    assert receipt.get("archive") == {
        "storedSha256": pointer.stored_sha256,
        "storedByteSize": pointer.stored_size,
        "uncompressedTarSha256": pointer.tar_sha256,
        "uncompressedTarByteSize": pointer.tar_size,
        "zstdLevel": pointer.zstd_level,
    }
    assert state in {"awaiting_database_registration", "complete"}, (
        target.relative_evidence_path, state
    )
    ack_path = evidence / "storage_migration.database.json"
    ack = strict_json(ack_path) if ack_path.is_file() else None
    if phase in {"registered", "finalized"} or state == "complete":
        assert ack is not None, target.relative_evidence_path
    if ack is not None:
        validate_ack(ack, target, pointer, receipt, receipt_path)
    if state == "awaiting_database_registration":
        canonical = evidence / "engine_evidence.tar.zst"
        assert canonical.is_file() and not canonical.is_symlink(), canonical
        assert file_identity(canonical) == (
            pointer.stored_size,
            pointer.stored_sha256,
        )
        for source in sources:
            source_path = evidence / source["path"]
            assert source_path.is_file() and not source_path.is_symlink(), source_path
            assert file_identity(source_path) == (
                source["byteSize"],
                source["sha256"],
            )
    if phase == "finalized":
        assert state == "complete", target.relative_evidence_path
        for name in (
            "engine_evidence.tar.zst", "engine_evidence.tar.gz",
            "openfoam_evidence.tar.gz", "openfoam", "time_directories", "VTK",
        ):
            assert not (evidence / name).exists(), (
                target.relative_evidence_path, name
            )
    rows.append({
        "evidencePath": target.relative_evidence_path,
        "state": state,
        "ackState": ack.get("state") if isinstance(ack, dict) else None,
        "generation": str(pointer.generation),
        "storedSha256": pointer.stored_sha256,
    })
assert len(rows) == len(expected_paths)
print(json.dumps({
    "jobId": job_id,
    "phase": phase,
    "targetCount": len(rows),
    "targets": rows,
}, sort_keys=True))
PY
}
```

`load_migration_jobs` deliberately captures and checks the selector's exit
status before populating the array. Do not replace it with
`mapfile < <(next_migration_jobs ...)`: Bash reports `mapfile`'s status, not a
failed process substitution, so a broken selector can otherwise look like an
honestly empty batch. The inventory validates the complete job for homogeneous
legacy ownership, then persists the exact same-phase subset selected for this
cycle. The capacity planner and every phase verifier pass that subset back to
`discover_targets` and require every requested path to resolve exactly. They
also rescan the complete pinned job and stop if any sibling has become
nonlegacy or mixed since the inventory snapshot. The verifier uses the
canonical pointer parser, verifies the pinned remote generation, and compares
receipt, pointer, acknowledgement, job, evidence path, hashes, and generation
identity.

Capacity planning has one fail-closed runtime prerequisite: the deployed API
image must expose libzstd's `ZSTD_compressBound` symbol. The planner deliberately
has no compression-ratio estimate or hand-maintained formula fallback. If its
capacity artifact reports that the symbol cannot be loaded, stop the migration
and repair or rebuild the supported API image before retrying; do not substitute
an approximation.

### One exact three-pass cycle

Prioritize an already-started job (`finalize`, then `register`) before selecting
a fresh upload. Every selector returns at most one ID and the inventory carries
its deterministic same-phase target subset. Pin both for the whole cycle:

```bash
set -Eeuo pipefail
MIGRATION_INVENTORY="$AUDIT_DIR/bulk-selector-inventory.json"
if ! write_migration_inventory | tee "$MIGRATION_INVENTORY"; then
  echo "refusing bulk mutation; inspect $MIGRATION_INVENTORY" >&2
  exit 1
fi

MIGRATION_JOB=
MIGRATION_START_PHASE=
for phase in finalize register upload; do
  if ! load_migration_jobs "$phase"; then exit 1; fi
  if ((${#MIGRATION_JOBS[@]})); then
    MIGRATION_JOB="${MIGRATION_JOBS[0]}"
    MIGRATION_START_PHASE="$phase"
    break
  fi
done
if [[ -z "$MIGRATION_JOB" ]]; then
  echo 'no legacy migration job remains'
  return 0 2>/dev/null || exit 0
fi

MIGRATION_EXPECTED_TARGETS_JSON="$(
  python3 - "$MIGRATION_INVENTORY" "$MIGRATION_JOB" \
    "$MIGRATION_START_PHASE" <<'PY'
import json, sys
inventory_path, job_id, phase = sys.argv[1:]
payload = json.load(open(inventory_path, encoding="utf-8"))
matches = [row for row in payload["jobs"] if row["jobId"] == job_id]
assert len(matches) == 1, matches
row = matches[0]
assert row["active"] and not row["blockingReasons"], row
assert row["allTargetPaths"] == row["legacyTargetPaths"], row
assert row["requiredPhase"] == phase, row
selected = row["selectedTargetPaths"]
assert selected == sorted(set(selected)) and selected, row
if phase == "upload":
    assert 0 < row["uploadGzipBytes"] <= 4 * 1024**3, row
print(json.dumps(selected, separators=(",", ":")))
PY
)"
test -n "$MIGRATION_EXPECTED_TARGETS_JSON"

# Materialize the exact JSON selection into a Bash argument array without
# eval. The path validator mirrors the CLI's safe-relative-path contract, and
# an ordinary file preserves the producer's exit status (unlike a process
# substitution hidden behind mapfile).
MIGRATION_PATHS_FILE="$AUDIT_DIR/bulk-targets-$MIGRATION_JOB-$MIGRATION_START_PHASE.txt"
if ! python3 - "$MIGRATION_EXPECTED_TARGETS_JSON" >"$MIGRATION_PATHS_FILE" <<'PY'
import json, sys
paths = json.loads(sys.argv[1])
assert isinstance(paths, list) and paths == sorted(set(paths)) and paths
for path in paths:
    assert isinstance(path, str) and path and path == path.strip(), path
    assert not path.startswith("/") and "\\" not in path and "\0" not in path, path
    assert all(ord(character) >= 32 and ord(character) != 127 for character in path), path
    assert all(part not in {"", ".", ".."} for part in path.split("/")), path
    print(path)
PY
then
  echo "refusing bulk mutation; cannot materialize exact target paths" >&2
  exit 1
fi
MIGRATION_EVIDENCE_PATHS=()
mapfile -t MIGRATION_EVIDENCE_PATHS <"$MIGRATION_PATHS_FILE"
((${#MIGRATION_EVIDENCE_PATHS[@]}))
MIGRATION_TARGET_ARGS=(--job-id "$MIGRATION_JOB")
for evidence_path in "${MIGRATION_EVIDENCE_PATHS[@]}"; do
  MIGRATION_TARGET_ARGS+=(--evidence-path "$evidence_path")
done

# The planner streams every upload-needed gzip to obtain the exact tar byte
# count, asks libzstd for ZSTD_compressBound, and reserves simultaneous space
# for a missing canonical archive, the pass-1 hydration-cache download, and the
# pass-3 fresh-restore download. Paths that share st_dev share one aggregated
# requirement. Measurements are taken inside the api container at the jobs
# volume, configured hydration cache, and /tmp; every affected device must keep
# at least 80 GiB free at the calculated peak.
MIGRATION_CAPACITY="$AUDIT_DIR/bulk-capacity-$MIGRATION_JOB-$MIGRATION_START_PHASE.json"
if ! plan_migration_capacity "$MIGRATION_JOB" "$MIGRATION_START_PHASE" \
  "$MIGRATION_EXPECTED_TARGETS_JSON" | tee "$MIGRATION_CAPACITY"; then
  echo "refusing bulk mutation; inspect $MIGRATION_CAPACITY" >&2
  exit 1
fi

compose exec -T api python3 -m airfoilfoam.evidence_migration \
  --execute "${MIGRATION_TARGET_ARGS[@]}" \
  2>&1 | tee -a "$AUDIT_DIR/bulk-pass1-python.jsonl"
verify_migration_job "$MIGRATION_JOB" uploaded \
  "$MIGRATION_EXPECTED_TARGETS_JSON" \
  | tee -a "$AUDIT_DIR/bulk-pass1-verified.jsonl"

compose exec -T sweeper pnpm --filter @aerodb/sweeper exec tsx \
  src/evidence-storage-backfill.ts "${MIGRATION_TARGET_ARGS[@]}" \
  2>&1 | tee -a "$AUDIT_DIR/bulk-pass2-plan.jsonl"

# If a historical manifest member has no logical artifact row and its unpacked
# file is absent, both this plan and execute require a fresh generation-pinned
# verification of the complete canonical GCS archive through the engine's
# closed-world manifest verifier. A mismatched pointer, manifest/member-set
# identity, duplicate, special, unsafe, extra, missing, or corrupt member stops
# before any database write.
compose exec -T sweeper pnpm --filter @aerodb/sweeper exec tsx \
  src/evidence-storage-backfill.ts --execute "${MIGRATION_TARGET_ARGS[@]}" \
  2>&1 | tee -a "$AUDIT_DIR/bulk-pass2-node.jsonl"
verify_migration_job "$MIGRATION_JOB" registered \
  "$MIGRATION_EXPECTED_TARGETS_JSON" \
  | tee -a "$AUDIT_DIR/bulk-pass2-verified.jsonl"

# Re-measure after upload/registration. The campaign remains live, so the
# initial free-space snapshot is not sufficient evidence for the destructive
# fresh-restore pass.
MIGRATION_FINAL_CAPACITY="$AUDIT_DIR/bulk-capacity-$MIGRATION_JOB-finalize.json"
if ! plan_migration_capacity "$MIGRATION_JOB" finalize_or_complete \
  "$MIGRATION_EXPECTED_TARGETS_JSON" | tee "$MIGRATION_FINAL_CAPACITY"; then
  echo "refusing finalization; inspect $MIGRATION_FINAL_CAPACITY" >&2
  exit 1
fi

compose exec -T api python3 -m airfoilfoam.evidence_migration \
  --execute "${MIGRATION_TARGET_ARGS[@]}" \
  2>&1 | tee -a "$AUDIT_DIR/bulk-pass3-python.jsonl"
verify_migration_job "$MIGRATION_JOB" finalized \
  "$MIGRATION_EXPECTED_TARGETS_JSON" \
  | tee -a "$AUDIT_DIR/bulk-pass3-verified.jsonl"
```

There is no `--continue-on-error`: this is one atomic operator cycle, and any
failed target stops it on the same pinned job/subset. Restarting the exact cycle
is safe and idempotent: repeated paths are deduplicated and every requested path
must still resolve. Select another subset only after the final verifier succeeds.
Repeat the inventory before each new cycle so state drift, mixed scope, and
corrupt candidates cannot be hidden by an earlier snapshot. End only when all
three selectors return empty, the inventory has no blocking job, and
reconciliation shows no awaiting receipt or legacy source bytes.

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

cache = Path("/data/airfoilfoam/evidence-hydration-cache")
print(json.dumps({
    "receiptStates": dict(states),
    "pointers": pointers,
    "legacyGzipBytes": legacy_gzip,
    "localZstdBytes": local_zstd,
    "packagedRawBytes": packaged_raw,
    "hydrationCacheBytes": size(cache),
}, indent=2, sort_keys=True))
PY
```

Once every migration receipt is complete, `legacyGzipBytes`, `localZstdBytes`,
and `packagedRawBytes` must be zero. Every receipt must be `complete` and the
pointer count must equal the receipt count. The cache is expected to fluctuate
and is not canonical evidence. Failed or unpublished generations are
disposable and must be cleaned by the solver lifecycle rather than entered into
this migration inventory.

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
Do not create a partial archive or a quarantine record for a failed generation:
discard it and submit a clean rerun.

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

## 10.1 Hub-brokered evidence from a credentialless remote solver

The hub and a remote solver have deliberately different storage contracts.
The production hub owns `airfoils-pro-storage-bucket` through its workload
identity and keeps the normal remote-only GCS evidence contract. A remote node
such as `hz-solver2` receives neither a service-account JSON file nor ambient
GCS credentials. It produces the same immutable `tar.zst`, retains that local
file temporarily, and uploads it only through a short-lived resumable HTTPS
capability issued by the hub for one exact active promise, point, attempt,
solver identity, checksum, byte size, and canonical object key.

The required remote engine environment is therefore:

```dotenv
AIRFOILFOAM_EVIDENCE_BUCKET=
AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=false
```

Do not copy the hub's service-account key, Application Default Credentials, or
bucket setting to the remote node. `remote-only=true` would let a
credentialless engine delete the only local archive before the brokered upload.
The sweeper checks this contract at startup and again before remote
reconciliation/admission, and refuses remote work when either the bucket is
nonempty or remote-only retention is enabled.

The remote node authenticates to the hub with its own revocable solver token.
The opaque upload URL is a bounded capability, not a reusable GCS credential;
it must never be logged, placed in configuration or error text, exposed to an
admin/public/browser payload, or persisted on the remote solver. For crash-safe
recovery and exact cancellation, the hub may retain it only in the protected
`sync_brokered_evidence_uploads` control-plane row and the engine may retain it
only in its mode-0600 owner-bound session ledger. Both copies must be cleared as
soon as verification/binding succeeds or cancellation/expiry is acknowledged;
settled and cancelled ledger records retain the outcome but not the bearer.
After upload, the hub independently restores the exact generation, verifies
CRC32C, stored and uncompressed SHA-256 and byte sizes, authenticates the
manifest and every declared member, and only then permits the exact result
generation to bind. Revocation, expiry, cancellation, identity drift, a cleanup
reservation, or any mismatch fails closed. Keep the remote archive until the
hub returns that verified binding; normal engine retention may remove it only
after that acknowledgement.

The remote solver renews the exact upstream promise with a one-hour TTL before
transfer and at a bounded interval of at most 20 minutes throughout both the
brokered GCS stream and the following multipart polar push. This timer is
independent of byte progress. An authoritative heartbeat 404/409 aborts the
transfer and cancels local job/promise/point ownership; a timeout, network
failure, 408/429, or 5xx aborts only the delivery attempt and remains retryable.
Do not weaken the hub's active-lease binding gate to accommodate a slow upload.

A signed binding receipt is necessary but is not by itself permission to
delete the remote solver's local evidence. Before every reclaim attempt, the
remote solver must resolve the exact immutable bundle/attempt remote reference,
authenticate to the configured same-origin hub with its current solver token,
GET the exact bound-upload download path with redirects disabled, consume the
body to EOF, and match declared and actual bytes, stored SHA-256, GCS generation,
and `application/zstd` MIME type against both the reference and receipt. Only
then may it call the local engine reclaim endpoint. Missing/rotated credentials,
403/409, redirects, truncation, or any identity mismatch are persisted with
backoff; all local archive and raw CFD bytes remain intact. The exact reclaim
claim token is renewed at most every two minutes throughout the readback and
engine acknowledgement, so the ten-minute claim cannot expire and be stolen by
a second sweeper during a slow multi-hour stream. A sequential worker claims
only one reclaim row at a time; additional rows remain pending and unclaimed
until that readback settles. Horizontal workers coordinate with `SKIP LOCKED`.

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
