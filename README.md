# XFoilFOAM

Compute **airfoil angle-of-attack polars** (Cl, Cd, Cm vs. AoA) through a
versioned solver-engine gateway. The implemented engines are currently 2D RANS
and URANS OpenFOAM adapters: **OpenCFD 2606** is the default and **OpenFOAM
Foundation 14** is an opt-in, isolated execution pool. You give the service an
airfoil (Selig/Lednicer coordinates), physical dimensions, fluid properties,
speed, and surface roughness; it meshes the airfoil, runs the selected engine in
Docker, and returns coefficients plus stored evidence and contour media.

> The current default worker is based on the digest-pinned official
> `opencfd/openfoam-run:2606` runtime image. It is not based on the Foundation
> 14 repository. The
> optional Foundation worker uses the official package corresponding to
> [OpenFOAM/OpenFOAM-14](https://github.com/OpenFOAM/OpenFOAM-14). See
> [Solver engine contract](docs/solver-engine-contract.md) for exact identities,
> provenance, compatibility, and rollout rules.

> Despite the project name, **XFoil is not integrated as a solver engine** in
> this release. The service is not affiliated with XFOIL. A future open-source
> solver derived from Drela's published thesis will receive its own name,
> family/release lineage, method profile, and validation record; it will not be
> represented as MSES.

## Airfoils.Pro — airfoil database & simulation portal

On top of the solver gateway sits **Airfoils.Pro**, an explorable web database of
airfoil profiles with a modern UI and a Node control-plane that selects an
immutable solver implementation and execution pool for every job. It is a
**pnpm monorepo** (Node + Next.js + Postgres) around the Python engine gateway.

```
apps/web   — Next.js (App Router) UI: Browse / Search / Compare / Airfoil Detail
             (RANS/URANS sim modal), light+dark themes, and an /admin queue console
apps/api   — Fastify control-plane: catalog, detail payloads, coordinate export,
             airfoil create (single + bulk), mediums, boundary conditions, media
             serving, simulate-enqueue, and the admin/queue endpoints
packages/db            — Drizzle schema + migrations + idempotent seed (Postgres)
packages/core          — pure TS: NACA/source geometry, evidence metrics, chart
                         projection, viscosity (ported from the design's airfoil-db.js)
packages/engine-client — typed client for the Python /polars API
```

**Evidence-first data model.** Airfoil geometry is stored from trusted coordinates
or an explicit deterministic airfoil definition. Aerodynamic values stay queued
until accepted OpenFOAM evidence exists: real Cl/Cd/Cm plus contour images for
RANS and video + force-history for URANS (post-stall). Missing solver evidence is
shown as missing/queued, never filled with invented polar values.

The Postgres database stores: a **category tree** (materialized path), **airfoils as
point data** + derived geometry, a **mediums registry**, a
**boundary-condition registry** (medium + operating state + the full CFD knobs), and
a **results** table (per airfoil × boundary-condition × AoA, with media and URANS
force history). A fresh reset seeds real Selig/UIUC coordinate geometry and
CoolProp-verified mediums; boundary conditions, jobs, results, and media start
empty.

### Run the portal

```bash
docker compose up --build    # postgres + node-api(:4000) + web(:3100), plus the
                             # gateway + default OpenCFD 2606 worker. node-api migrates + seeds.
# open http://localhost:3100  →  Browse  →  any airfoil  →  Detail
```

The default command intentionally does not start Foundation 14. To make the
adapter and its isolated queue available locally, start the Compose profile and
enable its exact gateway handshake key together:

```bash
AIRFOILFOAM_ENABLED_ENGINE_KEYS='openfoam:opencfd:2606:numerics-1:adapter-1,openfoam:foundation:14:numerics-1:adapter-1' \
  docker compose --profile foundation14 up --build
```

Then open **Admin → Queue → Engine**, confirm the gateway acknowledges
`OpenFOAM / Foundation / 14` on `openfoam-foundation-14`, and enable that
execution pool. The database pool is disabled by default, so merely having the
adapter code or image present cannot route production work to it. New solver
profiles select an immutable implementation; new OpenCFD work uses 2606.
Historical 2406 revisions and evidence remain immutable. In this repository's
schema and Compose graph their execution pool is disabled and no 2406 worker
service is retained. A production installation remains unchanged until the
guarded cutover below is run against that installation.

Engine identity and deployment state are separate:

- `family + distribution + version + numerics_revision` identifies numerical
  compatibility and cache namespaces;
- `adapter_contract_version` is part of the exact request/worker handshake but
  does not split otherwise identical public polars;
- build id, source revision, image/package/binary digests, and architecture are
  runtime provenance stored on the actual job and evidence; and
- an execution pool owns mutable routing/capacity state and can be disabled
  without rewriting immutable solver evidence.

Local dev (no Docker), against a Postgres you have running:

```bash
pnpm install
cp .env.example .env                # set DATABASE_URL
pnpm db:migrate && pnpm db:seed     # schema + seed: Selig/UIUC geometry + mediums
pnpm --filter @aerodb/api dev       # control-plane API on :4000
pnpm --filter @aerodb/web dev       # UI on :3100
pnpm --filter @aerodb/core test     # golden tests vs the design's airfoil-db.js
```

> When a dev-coordinator-managed runtime is already running for this checkout
> (`.codex/dev-runtime.json` — web on **http://127.0.0.1:3004**, API on :4000),
> use that URL instead of starting a second `pnpm --filter @aerodb/web dev`:
> two Next dev servers share one `apps/web/.next` and corrupt each other's
> route manifests (symptom: every page 404s on one of them).

### Admin console

`/admin` shows and manages the solver queue: the CFD sweeper (pause/resume,
concurrency), the backlog of pending cases, in-flight/solved/failed counts, the
recent `sim_jobs` (with cancel), the registered engine implementations and their
execution pools, and a requeue-failed action. Auth is enforced by
the API: **open in dev** (`NODE_ENV` ≠ `production`), **Google OAuth or configured
password in prod** (a signed HttpOnly session cookie). Google admin access is
configured with `ADMIN_GOOGLE_CLIENT_ID`, `ADMIN_GOOGLE_CLIENT_SECRET`,
`ADMIN_GOOGLE_ALLOWED_DOMAIN=vr.ae`, and
`ADMIN_GOOGLE_REDIRECT_URI=https://airfoils.pro/api/admin/oauth/google/callback`.
Password fallback is available only when `ADMIN_PASSWORD` is set. Configure the
cookie signer with `ADMIN_SESSION_SECRET`; force auth/open modes with
`ADMIN_AUTH_REQUIRED=true` / `ADMIN_AUTH_DISABLED=true`.

### Production deployment

Pushes to `master` or `main` run `.github/workflows/deploy-airfoils-pro.yml`.
The workflow uploads the checked-out source to the VPS over SSH and runs
the guarded versioned-release promoter. A fully verified release is
materialized under `/opt/airfoils-pro/releases`, then `/opt/airfoils-pro/app`
is switched atomically to that release before `vps-redeploy.sh` runs. The
private live environment remains outside replaceable source at
`/opt/airfoils-pro/state/.env.deploy`.

Required GitHub secrets:

- `AIRFOILS_VPS_HOST`
- `AIRFOILS_VPS_USER`
- `AIRFOILS_VPS_SSH_KEY`
- `AIRFOILS_VPS_KNOWN_HOSTS` containing the operator-verified pinned host-key
  line for the exact host and port
- optional `AIRFOILS_VPS_PORT`

Repository variables:

- `AIRFOILS_VPS_APP_DIR` defaults operationally to `/opt/airfoils-pro/app`
- `AIRFOILS_PUBLIC_ORIGIN` defaults operationally to `https://airfoils.pro`

The default deploy is solver-safe: it rebuilds/restarts only `node-api`, `web`,
and `sweeper`. It does **not** restart the Python engine `api` gateway or any
solver worker, so active OpenFOAM child processes keep running. The VPS host
itself does not install OpenFOAM; each OpenFOAM distribution lives in its own
Docker worker image and Celery queue. To update the gateway or configured engine
workers, use only `scripts/deploy/rebuild-engine.sh <build-id>`. That guarded
maintenance script discovers every worker in the active Compose profiles,
scans all registered profiles for live solver processes, refuses an
unconfigured-but-still-running worker, proves aggregate engine work idle before
the image build and twice before recreation, updates gateway/worker/control-plane
build identities together, and preserves the sweeper's prior running/stopped
state. The ordinary control-plane deploy deliberately rejects
`DEPLOY_OPENFOAM_SERVICES=1`.

Finalized solver evidence is stored as content-addressed Zstandard archives in
private GCS and hydrated into a bounded temporary cache for downloads and
rendering. The bucket/IAM setup, verified database backup, guarded engine
rollout, one-job trial, bulk three-pass legacy migration, reconciliation, and
rollback steps are in the
[GCS Zstandard evidence migration runbook](docs/evidence-object-storage-runbook.md).

The maintenance idle gate treats every registered routing queue as draining
work, including a currently disabled database pool. It validates the per-route
depths against the aggregate before proceeding; disabling a pool is not a way to
hide already queued work from the solver-safety guard.

The one-time production OpenCFD 2406 → 2606 transition is deliberately staged:

1. Deploy the new Node control plane and database schema with
   `scripts/deploy/vps-redeploy.sh`. This does not touch either solver
   container.
2. Supply a valid signed admin cookie in `ADMIN_COOKIE`, then run
   `scripts/deploy/rebuild-engine.sh <new-build-id>`.
3. The guarded script disables and retires 2406 admission, records and pauses
   every affected campaign, cancels only work that has not started, and waits
   for submitted/running/ingesting 2406 or legacy work to settle. It then proves
   both the engine queue and all solver processes idle before replacing the
   `worker` container with the digest-pinned 2606 image and its isolated
   `openfoam-opencfd-2606` route.
4. Before any campaign is moved, the script activates the handshaken 2606 pool
   and runs real serial RANS, two-rank MPI RANS, and forced-URANS canaries through
   the gateway. The canaries verify exact runtime provenance, coefficients, y+,
   mesh, dictionaries, logs, force files, VTK, stored media, and checksummed
   evidence bundles. A failure disables the target pool and leaves campaigns
   paused with `OPENCFD2606_CUTOVER_PENDING=1` for a safe idempotent retry.
5. Only after those canaries pass does the database create a linked successor
   generation for each affected campaign. It snapshots the exact eligible
   source cells (current-generation `active`/`kept` conditions and non-released
   points) as fresh 2606 obligations, releases the old scheduling rows,
   preserves every 2406 result/attempt/artifact unchanged, and restores only
   campaigns that were runnable before maintenance. A campaign that was already
   paused stays paused.

Do not bypass this workflow with a raw Compose recreate or manually rewrite
solver identities. Before a canary receipt exists, replaying the guarded build
command resumes its idempotent pre-attestation stages. Once an exact receipt or
attestation has been recorded, a normal rebuild refuses to substitute another
runtime; finish the same live-runtime workflow with
`scripts/deploy/rebuild-engine.sh --certify-opencfd-2606-continuation`. Neither
path duplicates a successor generation or reinterprets historical evidence.

The recovery tuple is written and fsynced through an atomic replacement before
the first mutating prepare request. From that point until terminal continuation
proof, any nonzero script exit stops the sweeper and closes 2606 admission.
Preparation idempotently disables both the retired and target pools. If an
attestation response is lost, its mode-0600 receipt remains on disk; the
certification-only command replays that exact receipt against the unchanged
live runtime, persists the returned attestation ID atomically, and only then
removes the receipt. Nonempty, malformed, or inconsistent recovery state blocks
an ordinary rebuild. The marker clears only after exact successor evidence or
a truthful `not_required` result, and the recorded pre-maintenance scheduler
state remains authoritative.

The repository's removed 2406 worker has no Compose service. Production loses
its live 2406 container only when the guarded cutover reaches that stage. For a
separately approved emergency rollback, its image can be reconstructed without
deploying it:

```sh
scripts/deploy/reconstruct-opencfd-2406-image.sh \
  --receipt /secure/audit/opencfd-2406-reconstruction.json
```

The receipt parent (for example `/secure/audit`) must already exist as a
non-symlink directory with operator-controlled permissions. The command does
not create that audit directory: it validates and fsyncs the mode-0600 receipt,
publishes it without overwriting an existing receipt, and fsyncs the parent
before reporting success.

That command exports the exact pre-cutover source commit from Git, builds it
against the recorded digest-pinned OpenCFD 2406 base, verifies the packaged
`simpleFoam`, and records the resulting image ID and measured binary checksum.
It does not change Compose, pools, campaigns, the database, or running
services. Activating the reconstructed image requires its own explicit,
idle-guarded rollback transition; it is never a standing 2406 container.

Production Foundation 14 activation is a maintenance operation:

1. Keep its database execution pool disabled.
2. Add `COMPOSE_PROFILES=foundation14` and the Foundation handshake key to
   `AIRFOILFOAM_ENABLED_ENGINE_KEYS` in `.env.deploy`.
3. Run `scripts/deploy/rebuild-engine.sh <new-build-id>`. Do not use a raw
   `docker compose up --force-recreate` command.
4. Confirm `/capabilities`, worker logs, and a real canary, then enable the
   Foundation pool from **Admin → Queue → Engine**.

To roll back routing, first disable the Foundation execution pool. Let its queue
and active work drain, then keep the profile configured until a guarded
maintenance window; removing the profile while its container is still running
is intentionally rejected by `rebuild-engine.sh`. Immutable Foundation evidence
retains its original implementation and runtime provenance after rollback.

The engine's persistent mesh/steady-seed cache (build `dev-20260704-batch-cache`
and later) requires a **worker image rebuild** to pick up
(`scripts/deploy/rebuild-engine.sh <build-id>` in production, or
`docker compose build worker` locally). Local Compose stores the cache on the
named `engine_cache` volume at `/data/airfoilfoam-cache`; production defaults to
the persistent results volume at `/data/airfoilfoam/cache` unless
`AIRFOILFOAM_CACHE_DIR` is set explicitly. Cached meshes and solution seeds
therefore survive image rebuilds and container restarts; the store is size-capped
by `AIRFOILFOAM_CACHE_MAX_GB` (default 20) with LRU eviction, and deleting only
the cache costs re-meshing/cold starts, never result evidence. Cache keys
include numerical engine identity, so OpenCFD 2606 and Foundation 14 cannot
silently reuse incompatible mesh/solution state. All engine workers also share
the `engine_runtime` volume for one cross-container CPU-token ledger; starting
an optional pool does not create a second independent solver CPU budget.

**Status.** OpenCFD 2606 is the implemented and locally canary-verified default
path. The repository treats the former 2406 identity as historical-only, and
the guarded deployment cutover migrates an active campaign to a linked
eligible-snapshot 2606 successor generation without rewriting its 2406
evidence. That production cutover has not been run by this repository change;
the live campaign and container remain untouched until an authorized operator
runs it. The multi-engine identity/routing foundation and Foundation 14 adapter are
implemented behind an opt-in execution pool; production activation still follows
the canary gate above. _Phase 1_: the Postgres database
(categories, airfoils, mediums, boundary conditions, results), the control-plane API,
and the pixel-faithful Airfoil Detail page. Aerodynamic rankings and charts appear
only after accepted solver evidence is stored. _Phase 2_: the continuous CFD
**sweeper** (gap-fill → `solved` upgrades the page in place; integration-tested),
the **Browse / Search / Compare** pages, and the Python URANS extensions — the
transient fallback now also emits a
**Cl/Cd time-history**, a **measured Strouhal** number, **time-averaged** + **vorticity
/ Cp** fields, and an **mp4 animation** (verified end-to-end against real OpenFOAM).
Turn the worker on with `curl -X PATCH localhost:4000/api/sweeper -d '{"enabled":true}'
-H 'content-type: application/json'` (needs the CFD engine — `api` + `worker` — running).

## Features

- **Airfoil input**: Selig and Lednicer coordinate formats (auto-detected), or an
  explicit point list. Geometry is chord-aligned, normalised and given a closed
  (sharp) trailing edge automatically.
- **Meshing is pluggable** (a `Mesher` interface + registry). Ships with a
  parametric **blockMesh C-grid**; the first wall-cell height is sized per case for
  a target **y+**.
- **Steady incompressible RANS** through the selected distribution dialect
  (`simpleFoam` on OpenCFD 2606; `foamRun -solver incompressibleFluid` on
  Foundation 14). Turbulence models:
  `kOmegaSST` (default), `kOmega`, `kEpsilon`, `SpalartAllmaras`, and the
  **`kOmegaSSTLM` laminar-turbulent transition model** (Langtry-Menter) for
  low-Re / transitional flows.
- **Transient (URANS) fallback for unsteady flows.** The dialect uses
  `pimpleFoam` on OpenCFD 2606 and the modular `incompressibleFluid` solver on
  Foundation 14. When a steady case will not
  converge (typically post-stall, with massive separation and vortex shedding),
  the pipeline automatically re-runs it transient with `pimpleFoam` on a
  wall-function mesh and reports **time-averaged** Cl/Cd/Cm with their fluctuation
  (`cl_std`, …) — turning the otherwise-meaningless steady snapshot into a
  physically meaningful mean. Flagged with `unsteady: true`.
- **Angle of attack by rotating the freestream** (the mesh never moves), so a whole
  AoA polar reuses one topology. Lift/drag directions are rotated to match.
- **Sand-grain wall roughness** (`nutkRoughWallFunction`).
- **Batch requests**: one polar per `(chord, speed)` combination, each over a set/
  range of angles.
- **Outputs**: polars as JSON and CSV, convergence/residual and y+ diagnostics, and
  **contour images** (velocity magnitude/x/y, pressure, k, nut) rendered with
  matplotlib (no GPU needed).
- **Async**: FastAPI enqueues jobs to Celery/Redis; the OpenFOAM worker runs cases
  concurrently and streams progress.

## Throughput: mesh once, solve many

A polar job is organised for batch efficiency:

- **Mesh once per airfoil/chord.** `blockMesh` runs once per `(airfoil, mesh, chord)`
  and the resulting mesh is reused by every speed and angle (the steady solution
  depends only on Re, set per case). The mesh is sized for the highest Re in the
  batch. Reuse is by absolute symlink under the local runner (no copy), or copied
  into each case under the docker runner (which mounts only the case dir).
- **Solve every (speed, AoA) concurrently** (default). Each case is independent,
  cold-started with a `potentialFoam` init on the shared mesh, and run in parallel —
  the most robust and parallel option.
- **Optional warm-start marching** (`solver.warm_start=true`). Within a polar, angles
  are marched in order, each continuing from the previous converged field (only the
  velocity BC + lift/drag dirs change), skipping the per-angle `potentialFoam`. This
  helps for finely-spaced sweeps in the attached regime, but the per-angle
  `potentialFoam` init is often competitive (or better near α≈0), so it's off by
  default — benchmark it for your spacing.
- **Serial per case, parallel across cases.** 2D meshes (20–70k cells) scale poorly
  past ~2 MPI ranks, so keep `AIRFOILFOAM_SOLVER_PROCESSES=1` and get throughput from
  `AIRFOILFOAM_CASE_CONCURRENCY` (≈ cores); scale out by adding workers. Reserve a
  small `solver_processes>1` pool only for the expensive URANS (wave-2) fallback.

For database-scale runs (wave 1 steady, wave 2 unsteady), set
`solver.transient_fallback=false` for wave 1 (so post-stall points don't trigger the
costly URANS), then re-run only the flagged points with it enabled for wave 2.

## Architecture

```
client ──HTTP──▶ FastAPI gateway ──▶ Redis ─┬─▶ OpenCFD 2606 worker (`openfoam-opencfd-2606`)
                                      └─▶ Foundation 14 worker (`openfoam-foundation-14`, opt-in)
                    │                           │
                    └── shared results/cache/runtime volumes ◀─┘
```

- **api** container (`docker/Dockerfile.api`): lightweight, no OpenFOAM. It
  validates an exact requested implementation/pool, routes the job, and serves
  results/images from the shared volume. Adapter presence alone is not
  schedulability: `AIRFOILFOAM_ENABLED_ENGINE_KEYS` is an explicit gateway
  allow-list.
- **worker** container (`docker/Dockerfile.worker`): built from the pinned
  official `opencfd/openfoam-run:2606` image and consumes only
  `openfoam-opencfd-2606`. The historical 2406 route `celery` has no executable
  worker after cutover.
- **worker-foundation14** container
  (`docker/Dockerfile.worker-foundation14`): installs the checksummed official
  Foundation 14 Ubuntu package and consumes only `openfoam-foundation-14`. It is
  excluded unless the `foundation14` Compose profile is active.
- Every worker acknowledges the exact logical identity, execution pool, and
  runtime provenance before its result is accepted. Each worker image generates
  a deterministic SHA-256 over its adapter/application sources, so provenance
  stays content-addressed even when the deployment has not injected the final
  OCI digest. Live pool activation also verifies that the worker consuming the
  route advertises this exact engine and fingerprint. A mismatch is an
  infrastructure failure, not solver evidence.
- For tests / local use on a host that only has the OpenFOAM _image_, a
  `DockerRunner` runs each OpenFOAM command in a fresh container.

Per-case OpenFOAM pipeline (`airfoilfoam/pipeline.py`): `blockMesh` → write
distribution-specific `0/ constant/ system/` dictionaries → potential-flow
initialisation → steady RANS or URANS → parse force coefficients → y+
→ field export → render and store contour media. The OpenCFD and Foundation
command/dictionary differences live behind explicit dialect adapters rather than
being guessed from a version string.

## Quick start (Docker Compose)

```bash
docker compose up --build        # starts redis, api (:8000), and default OpenCFD 2606 worker
```

Submit a polar (NACA 0012, three angles):

```bash
curl -s -X POST localhost:8000/polars -H 'content-type: application/json' \
  -d @examples/naca0012_polar.json | tee /tmp/job.json
JOB=$(jq -r .job_id /tmp/job.json)

curl -s localhost:8000/jobs/$JOB            # status / progress
curl -s localhost:8000/jobs/$JOB/result     # full polars (when completed)
curl -s localhost:8000/jobs/$JOB/polar.csv  # CSV
# images are linked from each polar point, e.g.
#   /jobs/<id>/files/cases/<case>/images/velocity_magnitude.png
```

The example request omits `expected_engine` only for convenience and therefore
resolves to the current OpenCFD 2606 default. New clients should send the exact engine and
execution-pool identity described in
[the engine contract](docs/solver-engine-contract.md#request-and-worker-handshake).

Interactive docs: <http://localhost:8000/docs>.

## Example output

A NACA 0012 polar at Re = 3.3×10⁶ (k-ω SST), AoA 0–12°, computed by the full
stack against the established OpenCFD OpenFOAM path (all points converged):

![NACA0012 polar](docs/examples/naca0012_polar.png)

Contour images returned per AoA (velocity magnitude and pressure at 10°):

![velocity](docs/examples/velocity_magnitude.png)
![pressure](docs/examples/pressure.png)

Regenerate the polar plot from a job result with
`python examples/plot_polar.py result.json out.png`.

### Deep stall: the transient (URANS) fallback

At AoA = 20° the flow is **massively separated and unsteady**, so a steady solver
cannot converge. On OpenCFD 2606 the pipeline detects this and automatically
re-runs the case as a `pimpleFoam` URANS, time-averaging the forces. Below is an
_instantaneous_ snapshot from such a run (NACA 0012, Re ≈ 5×10⁵), computed
end-to-end against real OpenFOAM —
the von-Kármán-style vortex street shed off the stalled airfoil is exactly what the
steady solver could not represent:

![URANS velocity magnitude](docs/examples/urans_velocity_magnitude.png)

Streamwise velocity makes the separation explicit — the dark region is **reversed
flow** (negative `Uₓ`, i.e. recirculation) covering the entire suction side and wake:

![URANS streamwise velocity](docs/examples/urans_velocity_x.png)

The instantaneous pressure field shows the low-pressure cores of the shed vortices
convecting downstream:

![URANS pressure](docs/examples/urans_pressure.png)

For this case the fallback reports **time-averaged Cl ≈ 0.75, Cd ≈ 0.33** with
fluctuation amplitudes `cl_std ≈ 0.05`, `cd_std ≈ 0.01` (returned as `cl_std`/`cd_std`
and flagged `unsteady: true`) — a physically meaningful mean and unsteadiness measure,
instead of the meaningless single iterate a non-converged steady run would return.

## API

| Method & path                 | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `GET /health`                 | liveness, build id, enabled/disabled logical engine inventory |
| `GET /capabilities`           | enabled engine identities/routes and method capabilities      |
| `POST /airfoils/parse`        | validate/parse an airfoil, report points & thickness          |
| `POST /polars`                | submit a job → `202` with `job_id`                            |
| `GET /jobs/{id}`              | job status & progress (`total_cases` / `completed_cases`)     |
| `GET /jobs/{id}/result`       | polars (Cl/Cd/Cm, y+, convergence, image URLs)                |
| `GET /jobs/{id}/polar.csv`    | polars as CSV                                                 |
| `GET /jobs/{id}/files/{path}` | fetch a result file (images, logs)                            |

See `examples/naca0012_polar.json` for the full request schema (also documented at
`/docs`).

## Running without the broker (CLI)

The package installs an `airfoilfoam` CLI:

```bash
airfoilfoam run examples/naca0012_polar.json   # runs synchronously, prints JSON
airfoilfoam serve                              # run the API
airfoilfoam worker                             # run a Celery worker
```

`airfoilfoam run` executes the same pipeline used by the worker, writing results
under `$AIRFOILFOAM_DATA_DIR/jobs/<id>/`.

## Configuration (env vars, prefix `AIRFOILFOAM_`)

| Variable                          | Default                                     | Meaning                                                                                                                             |
| --------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_DIR`                        | `/data/airfoilfoam`                         | results/cases storage (shared by api+worker)                                                                                        |
| `ENGINE_FAMILY`                   | `openfoam`                                  | extensible solver-family slug                                                                                                       |
| `ENGINE_DISTRIBUTION`             | `opencfd`                                   | implementation/distribution slug for this worker                                                                                    |
| `ENGINE_VERSION`                  | `2606`                                      | exact upstream release for this worker                                                                                              |
| `ENGINE_NUMERICS_REVISION`        | `1`                                         | revision of numerically significant adapter behavior/defaults                                                                       |
| `ENGINE_ADAPTER_CONTRACT_VERSION` | `1`                                         | request/worker wire-contract revision                                                                                               |
| `ENABLED_ENGINE_KEYS`             | OpenCFD 2606 handshake key                  | comma-separated gateway routing allow-list                                                                                          |
| `CELERY_QUEUE`                    | `openfoam-opencfd-2606`                     | isolated execution-pool routing key consumed by this worker                                                                         |
| `OPENFOAM_IMAGE`                  | digest-pinned `opencfd/openfoam-run:2606`   | image for the docker runner                                                                                                         |
| `OPENFOAM_RUNNER`                 | `docker`                                    | `docker` (one container per command) or `local` (inside the worker)                                                                 |
| `OPENFOAM_BASHRC`                 | `/usr/lib/openfoam/openfoam2606/etc/bashrc` | sourced before solvers                                                                                                              |
| `REDIS_URL`                       | `redis://localhost:6379/0`                  | Celery broker & backend                                                                                                             |
| `CASE_CONCURRENCY`                | `4`                                         | cases run in parallel per job                                                                                                       |
| `WORKER_CPU_BUDGET`               | detected quota/CPU count                    | total logical solver slots coordinated across engine workers                                                                        |
| `CPU_TOKEN_STATE_PATH`            | `/tmp/airfoilfoam-cpu-tokens.json`          | durable shared CPU-token ledger; Compose mounts `engine_runtime` here                                                               |
| `SOLVER_PROCESSES`                | `1`                                         | MPI ranks per case (`>1` → decomposePar/mpirun/reconstructPar)                                                                      |
| `SOLVER_TIMEOUT`                  | `7200`                                      | URANS/global per-case guard timeout (s)                                                                                             |
| `RANS_SOLVER_TIMEOUT`             | `1200`                                      | steady RANS per-case wall-clock timeout (s); slow 2D RANS points are stored as failed/non-converged evidence and the sweep moves on |
| `RANS_MAX_ITERATIONS`             | `600`                                       | worker-side SIMPLE iteration cap for steady RANS during large sweeps                                                                |

## Accuracy & meshing notes

The OpenCFD 2606 defaults are tuned for **robustness** (a converged,
steady, physically sensible solution across a wide AoA range) rather than
absolute accuracy. Foundation 14 uses its dedicated dictionary/command dialect;
do not treat command-name differences as evidence of numerical equivalence:

- The solver uses **plain SIMPLE** with under-relaxation (p 0.3, U 0.7, turbulence
  0.5), 2 non-orthogonal correctors and a `potentialFoam` initialisation. The
  far-field is a proper **inlet / pressure-referenced outlet** (fixed p=0 at the
  outlet) rather than a single freestream patch — this gives the pressure equation a
  solid reference and is what makes the delicate symmetric (AoA=0) case converge
  deterministically. The pipeline reports a case as converged when the residual
  control is met _or_ Cl/Cd are steady over the last 200 iterations
  (`force_is_steady`).
- **Automatic robustness fallback.** If a case still diverges with 2nd-order
  convection, the pipeline re-runs it once with 1st-order upwind (more dissipative
  but stable) and flags the point with `first_order_fallback`.
- Defaults target **y+ ≈ 1** (the first-cell height is computed per case from a
  flat-plate estimate). You can instead set `mesh.first_cell_height_chords` directly.
- **Known limitation — lift is conservative.** The parametric blockMesh C-grid has
  moderate trailing-edge skewness / non-orthogonality, which systematically
  _under-predicts_ the lift slope (typically ~20–40% low vs. wind-tunnel data) and
  shifts the centre of pressure forward. Drag is the right order of magnitude;
  trends (Cl increasing with AoA, roughness increasing drag, polar shape) are
  correct. Treat absolute numbers as engineering estimates and **validate against
  reference data** for quantitative work. The meshing layer is pluggable
  (`Mesher` registry) precisely so a higher-fidelity mesher (hyperbolic/elliptic,
  Gmsh, snappyHexMesh) can be dropped in for better accuracy.
- Lift also rises with **domain size**; increase `mesh.farfield_radius_chords` and
  resolution (`mesh.n_surface/n_radial/n_wake`) for more accuracy at higher cost.
  Very fine wall spacing (y+≪1) on a large domain can produce extreme aspect ratios
  near the wake — keep `n_*` and the domain in proportion.

### Post-stall and low-Re flows

- **Post-stall is unsteady**, so a steady solver cannot give a meaningful answer —
  it never converges and returns whatever iterate it stopped on. The transient
  fallback (above) handles this: it runs a `pimpleFoam` URANS on a coarser
  wall-function mesh (post-stall flow is pressure-dominated; a y+~1 wall would
  throttle the time step) and time-averages the forces. The `cl_std`/`cd_std`
  fields report the fluctuation amplitude — large in deep stall, which is correct.
  Tune `solver.transient_cycles`, `transient_discard_fraction` and
  `transient_max_courant`; 2D URANS captures the shedding and mean trends but for
  quantitative deep-stall loads a 3D DES/DDES run is the gold standard.
- **Low Reynolds (≈10⁵)** is transitional (laminar separation bubbles). Fully
  turbulent models are inappropriate there; use `solver.turbulence.model =
kOmegaSSTLM`. Transition is very sensitive to the freestream turbulence — set
  `solver.turbulence.intensity` to the real Tu (e.g. 0.001 for clean external flow).

## Development & tests

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest -m "not integration"     # fast unit tests, no Docker
pytest -m integration           # real OpenFOAM/media runs (needs Docker, the image, and host ffmpeg)
docker compose config >/dev/null
docker compose --profile foundation14 config >/dev/null
docker compose --profile foundation14 build worker-foundation14
```

Before enabling a new engine pool, exercise the adapter's serial and MPI RANS,
URANS, mesh reuse, force parsing, y+, field export/media, incremental result,
cancellation, and stale-job recovery paths. Passing a binary smoke test alone is
not a numerical-validation claim.

## License

The XFoilFOAM application code is MIT-licensed; see [LICENSE](LICENSE).
OpenFOAM is separate upstream software distributed under GPL-3.0. The OpenCFD
and Foundation worker images contain their respective OpenFOAM distributions,
so anyone redistributing those images must also satisfy the applicable GPL
source and notice obligations. Foundation's official release and licensing are
documented at [openfoam.org/version/14](https://openfoam.org/version/14/) and
[openfoam.org/download](https://openfoam.org/download/).
