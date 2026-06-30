# Decision History

## 2026-07-01 — Boundary Forms Prefer Domain Presets Over Raw Solver Numbers

- Decision: Turbulent viscosity ratio is presented as `Turbulent viscosity
  ratio νt/ν` with practical presets, while the exact raw numeric value remains
  available in an advanced disclosure.
- Why: The previous `Viscosity ratio` label exposed a solver parameter without
  its physical meaning or a reasonable default choice for 2D airfoil work.
- Expected effect: New boundary profiles steer users toward intentional,
  documented freestream turbulence choices while retaining precise control for
  expert cases and imported legacy values.

## 2026-07-01 — Setup Editors Hide Single-Option Engine Choices

- Decision: CFD setup editors expose enumerated engine choices as typed selects,
  and hide them entirely when only one supported option exists. Raw engine tokens
  such as `blockmesh-cgrid` are not editable free text in the primary form.
- Decision: Mesh information shown on solved AoA evidence is evidence-derived:
  actual cell count comes from solver output, while profile controls such as
  farfield/wake chords and surface/radial/wake cell targets come from the
  immutable setup revision. Missing mesh counters stay blank rather than being
  estimated from profile knobs.
- Why: The Mesh form exposed the single supported mesher as a text input and
  showed several numerical mesh knobs without making clear which values had
  actually been used by local OpenFOAM runs or where solved-case mesh metrics
  would appear.
- Expected effect: Admin setup stays compact and purpose-built, while result
  dialogs can show real per-AoA mesh evidence such as cell count, y+, iteration
  count, and residual when the solver has produced it.

## 2026-06-29 — Keep Solver Queue UI Polling Bounded

- Decision: Admin queue refreshes must not overlap, and slow engine
  observability probes should use short cache/stale-while-refresh behavior
  instead of blocking every queue paint.
- Decision: Unsupported engine observability endpoints are treated as a
  capability state and skipped for a cooldown window rather than retried on
  every poll.
- Why: The queue page was waiting several seconds for a monolithic
  `/api/admin/queue` payload while OpenFOAM workers were saturated, and the
  frontend polled every four seconds without guarding against in-flight
  requests.
- Expected effect: The queue page stays responsive during long all-profile
  sweeps and does not create avoidable API or engine log pressure while workers
  are busy.

## 2026-06-29 — Separate Long-Run Launch Tests From Passive Monitors

- Decision: The all-profile OpenFOAM Playwright launch spec remains responsible
  for creating/verifying the setup and starting the sweep, but detached
  long-lived monitoring uses a separate observe-only Playwright spec.
- Decision: The monitor records API queue progress, screenshots, and one-time
  stale recovery if needed. It does not change preset scope, create records,
  requeue failed solver evidence, or start duplicate sweeps.
- Why: The previous detached monitor was a launch E2E test running for days. If
  it exits or is restarted, using the same spec risks mutating the live run
  instead of merely observing it.
- Expected effect: The monitor can be restarted safely when screen or
  Playwright exits, while the existing solver queue continues untouched.

## 2026-06-29 — Reconcile Queue Lifecycle Across DB, Celery, And Engine Files

- Decision: Treat DB job state, Celery task visibility, engine status/result
  files, and worker runtime heartbeat as separate lifecycle signals. Do not
  declare a job stale solely because Celery inspect no longer lists it.
- Decision: Engine job files are written atomically and read through tolerant
  runtime probes. Completed result files are ingested even when the status file
  is unreadable or a duplicate/redelivered Celery task returned early.
- Decision: The worker writes a shared `runtime.json` heartbeat while a job is
  executing, because the API container cannot inspect OpenFOAM child processes
  inside the worker container directly.
- Decision: Admin stale recovery requeues only true orphaned running work. Jobs
  with a fresh heartbeat are kept running; jobs with readable completed results
  are moved back to ingestion; failed solver evidence is not automatically
  requeued by stale-job recovery.
- Why: The user observed a paused-looking admin queue while workers were still
  consuming CPU, plus running DB rows marked stale after Celery task state and
  OpenFOAM execution state diverged.
- Expected effect: The queue page can distinguish worker-visible, detached but
  alive, result-ready, missing-grace, orphaned, and corrupt-file states, and
  recovery actions preserve real solver evidence.

## 2026-06-29 — Separate Solver Evidence, Provisional RANS, And Fitted Polar Cache

- Decision: Store raw OpenFOAM evidence separately from polar usability state.
  Classify evidence as `accepted`, `needs_urans`, `superseded_by_urans`, or
  `rejected`.
- Decision: Suspicious post-stall RANS remains provisional as `needs_urans`
  until URANS evidence for the same AoA exists. Accepted URANS supersedes the
  matching RANS row for final polar metrics.
