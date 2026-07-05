# Decision History

## 2026-07-05 — Campaign Wizard Numerics Slots Get Inline Quick-Create And Single-Row Defaults

- Decision: The wizard Review step's four numerics slots (Boundary / Mesh /
  Solver / Output) resolve defaults from real rows only: exactly one existing
  profile of any origin auto-selects; with multiple rows exactly one seeded row
  auto-selects; zero rows stay unresolved and render the inline quick-create as
  the only path (no select with one dead option).
- Decision: Each slot carries a quiet "+ new profile" affordance opening a
  save-as-new modal (NumericsQuickCreate) that replicates the Setup library
  editors' full field set and domain conventions — νt/ν presets with the raw
  value behind an advanced disclosure, the live mesh infographic (reused via an
  exported MeshSettingsGuide, never duplicated), URANS knobs behind an advanced
  disclosure, and the stored-image multi-select. Prefill comes from the slot's
  currently selected profile or the Setup editors' exact new-record defaults;
  existing rows are never mutated from the wizard.
- Why: The Review step showed "unresolved — choose" with library-only selects,
  so an admin without a fitting profile had to abandon the wizard (losing
  context) to visit the Setup library, and a library holding exactly one
  non-seeded profile per slot still stayed unresolved even though the
  single-option decision (2026-07-01) established that single-option choices
  need no user decision. Default resolution had been restricted to seeded rows
  only.
- Expected effect: The wizard never dead-ends on the numerics library, defaults
  stay honest (only ever real rows, never invented values), and the setup
  registries keep their save-as-new immutability semantics from inside the
  wizard.

## 2026-07-01 — Simulation Setup Profile Editors Separate Clone, Update, And Remove

- Decision: Selecting an existing flow, reference geometry, boundary, mesh,
  solver, scheduling, output, sweep, or simulation preset loads it as a starting
  point. The primary save action creates a new record from those values; updating
  the selected record is a separate explicit action.
- Decision: Reusable component profiles expose a visible New action beside the
  list and a row-scoped remove icon on each removable profile. Loading a row
  into the editor is not treated as selecting it for deletion.
- Why: The previous UI used one save button for both create and update. A user
  who selected a mesh profile, changed values, and changed the name reasonably
  expected to create a variant, but the old profile was renamed and overwritten.
  The first fix incorrectly added `Remove selected`, which reused the
  editor-loaded row as destructive selection and made it unclear which row would
  be removed.
- Expected effect: Making setup variants is the default, destructive mutation is
  deliberate, and unused profile cleanup is available directly on the row it
  affects.

## 2026-07-01 — Mesh Settings Need A Wide In-Context Infographic

- Decision: Mesh profiles include a wide C-grid infographic in the main context
  panel using the selected ImageGen bitmap, with compact live controls for
  surface, radial, wake, farfield, target y+, and span overlaid on empty visual
  anchor pads. The right editor remains a compact form for name/identity
  fields.
- Decision: ImageGen-guided admin visuals require browser screenshot
  verification against the concept's hierarchy and first-viewport intent before
  delivery.
- Decision: When the user prefers a generated infographic, preserve the bitmap
  as a project asset and overlay only real app values. Do not rebuild the
  artwork as a lower-quality SVG unless the user asks for a deterministic
  vector version.
- Decision: Mesh infographics must contain no baked dynamic values. The bitmap
  provides only visual mesh context and empty anchor pads; React renders the
  actual inputs, current values, and focus-only sliders on top.
- Decision: Generated mesh detail panels remain only when they carry real
  explanatory overlay text. The meaningless circular zoom callout was removed
  because it did not correspond to the indicated mesh region.
- Decision: Explanatory overlays on the responsive bitmap use short copy and
  viewport-aware font/padding sizes, with regression checks for clipping.
- Why: The raw fields are meaningful only in the context of the app's fixed
  chord-aligned C-grid. The first implementation squeezed the generated
  infographic concept into the narrow edit-form column, then a code-native SVG
  replacement still failed to match the generated artwork's quality. The next
  bitmap pass still contained a generated `30,400 cells` value, which made
  mutable form state look like static artwork. The following pass removed the
  fake zoom callout but left lower detail panels with empty pads, so the page
  still looked like it contained unfinished inspector widgets. The first text
  overlay pass then used fixed pixel text inside percentage-positioned boxes;
  at smaller rendered image sizes the text/borders were clipped by the image
  wrapper.
- Expected effect: Mesh setup choices become understandable without requiring
  users to inspect OpenFOAM topology or source code, and future generated UI
  concepts are used or judged by rendered hierarchy instead of text-only checks.
  Dynamic values remain searchable, focusable, validated DOM controls rather
  than pixels inside an image, and every retained detail panel has a visible
  explanation.

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

## 2026-07-01 — Mesh Infographic Explanations Must Not Occlude The Diagram

- Decision: Mesh setup explanations live below the generated C-grid bitmap as a
  compact legend/caption grid. The bitmap itself keeps only live numeric
  controls and direct, small anchors.
- Decision: Generated detail panels that visually support the concept may
  remain in the image, but explanatory paragraphs must not be painted over
  them if that competes with the mesh picture.
- Why: A previous fix verified that overlay text was not clipped, but it missed
  the more important visual-readability defect: the text interfered with the
  primary diagram and made the page worse.
- Expected effect: The mesh picture remains the first readable artifact, while
  users still get parameter explanations in a nearby, accessible surface.

