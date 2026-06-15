# XFoilFOAM

Compute **airfoil angle-of-attack polars** (Cl, Cd, Cm vs. AoA) with **2D RANS CFD
in OpenFOAM**, exposed as a REST API. You give it an airfoil (Selig/Lednicer
coordinates), physical dimensions, fluid properties, speed and surface roughness;
it meshes the airfoil, runs OpenFOAM in Docker, and returns polars plus contour
images (velocity, pressure, turbulence).

> Not affiliated with XFOIL. The name nods to the goal — XFOIL-style polars — but
> the engine is a real finite-volume RANS solver (OpenFOAM `simpleFoam`).

## Features

- **Airfoil input**: Selig and Lednicer coordinate formats (auto-detected), or an
  explicit point list. Geometry is chord-aligned, normalised and given a closed
  (sharp) trailing edge automatically.
- **Meshing is pluggable** (a `Mesher` interface + registry). Ships with a
  parametric **blockMesh C-grid**; the first wall-cell height is sized per case for
  a target **y+**.
- **Steady incompressible RANS** with `simpleFoam`. Turbulence models:
  `kOmegaSST` (default), `kOmega`, `kEpsilon`, `SpalartAllmaras`.
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

## Architecture

```
client ──HTTP──▶ FastAPI (api)  ──enqueue──▶ Redis ──▶ Celery worker  (OpenFOAM image)
                    │                                      │
                    └────────── shared results volume ◀────┘   blockMesh ▶ simpleFoam ▶ foamToVTK
```

- **api** container (`docker/Dockerfile.api`): lightweight, no OpenFOAM. Validates
  requests, enqueues jobs, serves results/images from the shared volume.
- **worker** container (`docker/Dockerfile.worker`): built **FROM the OpenFOAM
  image** — the container *is* the OpenFOAM environment, so solvers run directly
  inside it (`AIRFOILFOAM_OPENFOAM_RUNNER=local`).
- For tests / local use on a host that only has the OpenFOAM *image*, a
  `DockerRunner` runs each OpenFOAM command in a fresh container.

Per-case pipeline (`airfoilfoam/pipeline.py`):
`blockMesh` → write `0/ constant/ system/` → `potentialFoam` (init) → `simpleFoam`
→ parse `forceCoeffs` → `yPlus` → `foamToVTK` → render contour images.

## Quick start (Docker Compose)

```bash
docker compose up --build        # starts redis, api (:8000) and an OpenFOAM worker
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

Interactive docs: <http://localhost:8000/docs>.

## API

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /capabilities` | available meshers, turbulence models, OpenFOAM image |
| `POST /airfoils/parse` | validate/parse an airfoil, report points & thickness |
| `POST /polars` | submit a job → `202` with `job_id` |
| `GET /jobs/{id}` | job status & progress (`total_cases` / `completed_cases`) |
| `GET /jobs/{id}/result` | polars (Cl/Cd/Cm, y+, convergence, image URLs) |
| `GET /jobs/{id}/polar.csv` | polars as CSV |
| `GET /jobs/{id}/files/{path}` | fetch a result file (images, logs) |

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

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/data/airfoilfoam` | results/cases storage (shared by api+worker) |
| `OPENFOAM_IMAGE` | `opencfd/openfoam-default:2406` | image for the docker runner |
| `OPENFOAM_RUNNER` | `docker` | `docker` (one container per command) or `local` (inside the worker) |
| `OPENFOAM_BASHRC` | `/usr/lib/openfoam/openfoam2406/etc/bashrc` | sourced before solvers |
| `REDIS_URL` | `redis://localhost:6379/0` | Celery broker & backend |
| `CASE_CONCURRENCY` | `4` | cases run in parallel per job |
| `SOLVER_PROCESSES` | `1` | MPI ranks per case (`>1` → decomposePar/mpirun/reconstructPar) |
| `SOLVER_TIMEOUT` | `7200` | per-case timeout (s) |

## Accuracy & meshing notes

- Defaults target **y+ ≈ 1** (the first-cell height is computed per case from a
  flat-plate estimate). For wall-function accuracy at high Re you can instead set
  `mesh.first_cell_height_chords` explicitly.
- Lift is sensitive to **domain size** (finite-domain circulation clamping). Larger
  `mesh.farfield_radius_chords` increases accuracy at the cost of cells.
- The solver uses plain SIMPLE with conservative relaxation, 2 non-orthogonal
  correctors and limited Laplacian/snGrad schemes for robustness on the C-grid's
  trailing-edge region, with a `potentialFoam` initialisation.
- Tune `mesh.{n_surface,n_radial,n_wake,farfield_radius_chords}` and
  `solver.n_iterations` for your accuracy/cost trade-off.

## Development & tests

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest -m "not integration"     # fast unit tests, no Docker
pytest -m integration           # real OpenFOAM runs (needs Docker + the image)
```

## License

MIT — see [LICENSE](LICENSE).