- Decision: Classify RANS attempts within the solver job/sweep that produced
  them. Canonical result rows may be classified across the immutable setup
  revision, but attempt rows from unrelated jobs must not influence each other.
- Decision: Browse, Search, and Detail summary metrics read cached fitted polar
  data keyed by airfoil + simulation preset revision + evidence signature. Raw
  evidence scans are reserved for cache rebuild and evidence/detail views.
- Why: The user observed physically suspicious post-stall RANS points appearing
  as final valid polar data, while URANS confirmation was missing. Keeping
  provisional evidence visible preserves traceability without pretending it is
  final, and cached fits prevent slow page navigation over thousands of
  airfoils and result rows.
- Expected effect: Detail can show measured points plus a dashed best-fit curve,
  with provisional RANS styled separately. Browse/Search no longer invent or
  recompute aerodynamic rankings from raw rows at render time.

## 2026-06-29 — URANS Early Stop Requires Two Stable Periods With Real Frames

- Decision: URANS may finish before its initially requested `endTime` only when
  the final two measured shedding periods are phase-repeatable and each period
  has at least 20 saved field frames.
- Decision: The stop rule is evidence-driven from `coefficient.dat` plus actual
  OpenFOAM time directories. It does not infer quality from elapsed wall time,
  guessed Strouhal, or configured target duration.
- Decision: While `pimpleFoam` runs, the worker may update runtime-modifiable
  `controlDict` values to increase field-write cadence and request a graceful
  stop. Postprocessing then averages exactly the retained integer-period window.
- Why: The user observed URANS cases effectively running until timeout despite
  already containing enough stable periodic behavior. Two repeatable periods
  are sufficient when they are well-resolved in saved media.
- Expected effect: Slow URANS fallback points can finish as soon as they contain
  enough real, repeatable evidence, while sparse or drifting histories keep
  running or fail normally.

## 2026-06-30 — Queue Phases And Worker Telemetry Are The Queue Truth

- Decision: Engine jobs expose explicit phases: waiting for CPU, meshing,
  solving RANS, solving URANS, postprocessing, ingesting, completed, failed, and
  cancelled. `running` alone is no longer treated as a meaningful user-facing
  solver state.
- Decision: The worker writes runtime telemetry from inside the OpenFOAM
  container: active child PIDs, commands, case path, AoA, solver mode, CPU-token
  wait/held counts, phase start, and last progress time. The API forwards that
  telemetry instead of inferring process state from outside the worker
  container.
- Decision: Admin Queue displays build/version parity between the web/API
  expectation and the running engine package. A stale Python image is a queue
  health problem, not a hidden deployment detail.
- Decision: Sweeper reconciliation cancels redelivered engine tasks whose DB
  job rows are already terminal, while preserving solved/failed evidence and
  avoiding duplicate execution. Completed result files are eligible for
  ingestion even if Celery inspect no longer sees the original task.
- Why: Jobs were shown as long-running RANS with zero process truth while they
  could actually be waiting, executing helper commands, running URANS fallback,
  or consuming CPU in a stale worker image. Celery redeliveries also kept old
  terminal jobs alive in the engine queue.
- Expected effect: The queue page remains fast and truthful under the
  all-profile sweep: users see the actual phase and active solver/processes,
  obsolete redeliveries are drained, and deployment mismatches are visible
  before they distort queue diagnostics.

## 2026-06-30 — Monitor CFD Progress By Step Budgets, Not Status Flags

- Decision: The all-profile sweep monitor tracks real progress: solved/failed
  evidence counts, pending backlog, active job identity, completed case counts,
  phase, active AoA/case, solver process, and last progress timestamp.
- Decision: Stale detection in the monitor is based on step duration budgets.
  A 2D RANS case that exceeds its wall-clock budget is treated as a defect even
  if the worker is still marked `running` and still has a visible process.
- Decision: Steady RANS now has its own short wall-clock timeout
  (`AIRFOILFOAM_RANS_SOLVER_TIMEOUT`, default `1200s`) while URANS keeps the
  longer global guard timeout and stable-period early-stop logic.
- Why: A live A18SM case spent more than 30 minutes on one steady 2D
  `simpleFoam` AoA because the long-run solver profile allowed 3000 SIMPLE
  iterations and the engine used the 7200s global timeout for RANS. Status and
  process visibility were truthful but not sufficient to guarantee progress.
- Expected effect: Monitors fail with exact airfoil/phase/AoA/elapsed evidence
  before a worker burns hours on one 2D point, and future RANS jobs store the
  non-converged attempt and continue the sweep instead of waiting for the URANS
  timeout guard.

## 2026-06-30 — Steady RANS Has A Worker-Side Iteration Budget