## 2026-07-01 — Mesh Infographic Bitmap Has Only Live-Control Anchor Pads

- Decision: The mesh infographic bitmap was regenerated with a single main
  C-grid diagram and exactly the anchor pads used by live HTML inputs. Empty
  lower detail panels, decorative placeholder blocks, and unused zoom/callout
  chrome were removed from the asset.
- Why: Once explanatory copy moved below the image, the old generated detail
  panels became meaningless empty UI-like boxes. Keeping them made the product
  look unfinished even though the React controls were real.
- Expected effect: The image reads as a clean CFD diagram, and every blank pad
  visible inside the bitmap has a live application control placed over it.

## 2026-07-04 — Simulation Campaigns: Wizard, Set-Valued Plans, Refinement Objectives

- Decision: Batch solving gets a first-class Campaign concept (pure
  execution/work-definition records) with a 4-step wizard (Airfoils →
  Conditions → Angle plan → Review & launch). Full spec in
  `docs/simulation-campaigns-spec.md`; approved mockups (rev 4) in the
  "Simulations UX" artifact. Admin nav regroups to Simulations / Queue /
  Setup library / Catalog / Sync API, with URL search params as the single
  source of truth for section/campaign/wizard state.
- Decision: Campaign conditions and the angle plan are set-valued and editable
  for the campaign's whole life. Conditions = ambient (T,P pairs — never
  independent T×P axes) × speeds × chords, defined in place (library prefill
  only adds); the angle plan = base sweep + refinement objectives (max L/D and
  zero-lift α₀, each with tolerance and round budget). Every post-launch edit
  goes through a previewed, server-re-verified acknowledge dialog with
  optimistic concurrency. The medium locks at launch.
- Decision: Completeness (closure) rule — work solved for at least one campaign
  airfoil is completed for all campaign airfoils even after removal from the
  plan, at per-(condition, angle) granularity for sweeps; released work with no
  evidence is cancelled; no silent resurrection (restore is an explicit
  suggestion); blocked kept work has an audited force-release.
- Decision: Each campaign condition pins an immutable preset revision; extends/
  refinements append plan revisions and reuse solved evidence natively via the
  (airfoil, revision, angle) key. Cross-campaign dedup is anchored by a
  physics-only hash on revisions (globally indexed) plus canonical value keys
  on flow/geometry registries (fixed-precision find-or-create). Campaign-
  created presets/registry rows carry origin provenance and are filtered from
  library lists by default; no ownership columns — linkage lives in
  campaign-conditions joins.
- Decision: One scheduler, one priority scale (gap-fill 0, campaigns 0–9
  default 5, public on-demand 10), one capacity knob — a single global
  "OpenFOAM CPU slots" setting on the Queue page; per-preset scheduling
  profiles leave campaign composition. Campaign jobs carry only their own
  points; refinement iterations are single-angle targeted jobs exempt from the
  tiny-polar whole-URANS heuristic (judged against revision-wide evidence).
  Engine-down triggers health-gated backoff with a truthful banner instead of
  failed-job spam.
- Decision: Refinement objectives are generalized target functions on the
  stored polar fit (max-L/D peak, Cl=0 crossing) computed at 0.01° inside
  buildPolarFit; lanes converge only on accepted evidence within tolerance of
  a stable fit, oscillation terminates as an honest ±window, URANS
  supersession reopens convergence, tolerance edits reopen/close lanes.
- Decision: Symmetric airfoils (a computed, stored geometric property) solve
  only α ≥ 0; negative angles are derived (Cl/Cm negated, Cd equal) at
  read/assembly time, labeled "derived by symmetry" with links to the source
  solve; media renders mirrored from stored +α artifacts with the same label;
  α₀ = 0° by definition; L/D lanes search the positive side only.
- Decision: All progress/ETA surfaces are truth-table and counter backed:
  status lines never read "Active" while the sweeper is disabled or the engine
  is unreachable; projections only from measured trailing ingest rates and
  suppressed while blocked; previews are real dry-run counts with visible
  computing/degrade states.
- Decision: PATCH /api/sweeper and GET /api/sim-jobs move under admin auth as
  part of this work (previously public; campaigns make an open
  pause-the-scheduler endpoint materially more damaging).
- Why: The prior flow required walking nine setup tabs with no launch button,
  no batch grouping, no way to see or refine a batch, and extending a sweep
  minted a new revision that orphaned solved points (the sweep block is inside
  the snapshot signature). User asked for wizard, batch review/refine,
  multi-Re sweeps, and iterative max-L/D refinement; design went through three
  adversarial critique passes plus four rounds of user mockup review.
- Expected effect: One guided launch path; batches with exact reuse on
  refinement; honest operational visibility at 10^5-point scale; refinement
  objectives that are auditable evidence chains rather than claims.

## 2026-07-04 — Campaign detail UI: pinned-revision detail scope (surgical API exception)
- Decision: `GET /api/airfoils/:slug` accepts an optional `revisionId` query
  param (`assembleDetail(slug, { revisionId })`) that scopes the polar payload
  to ONE pinned `simulation_preset_revisions` row, bypassing the
  enabled-preset/air-medium filter, and always emits that revision's Re entry
  (possibly empty) so "no solved points yet" renders honestly. Default
  behaviour (no param) is byte-identical to before.
- Why: The campaign cell side panel (spec §11) must show the stored polar for
  the campaign's pinned revision through the existing PolarViewer; the public
  payload could not previously filter to one revision. The spec authorized
  exactly this minimal exception.
