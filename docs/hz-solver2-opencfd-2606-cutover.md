# hz-solver2 OpenCFD 2606 cutover

This runbook upgrades only the dedicated remote solver `hz-solver2`. It does
not run the production hub's campaign-successor transition and it does not
copy the hub's GCS credentials. The hub remains authoritative for catalog,
promises, accepted result identity, and final GCS evidence. The remote solver
keeps its complete `tar.zst` evidence on the existing Docker volume until the
hub acknowledges the corresponding delivery.

## Persistent deployment profile

Install the remote-solver values from `.env.remote-solver.example` into the
existing owner-only `/opt/airfoils-pro/state/.env.deploy`; preserve every
unrelated secret already in that file. Install
`scripts/deploy/docker-compose.remote-solver.yml.example` as
`/opt/airfoils-pro/state/docker-compose.remote-solver.yml`. The state file is
external to versioned releases on purpose.

The exact invariants are:

- `AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver`
- `COMPOSE_PROJECT_NAME=hz-solver2`
- both the base deployment Compose file and the external remote-solver
  override are used for every Compose operation
- worker CPU budget, case concurrency, Celery concurrency, and container CPU
  limit are all 40
- evidence bucket is empty, object prefix is `solver-evidence/v1`, compression
  is Zstandard level 10, and remote-only is explicitly false
- the existing `results`, `engine_runtime`, and `pgdata` volumes remain mounted

Do not put `GOOGLE_APPLICATION_CREDENTIALS`, a service-account key, the hub's
bucket name, or any other GCS credential on this server.

Before promotion, validate the state without printing the expanded Compose
configuration (it contains secrets):

```bash
cd /opt/airfoils-pro/app
python3 scripts/deploy/deployment-env-preflight.py \
  --app-dir /opt/airfoils-pro/app \
  --state-dir /opt/airfoils-pro/state \
  --env-file /opt/airfoils-pro/state/.env.deploy

docker compose \
  --env-file /opt/airfoils-pro/state/.env.deploy \
  -p hz-solver2 \
  -f /opt/airfoils-pro/app/docker-compose.deploy.yml \
  -f /opt/airfoils-pro/state/docker-compose.remote-solver.yml \
  config --format json \
  | python3 scripts/deploy/validate-remote-solver-compose.py
```

Promote the control-plane source through the existing atomic release workflow.
An ordinary `vps-redeploy.sh` deployment deliberately rebuilds only the Node
control plane and leaves the live 2406 API/worker untouched.

## Drain and cut over

Let the remote solver continue claiming, solving, and delivering work until a
natural idle boundary. Do not turn `remoteSolverEnabled` off to create that
boundary: disabling it is an authority-release action that cancels mirrored
promises. The cutover script samples the boundary twice and fails closed if a
new claim wins the race.

Its idle gate requires all of the following to be zero or absent:

- pending/submitted/running/ingesting local jobs
- active remote promises
- unacknowledged result deliveries and promise cancellations
- queued, reserved, scheduled, or active Celery work
- live OpenFOAM, meshing, decomposition, reconstruction, conversion, or
  post-processing child processes

Run the dedicated workflow with one immutable build ID:

```bash
cd /opt/airfoils-pro/app
sudo scripts/deploy/rebuild-remote-solver-engine.sh \
  hz-solver2-opencfd2606-YYYYMMDD-N
```

The script holds the shared deployment lock, verifies the promoted source and
the merged 40-CPU profile, records and scratch-restores a custom-format
PostgreSQL backup, retains exact 2406 image rollback tags, disables both
OpenCFD pools, builds the target images, and recreates only `api`, `worker`, and
`node-api`. Scheduler containers are recreated stopped during the proof.

The volume canary then proves:

- the official OpenCFD 2606 runtime and exact adapter identity
- a two-angle serial RANS march with one reused mesh
- a two-rank MPI RANS solve
- forced preliminary URANS without invented shedding evidence
- exact manifest, stored-bundle, and uncompressed-tar hashes and byte sizes
- download and post-strip field extents/default/custom rendering forced through
  verified extraction of the retained local archive

Only after the private receipt and recovery-bound attestation are durable does
the script install the terminal marker and restore the prior scheduler/media
writer state. A failed or interrupted run leaves both execution pools disabled
and the writers stopped. Re-run the same build ID; the phase marker either
resumes the build/recreate or re-proves the retained receipt without submitting
replacement canary work.

## Post-cutover verification

Use the same two Compose files for every check:

```bash
docker compose \
  --env-file /opt/airfoils-pro/state/.env.deploy \
  -p hz-solver2 \
  -f /opt/airfoils-pro/app/docker-compose.deploy.yml \
  -f /opt/airfoils-pro/state/docker-compose.remote-solver.yml \
  ps

curl -fsS http://127.0.0.1:8000/health
curl -fsS http://127.0.0.1:8000/queue

docker compose \
  --env-file /opt/airfoils-pro/state/.env.deploy \
  -p hz-solver2 \
  -f /opt/airfoils-pro/app/docker-compose.deploy.yml \
  -f /opt/airfoils-pro/state/docker-compose.remote-solver.yml \
  exec -T worker sh -lc \
  'nproc; env | grep -E "^AIRFOILFOAM_(WORKER_CPU_BUDGET|CASE_CONCURRENCY|CELERY_CONCURRENCY)="'

docker inspect hz-solver2-worker-1 \
  --format '{{.HostConfig.NanoCpus}}'
```

All three settings must be 40 and `NanoCpus` must be `40000000000` (a 40-CPU
CFS quota). `nproc` must not be below 40; depending on the host's coreutils and
cgroup implementation it can report the broader host affinity instead of the
quota, so it is not the authoritative limit check. A 40-slot worker does not
mean one promise contains 40 sweeps: the hub decides promise size, while the
worker may use the slots across independent jobs/cases and MPI ranks.
Continuous utilization also requires the production hub to expose eligible
gaps and `remoteSolverEnabled` plus the sweeper to remain running.

Confirm that the sweeper is running, its remote-solver status is not disabled
or error, promises continue to arrive, completed jobs create durable delivery
rows, and those rows reach `delivered` or `superseded`. Generic retention will
not strip a remote job before that job-level acknowledgement.

## Rollback boundary

Before any volume-canary receipt exists and before any local OpenCFD 2606
simulation job/evidence exists, the explicit rollback path is:

```bash
sudo /opt/airfoils-pro/app/scripts/deploy/rebuild-remote-solver-engine.sh \
  --rollback
```

It uses the retained image IDs and generated private rollback Compose override,
restores the prior build/engine/pool state, and leaves the database, migrations,
named volumes, and backup files intact. Once a canary receipt exists, rollback
is refused: re-run the exact target build ID and finish its attestation so
verified 2606 evidence is not abandoned.