- Decision: Large-sweep steady RANS uses `AIRFOILFOAM_RANS_MAX_ITERATIONS`
  (default `600`) as a worker-side SIMPLE iteration cap, independent of the
  reusable solver profile iteration setting.
- Decision: The cap applies only to steady RANS attempts. URANS replacement,
  URANS quality checks, and stable-period postprocessing keep their separate
  timing and evidence rules.
- Why: Live all-profile jobs showed real `simpleFoam` processes consuming cores
  for many minutes on the first `-15 deg` endpoint cases because the long-run
  profile allowed 3000 SIMPLE iterations and warm-start continuation could
  extend the same case to 6000 iterations. The monitor can detect this, but the
  worker must also enforce a practical 2D RANS step budget.
- Expected effect: Bad or slow RANS points become stored non-converged evidence
  quickly enough for the sweep to continue and for URANS promotion or retry
  logic to take over where needed.

## 2026-06-30 — Long Solver Jobs Publish Partial Evidence

- Decision: A running engine job writes a partial `result.json` whenever a
  case outcome becomes available. The partial result stays in `running` state
  and may contain accepted points, attempts, or both.
- Decision: Sweeper reconciliation ingests running partial results
  idempotently when completed case progress advances, without marking the
  `sim_jobs` row done or submitting follow-up URANS work until the engine job is
  terminal.
- Why: The all-profile sweep had many active jobs with 17-21 completed AoA
  cases and live `pimpleFoam` processes, but zero new DB solved rows for more
  than eight hours because the engine buffered all evidence in memory until an
  entire 36-AoA URANS fallback sweep finished.
- Expected effect: Browse, Detail, Search, and queue counters can see newly
  solved evidence shortly after each AoA finishes, while long warm-start sweeps
  still keep their single job identity and final terminal ingestion semantics.

## 2026-06-30 — Raw OpenFOAM Evidence And Stored Field Media Are Authoritative

- Decision: Solver finalization archives the OpenFOAM case evidence as
  immutable content-addressed artifacts before accepting a result. The evidence
  manifest covers mesh/polyMesh, dictionaries, logs, force coefficients, y+
  output when present, selected time directories, and VTU/VTK field exports.
- Decision: Default media is produced during finalization and stored in
  `result_media` for every supported field whose raw evidence exists. RANS
  stores field stills; URANS stores instantaneous, mean, and video media when
  the retained integer-period window supports those roles.
- Decision: Opening the solver dialog reads stored media only. Changing AoA
  swaps to another stored result. Custom renders are explicit user actions and
  are cached by evidence signature plus typed render parameters in
  `field_render_cache`.
- Decision: Missing source fields are recorded as unavailable evidence metadata
  and never replaced with fake images, videos, or controls.
- Why: The user needs raw OpenFOAM output to remain the ground truth so future
  viewers can regenerate images with different parameters, while normal UI
  viewing must be fast and must not trigger expensive implicit rerenders.
- Expected effect: Vorticity, pressure, velocity components, and turbulence
  media become real stored artifacts when evidence exists; downloads and AoA
  navigation operate from persisted evidence/media, and custom rendering is
  reproducible and cacheable.

## 2026-06-30 — Solver Field Dialog Prioritizes Stored Media Over Controls

- Decision: The solver evidence dialog must put the stored OpenFOAM image/video
  first. Custom rendering is a compact disclosure beside the media, and setup
  context such as boundary conditions, flow state, thermodynamics, and
  reference geometry lives below the inspection content behind a details toggle.
- Decision: Render parameters are edited through compact current-value controls
  and targeted sliders/pickers, including an aspect-ratio lock for resolution,
  rather than a full always-visible form.
- Why: The first implementation copied backend render parameters directly into
  the initial viewport, so the user saw an implementation-shaped form and solver
  setup cards before the actual field image they opened the dialog to inspect.
- Expected effect: The dialog opens as a field viewer first. Users can still
  request custom renders and inspect setup provenance, but those secondary
  paths no longer displace the stored evidence image.

## 2026-06-30 — Default Field Media Uses Track-Wide Color Scales

- Decision: Default field renders use one persistent color scale per airfoil,
  simulation preset revision, field, and default render profile. The scale is
  versioned and stored in `field_color_scales`; each result's measured finite
  source-field range is stored in `result_field_extents`.
- Decision: Sequential positive fields start at zero; diverging fields are
  symmetric around zero. The renderer receives explicit `vmin`/`vmax` for
  stills, mean fields, and videos instead of autoscaling each AoA separately.
- Decision: When a new solved AoA expands a field range, ingestion creates a
  new scale version, renders the whole AoA track into staging media, and only
  then publishes the scale/media together. Existing published media remains on
  the previous consistent scale while rebalancing is in progress.