- Expected effect: Campaign evidence views reuse the public detail pipeline
  (incl. derived-by-symmetry marking) with zero duplication; the campaign UI
  never re-implements polar assembly.

## 2026-07-04 — Admin shell integration: URL routing, nav regroup, queue campaign surfaces
- Decision: `/admin` navigation regrouped to five sections (Simulations first +
  default, Queue, Setup library with Mediums folded in as a 10th tab, Catalog
  with Add airfoils/Categories/Hashtags tabs, Sync API) and all admin routing
  state (`?section`, `?campaign`, `?wizard`, `?step`, `?tab`) now reads from
  `useSearchParams` with no mirrored useState — push for section/campaign/
  wizard-enter transitions, replace for step/tab changes. Wizard dirty-exit
  guard runs at the shell level via a new optional `onDirtyChange` wizard prop
  (drafts stay in sessionStorage, so the confirm copy says the draft is kept).
  Queue page renamed to "Queue", polls via the shared hidden-tab-aware
  `usePoll`, and gains the campaign backlog strip, per-job campaign chips,
  the engine-unreachable banner, and a single "OpenFOAM CPU slots" stepper
  (0 = auto) replacing the per-job concurrency stepper (spec §11).
- Why: Spec §11 routing contract (browser back/forward and deep links must
  just work) and §12 honesty rules (no engine branding in nav; queue shows
  real backlog/engine state).
- Expected effect: Deep-linkable admin surfaces; campaign work reachable from
  queue job cards; exactly one global solver-capacity control.

## 2026-07-04 — API integration tests serialized (vitest fileParallelism=false)
- Decision: `apps/api/vitest.config.ts` disables test-file parallelism.
- Why: All four API test files are shared-Postgres integration tests; run in
  parallel they race — observed: the catalog sync-claim test claimed a pending
  sweep created by the concurrently running campaigns test whose preset
  revision was purged before the promise insert (FK 23503 → 500, flaky suite).
- Expected effect: Deterministic API suite; per-file DB assumptions hold.

## 2026-07-04 — Admin routing goes shallow (native history API, no RSC refetch)
- Decision: `AdminConsole.navigate()` now uses `window.history.pushState/
  replaceState` (Next ≥14.1 syncs `useSearchParams` with the native history
  API) instead of `router.push/replace` for all section/tab/step/campaign/
  wizard URL transitions; push mode keeps an explicit `scrollTo(0, 0)`.
- Why: `/admin` is `force-dynamic`, so every router navigation refetched the
  RSC payload and remounted the whole console ~100 ms after the transition,
  wiping form state already typed into the freshly opened panel (surfaced by
  the repaired catalog e2e: the Mediums "Name" field emptied mid-fill; only
  the wizard survived because its draft rehydrates from sessionStorage). All
  admin routing state is client-derived from searchParams — no server data
  changes with the query string, so the round-trip bought nothing.
- Expected effect: No mid-interaction remounts; back/forward still work via
  Next's popstate handling; e2e navigation is deterministic.

## 2026-07-04 — Airfoil symmetry computed at creation time
- Decision: `createAirfoil` (apps/api/src/services/airfoils.ts) computes
  `isSymmetric` + `symmetryCheckedAt` via `isAirfoilSymmetric(geo.contour)`
  at insert time (detection failure records false + null checked-at, never a
  guess). Previously only the one-off backfill script set these columns, so
  every airfoil created after the backfill silently lost campaign symmetry
  planning (spec §9.1). Known remaining gap (reported, not yet closed): the
  sync-import (`apps/api/src/sync-routes.ts upsertAirfoilFromPayload`) and
  remote-solver (`apps/sweeper/src/remote-solver.ts ensureRemoteAirfoil`)
  insert paths still don't compute symmetry.
- Expected effect: New airfoils get real symmetric planning (α ≥ 0 solver
  runs + derived negative points) without manual backfills; covered by
  apps/api/test/purge.test.ts and the campaign wizard e2e.

## 2026-07-04 — Test-artifact purge cascades the campaign family
- Decision: `POST /api/admin/test-artifacts/purge` now removes, for pw-
  prefixed campaigns (matched on slug/name/idempotency key), in FK order:
  results landed at campaign points → campaign sim_jobs → campaigns (FK
  cascades airfoils/plan_revisions/conditions/points/progress/lanes/steps) →
  now-orphaned origin='campaign' presets (same NOT EXISTS reference guards as
  the §6.4 GC, restricted to the pinned preset ids) → their legacy
  boundary_conditions mirrors → campaign-created flow_conditions/
  reference_geometry_profiles nothing references anymore. The mediums delete
  gained a flow_conditions reference guard (previously a surviving flow row
  referencing a pw- medium made the whole purge 500 on FK). Response reports
  per-family purge counts; dry-run reports `sim_campaigns`.
- Why: Campaign e2e suites must leave zero residue on the shared dev DB;
  presets/flow/geometry are shared across campaigns by physics hash /
  canonical key, so blind slug deletes were both incomplete and unsafe.
- Expected effect: One purge call per stamp cleans everything; recall proven
  by apps/api/test/purge.test.ts (launch + plan edit + solved evidence →
  purge → zero-residue assertions across 21 queries).

## 2026-07-04 — Formal UI verification pass: zero criticals on admin surfaces
- Decision: (1) TopBar nav tabs become their own overflow-x scroll container
  at ≤860px (`.topbar-tabs` min-width:0 + overflow-x:auto; brand/actions
  flex-shrink:0) instead of pushing the actions group past the document edge —
  this was the single root cause of the 390px document-horizontal-overflow on
  all four admin routes. (2) The Queue "Pending sweeps" 8-column grid is
  wrapped in the existing `.admin-table-scroll` house pattern with an inner
  `PENDING_TABLE_MIN_WIDTH = 794` (column minimums + gaps + padding), so
  trailing Condition/State columns scroll inside the panel instead of being
  clipped by the panel's overflow:hidden and hit-testing under the adjacent
  panels; the airfoil link gained a `title` for its ellipsis.
- Verifier (formal-web-ui-verification skill) fixes shipped with recall +
  false-positive fixtures in its self_test.py, mirrored to ~/src/holyskills:
  occlusion sampling now honors inner scroll containers as a reachability path
  (scrolls them into view like the window case, clamps sample points to the
  scrollable-ancestor clip box); `visible()` respects `checkVisibility()` so
  closed-`<details>` content (layout boxes kept via content-visibility) is not
  reported occluded; Next.js dev-overlay portals (`nextjs-portal`) are ignored
  as occluders. All previous must-catch fixtures still pass.
- Expected effect: 54 → 0 critical findings across /admin, wizard step 2,
  queue, and Setup library at 390x844 + 1440x900; queue columns reachable on
  mobile (previously fully hidden); no behavior or visual-language changes;
  campaign + catalog e2e (20) stay green with the sweeper disabled.

## 2026-07-04 — No Point-Count Launch Limit; Step-2 Scale Line Honesty

- Decision (user): the 100,000-point campaign launch limit is removed entirely
  (db validation, review gate, wizard warnings). Million-point launches are a
  legitimate use of the instance; the >10k type-to-confirm friction and honest
  scale/backlog lines remain the only guards. The launch transaction is
  set-based and was measured at seven-figure point counts before delivery.
- Decision: wizard step 2 must not multiply by an angle count the user has not
  defined yet. The scale line shows conditions × airfoils until step 3 has
  actually been visited (or the draft came from a duplicate prefill with a real
  plan); the full product appears only after the angle plan is touched.
  Post-launch Edit Conditions always shows the full product (the plan exists).
- Why: the step-2 line silently used the draft's default sweep (31 angles),
  presenting a decision the user never made as fact — an honesty violation of
  the same class the no-fake policy bans; and the point cap was a designed-in
  operational guess that contradicted the user's actual scale of work.

## 2026-07-04 — Engine persistent mesh cache + cross-job solution seeding