- Decision: Custom renders default to the published track scale but may
  explicitly choose current-image autoscale or a manual range; those choices
  are part of the custom render cache key and do not alter default media.
- Why: Per-image autoscaling made the same velocity or pressure appear with
  different colors when moving the AoA slider, which is visually disorienting
  and scientifically misleading for side-by-side field inspection.
- Expected effect: Moving along the AoA track preserves color meaning for the
  selected field. New extrema are incorporated through an explicit scale
  version, and the UI never mixes published default media from different scale
  versions for the same track.

## 2026-06-30 — Cross-Instance Sync Uses Promises And Conflict Review

- Decision: Unsolved work fetched by another XFoilFOAM instance is represented
  as a sync promise/lease with an expiration, not as solver evidence or a
  solved result row. Non-expired promises suppress local scheduling for the
  promised AoAs; expired, cancelled, or fulfilled promises release or resolve
  those points.
- Decision: Incoming remote data preserves local canonical truth by default.
  Idempotent imports are accepted, while same-identity/different-content
  imports become admin-review conflicts until the user archives the candidate
  or promotes it over the local record.
- Decision: Solved polars pushed by another instance include full immutable
  evidence/media when present. Imported artifacts are content-addressed and
  linked to attempts/results with source-instance provenance.
- Why: The user wants multiple app instances to cooperate on CFD solving and
  database sync without duplicate work or silent overwrites.
- Expected effect: External workers can claim and return real sweeps, local
  queues stay truthful, and cross-instance imports remain auditable.

## 2026-06-30 — Up-Tier Sync And Remote Solvers

- Decision: The Sync API supports two roles. An up-tier instance accepts solver
  registration, promised sweep leases, progress heartbeats, and pushed evidence;
  a local instance can connect outward to that up-tier as a remote solver.
- Decision: Partial sync stores local DB/polar rows plus immutable remote
  evidence/media references. The local API proxies those references when a user
  views media, downloads evidence, or requests a render, so browser clients do
  not receive upstream secrets.
- Decision: Remote-solver mode treats the up-tier catalog/setup/promise as the
  authoritative work definition. A dedicated remote-solver loop in the sweeper
  mirrors the up-tier, claims work, solves locally within a configured CPU
  budget, pushes full results, and fulfills the promise.
- Why: The user needs multiple Airfoils.Pro instances to share data and solver
  capacity without duplicating promised polars, while still supporting light
  local installs that keep heavy evidence/media on an up-tier server.
- Expected effect: Up-tier admins can see registered solvers and their work;
  local admins can configure outbound sync and remote solving; partial local
  installs can display remote-backed fields through local proxy endpoints.

## 2026-06-30 — Admin Access Uses Google OAuth Domain Gating

- Decision: Production admin access can be granted through Google OAuth using
  `ADMIN_GOOGLE_CLIENT_ID`, `ADMIN_GOOGLE_CLIENT_SECRET`, and an allowed domain
  defaulting to `vr.ae`. The API exchanges the OAuth code server-side, fetches
  Google userinfo, requires a verified email, and enforces the domain before
  signing the existing admin session cookie.
- Decision: The password login route remains as an explicit fallback only when
  `ADMIN_PASSWORD` is configured. The browser is told only which providers are
  available and receives no OAuth client secret.
- Why: The deployment should allow everyone from the `vr.ae` Google Workspace
  domain into `/admin` without sharing a single password, while preserving the
  API pre-handler as the actual authorization boundary.
- Expected effect: `/admin` presents a Google sign-in button when OAuth is
  configured, rejects non-`vr.ae` Google accounts even if they reach the
  callback, and continues protecting all admin API routes with the same signed
  session cookie.

## 2026-07-01 — GitHub Actions VPS Deploy Preserves OpenFOAM Workers

- Decision: GitHub Actions deploys Airfoils.Pro to the VPS through SSH and
  rsync, then runs the checked-in `scripts/deploy/vps-redeploy.sh` script on
  the server.
- Decision: The default deploy path builds and restarts only the Node
  control-plane services: `node-api`, `web`, and `sweeper`. It intentionally
  skips the Python engine `api` service and the OpenFOAM `worker` service.
- Decision: The deploy script detects active OpenFOAM child processes inside
  the `worker` container. Solver-service redeploys require the explicit
  `DEPLOY_OPENFOAM_SERVICES=1` opt-in and are refused while OpenFOAM processes
  are active.
- Why: The VPS host does not install OpenFOAM directly; OpenFOAM exists inside
  the `worker` Docker image. Recreating that container during a normal web/API
  deploy would terminate live CFD solves.
- Expected effect: New commits pushed to GitHub automatically refresh the web
  and control-plane API while preserving any running OpenFOAM jobs. Engine or
  worker changes can still be rolled out deliberately during an idle solver
  window.