- Decision (user, approved execution-efficiency phase): the Python engine gains
  a persistent, content-addressed cross-job cache (`src/airfoilfoam/cache.py`,
  `EngineCache`) with two stores under one root (env `AIRFOILFOAM_CACHE_DIR`,
  default `<data_dir>/cache`; a named `engine_cache` Docker volume in compose):
  - **mesh/**: a built `constant/polyMesh` keyed by sha256 over the normalized
    airfoil contour exactly as meshed + canonical chord + RESOLVED mesh params
    (keyed after y+/speed sizing). `prepare_mesh` copies a hit into the job
    workspace instead of re-running blockMesh and publishes fresh builds.
  - **seed/**: latest-time fields of ACCEPTED steady solves, keyed by mesh key
    + fluid (density, dynamic viscosity) + canonical speed; entries also carry
    a solver signature (turbulence model/intensity/ratio + roughness) so seeds
    only apply where the 0/-file boundary conditions match. A fresh steady case
    with no in-job previous field seeds from the nearest donor within 2.0 deg
    instead of a potentialFoam cold start.
- Seeding deliberately reuses the SAME field-carry mechanism as the in-polar
  warm-start march (`_rewrite_carried_inlet_velocity`, extracted from
  `_solve_warm`): donor fields are staged inside the case, the inlet/outlet U
  values are rewritten for the new angle via foamDictionary, then the staged
  files replace `0/`. Any failure before the swap leaves the case pristine for
  the normal potentialFoam path. Case dictionaries stay CaseBuilder-authored.
- Integrity/ops: atomic publish (tmp stage + rename), per-entry manifest with
  per-file sha256 (verified on every hit; corrupt/partial entries removed),
  size-capped LRU eviction (`AIRFOILFOAM_CACHE_MAX_GB`, default 20) under a
  non-blocking file lock, real hit/miss/evict/publish logging with sizes. The
  cache is an optimisation layer only: every failure degrades to a miss.
- Consistency fix folded in: the case-parallel path now passes the shared
  mesh's RESOLVED params into `run_case` (previously the raw request mesh was
  re-resolved per case speed), so cache keys — and the case dictionaries —
  always describe the mesh geometry actually in use.
- URANS keeps its existing steady-init path (it benefits transitively when the
  steady stage was seeded). Archived openfoam evidence bundles are unaffected.
- Build id bumped to `dev-20260704-batch-cache` (compose defaults,
  `.codex/dev-runtime.json`); worker image rebuild required to pick it up;
  README deploy section documents the volume and rebuild.
- Verified: 105 unit tests pass (88 pre-existing + 17 new in
  `tests/test_cache.py`: key stability/sensitivity, atomic publish, corruption
  removal, LRU cap, 2.0-deg nearest-angle boundary, speed/signature scoping,
  inlet-rewrite direction for the new angle, and fake-solver pipeline proof
  that a second job re-uses the cached mesh with zero blockMesh invocations
  and seeds a nearby angle with zero potentialFoam calls).

## 2026-07-04 — Campaign Jobs Batched Per Airfoil×Chord×Ambient

- Decision (user): campaign work is batched so an airfoil is meshed once and
  the solver marches all speeds×angles over that mesh. One job = (campaign,
  airfoil, chord, compatible physics group, identical open-angle set) × all
  open speeds, capped at 256 cases with reynolds-ordered chunking. Grouping is
  value-based (identical ambient + boundary/mesh/solver/output blocks); one
  chord per job (meshes are per-chord); identical open-angle sets only (one
  angle list per engine request — unioning would re-solve solved points).
- Decision: batched jobs carry a conditionMap in requestPayload; ingest maps
  each returned polar to its pinned revision by exact canonical speed (never
  nearest-guess); URANS wave-2 plans are computed per condition and submitted
  as single-revision targeted children; jobs without a conditionMap keep the
  legacy single-revision path byte-for-byte.
- Bug found en route (pre-existing, in committed HEAD): wave-2 URANS child
  jobs were inserted as pending but the post-submit status stamp was guarded
  by an active-only WHERE clause, so successful child submissions were
  silently no-oped — children sat pending forever with no engineJobId. Fixed
  (pending+active guard) with a must-catch regression test asserting the child
  reaches submitted with an engine job id.
- Constraint recorded: result_attempts' unique index
  (sim_job_id, engine_job_id, aoa_deg, regime) collapses same-angle attempts
  across bundled speeds; per-entry retry evidence is reconstructed from the
  job's own results rows + result-level classifications instead of adding a
  migration. Revisit if per-speed attempt audit rows become necessary.
- Verified: 43/43 sweeper tests (grouping must-catches: different ambients /
  angle sets / chords never share; 256-case chunking; no-nearest-guess ingest)
  plus a live-DB batched flow (one job, correct conditionMap, per-revision
  ingest, one deduped wave-2 child); real-OpenFOAM cache proof logged
  "mesh cache hit" + "seeded … from cached solution at aoa 2" on the second
  job (engine build dev-20260704-batch-cache; api/worker rebuilt idle-guarded).

## 2026-07-05 — Momentum Scheme Is A Two-Value Select, Not Free Text

- Decision: the solver-profile "Momentum scheme" field is a select fed by a
  shared constant (apps/web/components/admin/solver-schemes.ts) in BOTH the
  Setup library editor and the wizard quick-create modal. Engine ground truth
  (src/airfoilfoam/case/builder.py _write_fv_schemes): "upwind" maps to
  "bounded Gauss upwind"; every other string silently maps to
  "bounded Gauss linearUpwind grad(U)" — so free text was a
  silent-wrong-behavior trap (typing "LUST" ran linearUpwind without error).
  Unrecognized stored values render as an honestly-labeled extra option, never
  silently re-mapped by the UI. The automatic 1st-order retry on
  non-convergence (firstOrderFallback evidence flag) is stated next to the
  control in decision language.
- Why: UI enums must mirror the engine-accepted value set exactly (no
  schema-shaped free text); this is a scalar inside solver_profiles, not a
  separate registry — a profile selector for a two-value enum would violate
  the schema-boundary rule against over-normalization.

## 2026-07-05 — First Real Campaign Run: Scale Incidents And Fixes

- Incident: the dev environment never ran the sweeper process (only api/web +
  engine containers were coordinator-managed), so an enabled sweeper flag did
  nothing and the Queue page prescribed "Resume the sweeper" while the
  heartbeat was days stale. Fix: sweeper added to .codex/dev-runtime.json and
  started under the coordinator; Queue UI now derives a distinct
  "PROCESS NOT RUNNING" state from heartbeat staleness (>90 s) with honest
  guidance, separate from paused.
- Incident: campaign reconciler crashed with a JS stack overflow at 1.5M-point
  scale — whole-campaign counter heal enumerated 48,630 (condition, airfoil)
  keys as SQL tuples (~146k bound params). Fix: campaign-scoped set-based
  recompute (recomputeProgressForCampaign); tuple-list path defensively
  chunked at 500.
- Incident: first tick after restart ran 10+ minutes silently — engine API
  latency is seconds under full solver load (13 jobs saturating cores) and a
  dual-objective campaign dirties two refinement lanes per ingested point, so
  the unbounded dirty-lane drain starved job submission and the heartbeat.
  Fix: dirty-lane drain capped at 100/tick with deduped carryover; heartbeat
  beats at tick start, between per-job engine polls, and every 50 lane ticks.
- Consequence recorded: sweeper/campaign test suites require exclusive
  scheduler control and now fail-fast (by design) while a live campaign runs;
  isolation on a scratch DB is queued as follow-up work.

## 2026-07-05 — Degenerate No-Shedding URANS Resolves As Steady, Not A Crash

- Incident (validation-campaign-20260705, airfoils.pro): three campaign points
  failed as `terminal | failed` with `result_classifications.state=rejected` —
  clarky α−2 and sd8020 α0 with `FileExistsError`, naca-0012 α0 with
  `OpenFOAMError "URANS transient produced no coefficient.dat"`. RANS-at-α0 for
  these near-zero-lift cases genuinely did not converge (converged=f, stalled=t,
  valid_for_polar=f), so the URANS escalation was legitimate; the failure was in
  the degenerate URANS-with-no-shedding path.
- Root cause: a symmetric airfoil at α≈0 (or any weakly-loaded point) escalated
  to URANS runs a physically steady transient — no vortex shedding, so the force
  history is flat. `evaluate_urans_quality` only treated `strouhal <= 0` as
  "no shedding"; a flat-but-noisy lift signal can still produce a spurious FFT
  peak (nonzero strouhal), which routed the case into the auto-refine branch.
  Auto-refining a non-shedding case copies a degenerate retained window (start
  time resolving to 0.0 → `FileExistsError`), and the transient produced no
  usable periodic coefficient history to analyze.
- Decision: detect no-shedding from the fluctuation AMPLITUDE (not the presence
  of an FFT bin) BEFORE any refine decision. New `is_no_shedding(history)`
  (postprocess/unsteady.py) fires when `max(cl_rms, cd_rms)` is negligible vs a
  relative-plus-absolute-floor threshold. When it fires, `evaluate_urans_quality`
  returns `ok=True, can_refine=False, no_shedding=True`: the time-averaged
  coefficients over the retained transient window ARE the physical answer
  (evidence-first: a non-shedding URANS is a converged steady case). The point
  is finalized as `converged=True, unsteady=False`, gets steady single-frame
  media, and reports no Strouhal. naca-0012-α0-class points are now recovered as
  real solved steady evidence (cl≈0) instead of failing.
- Honest-failure boundary preserved: no-shedding requires real force data. If
  the coefficient history is genuinely absent (solver truly failed), the case
  still fails cleanly with retained attempt evidence — coefficients are never
  fabricated.
- The prior crash-(a) guard in `_copy_initialized_transient_case` (skip the
  start-dir copy when it equals the already-copied `0` dir) is kept as
  defense-in-depth; the no-shedding branch now prevents reaching auto-refine for
  these cases at all.
- Tests (unit, no real solves): tests/test_no_shedding_urans.py covers the
  detector (flat/periodic/absent), the decision routing through
  evaluate_urans_quality, mean-equals-average of the steady history via
  `_run_transient_attempt`, and the naca-0012-α0 steady recovery through
  `_finalize_outcome`; tests/test_pipeline_refined_copy.py (crash-a) retained.
  Suite: 111 → 119 passing.
- Deploy: engine (worker + api) rebuild REQUIRED — pipeline behavior changed
  (previously-failed near-zero-lift points now solve as steady). Build-id bump
  handled by the orchestrator.

## 2026-07-05 — Queue Endpoint Under Solver Saturation: Scoped + Race-Capped

- Incident (measured on airfoils.pro): authenticated GET /api/admin/queue took
  1.8–3.0 s per call on localhost while 4 OpenFOAM solves saturated the CPU,
  with near-empty data (4 jobs, 18 KB). Root cause verified by reading the
  handler and reproducing with a 3 s sleeping engine stub: the handler awaited
  a LIVE `POST /jobs/runtime` per request (engineRuntimeMap — no cache, no
  cap, and EngineClient has no fetch timeout), and the cached engine probes
  had a latent hole — a fresh-cache hit returned the still-in-flight refresh
  promise, so within-TTL requests also waited on the slow engine. Connection
  refused (engine off) resolves instantly, which is why dev never showed it.
- Fix: one shared `raceCachedProbe` helper (TTL + stale-while-refresh + race
  cap on BOTH the cold path and the fresh-hit-while-resolving path) now backs
  engine health (15 s/750 ms), queue introspection (5 s/750 ms), cache stats
  (30 s/750 ms), and the new per-job runtime snapshot keyed by the engineJobId
  set (5 s/500 ms). Stale runtime annotations ship with `engineRuntimeAsOf`
  (true fetch time) + `engineRuntimeError`; missing data stays null.
  `engineRuntimeMap` (live) remains only for the explicit recover-stale admin
  action.
- Tab-scoped payloads: GET /api/admin/queue?scope=activity|background|engine
  (default `all` for back-compat; invalid → 400). Full AdminQueue shape with
  out-of-scope sections null (web types made nullable; mergeAdminQueue folds
  scoped responses client-side). Only scope=background/all awaits the full
  gap scan (single-flight); activity serves the cached counters with
  computedAt and refreshes the scan in the background — cold cache renders
  "not computed yet", never invented zeros. QueueDashboard polls only the
  active tab's scope; ReviewStep queue context uses scope=activity.
- First-load waterfall: AdminConsole now prefetches the Solver page's scoped
  queue payload in parallel with adminMe (30 s-fresh, consumed once).
- Also fixed in scope: POST /api/admin/login with a missing body 500'd with a
  raw ZodError; now safeParse → 400 {error}.
- Must-catch recall proven: apps/api/test/admin-queue.test.ts drives a 3 s
  sleeping engine stub + seeded active jobs with engine ids; the timing tests
  (cold <1.5 s, warm <1 s) were run against a temporary reintroduction of the
  live-await behavior and failed at 3.1 s as required, then pass post-fix at
  ~0.87 s cold / ~0.05 s cached. Guardrail generalized in AGENTS.md (slow-stub
  testing requirement — refused-connection stubs hide this class).

## 2026-07-05 — Solved-Points Viewer (Solver Page Screen 5)

- New GET /api/admin/solved-points (requireAdmin, apps/api/src/solved-points-
  routes.ts): the newest REAL solved rows (results status=done, source=solved,
  solvedAt set — derived/mirrored display points never listed), keyset-paged
  on (solvedAt DESC, id DESC) with cursor `solvedAtISO|resultId`, optional
  jobId scope, and `solvedToday` computed over the SAME scope as the rows
  (counts always accompany the rows they count). Malformed cursor/limit/jobId
  → 400.
- Web: "N solved today ▾" badge in the Activity truth banner (count comes from
  the queue payload's activity-scoped solvedToday — no extra poll request;
  hidden at 0), and per-job "N solved ▾" chips on active/finished job cards
  (rendered only when solvedCount > 0). Both open SolvedPointsPopover, a
  self-owned popover (fetch-on-open + manual refresh) so the 10 s Activity
  poll can never yank it shut or reset its pages. Row click opens the
  EXISTING SimModal (by resultId via getSim; not forked); α prev/next is the
  modal's own track/onTrackPoint contract fed with the popover's row list,
  plus overlay prev/next buttons that load the next keyset page when stepping
  past the loaded end. Escape closes modal back to popover; outside click
  closes the popover; no page navigation anywhere.
- Pure stepping/merge logic isolated in apps/web/lib/solved-points.ts
  (mergeSolvedPointsPages dedupes on resultId and never re-orders loaded rows,
  keeping the open row's index stable; stepSolvedPoint returns move /
  load-more / none) with unit tests; API behavior pinned by
  apps/api/test/solved-points.test.ts against the shared dev DB (scoped
  assertions own their seeded job; cleanup in afterAll). E2e asserts the badge
  honestly matches the live API count (absent at 0 — never an invented
  number).

## 2026-07-05 — Campaign counter model: one canonical definition (found on first prod campaign)

- Incident: two progress recompute implementations disagreed. The API path
  (campaigns.ts) counted terminal-failed points as SOLVED and looked for failed
  points at state='requested' (always 0, since ingest terminalizes failures);
  failedResultsWhere shared the wrong assumption, so GET /campaigns/:id/failures
  returned {total:0} with 3 real failures and requeue-failed could find nothing.
  Whichever recompute ran last won -> visible counter drift on
  validation-campaign-20260705.
- Decision: ONE canonical counter model, single-sourced in
  campaign-execution.ts and delegated to by campaigns.ts:
  requested = total obligation (state <> 'released'), stable as points
  terminalize (UI denominators depend on this); solved = terminal AND NOT
  derived AND result done; failed = terminal AND result failed; running = open
  point with live queued/running cell result; derived = terminal symmetry cells.
  remaining = requested - solved - derived - failed.
- requeueCampaignFailed flips terminal-failed points BACK to state='requested'
  (plus result -> pending) — without the state flip the sweeper would never
  reschedule them.
- Semantics note (user-confirmed): non-converged RANS escalated to URANS is
  normal operation, never displayed or counted as failure. 'failed' is strictly
  the crash class (solver error / no coefficients). needs_urans displays amber.
- Recall proof: reverting the fix while keeping the new tests reproduces the
  exact production breakage (solved absorbs the failure, failed=0, failures
  endpoint empty, requeue drift error). apps/api/test/campaigns.test.ts
  "counter/failures/requeue coherence".

## 2026-07-05 — Admin evidence links pin the preset revision (prod-reported broken journey)

- Incident (airfoils.pro, ?section=queue Finished job log): clicking a finished
  campaign job's airfoil name/Detail opened the UNPINNED public detail page,
  which is enabled-presets-only by design — campaign presets are disabled, so a
  campaign-only DB rendered zero polar groups (live repro: clarky α=-2 accepted
  in DB, /api/airfoils/clarky → reList:[]). Two adjacent defects: the name link
  looked like a caption (full-row block, no link affordance), and the Finished
  job log <details> open state lived only in the DOM, so browser-back returned
  it collapsed.
- Decision: public detail stays enabled-presets-only (unchanged, by design);
  admin evidence links must pin the setup revision instead. Every admin
  deep-link to /airfoils/<slug> that presents job/result evidence appends
  ?revision=<uuid> (AdminJob.revisionId from the queue payload; NULL → unpinned
  for multi-revision batched jobs, which have no single pinned view; campaign
  cell panel uses condition.revisionId). The page validates the UUID shape,
  fetches the existing pinned scope (routes.ts revisionId "surgical
  exception"), and shows a compact dismissible "Pinned to setup revision" chip
  above the charts. Name links became real-looking links (teal, dotted
  underline, fit-content). Finished-log open state is URL-owned (?flog=1,
  replaceState) per the §11 routing contract.
- Guardrails: apps/api/test/pinned-detail.test.ts (must-catch: pinned
  assembleDetail surfaces disabled-preset accepted evidence + queue payload
  revisionId single/batched mapping — recall value is against REGRESSION of
  the already-working pinned scope and of the new payload plumbing);
  apps/web/test/detail-links.test.ts (href pin contract + flog round-trip);
  apps/web/e2e/solver-finished-log.spec.ts (expand → ?flog=1 → reload stays
  expanded; read-only, safe while solving).
- Recall proof: with product files reverted (helper unpinning stripped, pinned
  scope branch disabled), both unit/API must-catch tests fail; restored → all
  green. The missed-coverage class was "finished job → detail → evidence
  visible on a campaign-only DB"; no test walked that journey before.
- Follow-up (formal UI verification of the pinned-detail delivery): the
  formal-web-ui-verification run on /airfoils/* mobile (390x844) failed with
  criticals. Root causes: (a) pre-existing — DetailIsland's two-column grid was
  a fixed `344px 1fr`, so at 390px the whole chart column rendered off-canvas
  (confirmed identical criticals on the committed baseline via git stash);
  (b) new — the pinned-revision chip's min-content widened the 1fr track and
  added document horizontal overflow (scrollWidth 390→474).
- Decision: the detail grid now stacks (`minmax(0,1fr)` single column) below
  760px via a styled-jsx media query; desktop layout unchanged. The chip got
  flexWrap/maxWidth/minWidth/overflow guards so it can never widen the
  document. After the fix: 0 criticals on unpinned + pinned detail mobile and
  on /admin?section=queue (both viewports).
- Known verifier artifact (not fixed here): 4 desktop "occluded" criticals on
  /airfoils/clarky are the 52px sticky topbar covering chart-type buttons at
  the verifier's scrolled sample position; at scrollY=0 the buttons are fully
  visible and clickable (elementFromPoint hit). Pre-existing, identical on
  baseline; needs a sticky-header-aware occlusion rule in the verifier skill.

## 2026-07-05 — URANS evidence honesty: classifier gate, shipped media, at-ingest verdicts, rejected bucket (D3–D6)

Live prod campaign evidence showed no URANS result had EVER classified
accepted (4/4 done urans rejected), no kind='video' media row had ever been
registered, and a physics-rejected point still booked the campaign "solved".
Locked decisions implemented (Node side only; engine D1/D2 tracked separately):

- D3 (classifier): `results.stalled` stays the AERODYNAMIC post-stall marker
  (ingest sets it true for every unsteady point by construction). The
  classifier's `solver-stalled` reason now fires only for `stalled &&
  !unsteady` (non-converged steady points). Unsteady rows are judged on their
  own gate: converged + force history + VIDEO are hard requirements for
  `accepted` (evidence-first honesty). POLAR_CLASSIFIER_VERSION →
  `rans-stall-v2`. Must-catch core tests use the exact ingest-shaped row
  (stalled:true BECAUSE unsteady:true); reverting the one-line gate makes 4
  tests fail (recall proven).
- Found while proving D3 end-to-end — correlated-subquery bug in
  `packages/db/src/polar-cache.ts`: drizzle renders `${results.id}` inside a
  sql`` fragment as UNQUALIFIED `"id"`, which Postgres scope-resolves to the
  subquery's own table (`fh.result_id = fh.id` — always false; on the attempt
  path `media.result_id = media.result_id` — always true). hasForceHistory/
  hasVideo were permanently false for result rows, so even registered video
  could never be seen. Rule: hand-qualify correlated outer columns in raw sql
  fragments (`"results"."id"`).
- D4 (ingest media): engine-shipped media (`p.images`, `p.mean_images`,
  `p.video`) now register into result_media AT INGEST, before the scaled-render
  round-trip, on the same (result, kind, field, role) upsert key — a
  successful scaled render simply overwrites them with scale-stamped rows.
  computeFieldExtents failures, missing evidence bases, and scaled-render
  failures are LOUD (console.error with job/case/aoa/result addressing; render
  failures also keep recording status='failed' + failureReason on the scale
  row). Must-catch sweeper test: extents/render backend down → 3 shipped rows
  registered, URANS row classifies accepted end-to-end.
- D5 (at-ingest verdicts): both URANS retry submit paths (single-revision and
  batched campaign) no longer re-refresh the polar cache AFTER flipping
  retried rows to queued — the pre-plan refresh IS the stored at-ingest
  verdict; the post-flip refresh had been rewriting classifications into
  synthetic post-requeue "not-solved" snapshots (prod row 741db07a).
- D6 (campaign honesty): new `sim_campaign_progress.rejected` bucket
  (migration 0027) = terminal, non-derived, result done, classification
  'rejected'. `solved` EXCLUDES it; remaining = requested − solved − derived −
  failed − rejected; deriveCampaignCompletion → attention when failed>0 OR
  rejected>0. probeCampaignCompletion gained two blockers closing the
  premature-completion window: (a) a terminal point whose cell-key results row
  is queued/running (wave-2 re-solve in flight), and (b) a terminal done point
  with NO classification yet (awaiting_verdict — the ingest-time probe fires
  before the polar-cache refresh, so a campaign must not book completed on
  unjudged evidence). The sweeper re-settles after each terminal ingest
  (`settleCampaignAfterRefresh`: recomputeProgressForCampaign + probe,
  non-fatal but loud on failure). Rejected counts surface across the campaign
  list/detail/hub/status-line/coverage-matrix ("N rejected", attention copy).
- Known residual: a terminal-done point on evidence that predates the
  classifier and is never refreshed would hold `awaiting_verdict` open until
  its revision's polar cache is refreshed (any ingest for that revision, or
  backfill-polar-cache). Acceptable: every ingest pass refreshes its
  revisions; prod data postdates the classifier.
- Wave-2 retry chain stays bounded (wave ≤ 2; gap finder cannot re-claim done
  rows) — unchanged by design.

## 2026-07-05 — Sign-off: sub-cycle URANS evidence may classify accepted

- When URANS refinement is skipped as wall-clock infeasible (feasibility
  guard), the base transient window is graded honestly: if it ships converged
  coefficients + force history + video it classifies accepted even when the
  retained cycle count is low (e.g. 0.87 cycles for weak shedding). Quality
  warnings are preserved in the evidence manifest and visible in evidence
  views. Chosen over an "accepted-with-reservations" tier (over-engineering at
  this stage); revisit if polar fits degrade on weak-shedding points.
