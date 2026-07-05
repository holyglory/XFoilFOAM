# XFoilFOAM Working Guardrails

## CFD Domain Model Boundaries

- Do not collapse physical conditions, numerical solver settings, mesh settings,
  scheduling resources, output/rendering options, and result evidence into one
  table just because they are edited in one form or sent in one solver request.
- Before adding schema fields, classify each field as material property,
  physical operating state, boundary/inlet condition, mesh profile,
  solver/numerical profile, execution/scheduling policy, output/media policy,
  sweep definition, or immutable result evidence.
- UI expanders and "advanced" sections are presentation only; they do not imply
  database ownership.
- A table named `boundary_conditions` or `boundary_profiles` must not own mesh
  density, iteration count, CPU policy, AoA sweep definitions, or image output
  settings.
- CFD setup should compose separate reusable records: `mediums` for material
  properties; `flow_conditions` for medium + T/P/speed + derived fluid state
  and Mach; `reference_geometry_profiles` for object dimensions such as chord,
  MAC, span, hydraulic diameter, or reference area; `boundary_profiles` for
  turbulence intensity, viscosity ratio, and roughness/wall inputs;
  `mesh_profiles` for mesher/domain/resolution/y+ targets; `solver_profiles`
  for turbulence model, schemes, tolerances, and RANS/URANS timing;
  `scheduling_profiles` for CPU/concurrency policy; `output_profiles` for
  requested fields/media; `sweep_definitions` for AoA ranges/lists; and
  `simulation_presets`/revisions for composed solver requests.
- Do not put chord, MAC, span, hydraulic diameter, reference area, or any other
  object scale into flow/operating-state records. Reynolds is derived from flow
  state plus reference geometry, so cache it on immutable preset revisions or
  result evidence, not on reusable flow-state records.
- Submitted jobs and solved results must reference an immutable resolved setup
  snapshot/revision so editing a reusable profile affects only future work.
- Reusable setup/profile editors must make record lifecycle explicit. Selecting
  an existing profile to use as a starting point must not make ambiguous "save"
  mutate that canonical record by default. Provide a visible New/create action,
  a primary save-as-new path for selected records, an explicit update-selected
  path for intentional mutation, and a safe remove/archive affordance where the
  record is not referenced by immutable presets, jobs, or evidence.
- Loading a reusable setup/profile row into an editor is not the same as
  selecting it for destructive list operations. Shared update/remove/archive
  actions are allowed only when the profile list has an explicit independent
  selection mode such as checkboxes/radios, a visible selected count, and clear
  selection state. For single-profile removal or archiving, put a labeled
  icon/button on each row so the affected reusable record owns the action.

## Cross-Instance Sync Boundaries

- External sync claims are scheduling leases only. A promised sweep from another
  instance must not create fake solver evidence, fake solved points, or
  canonical result rows until real result/evidence payloads are pushed back.
- Active, non-expired external promises may suppress local scheduling for the
  promised AoAs, but expired/cancelled promises must release those AoAs back to
  normal pending work automatically.
- Remote imports must preserve local canonical truth by default. If an incoming
  airfoil, setup record, medium, polar, evidence artifact, or media artifact has
  the same natural identity as a local record but different content, store it as
  a reviewable sync conflict; do not overwrite local rows without explicit
  admin resolution.
- Full solver evidence and stored media imported from another instance remain
  immutable, content-addressed artifacts. Verify checksums/byte sizes when they
  are supplied and keep provenance that identifies the source instance and
  import operation.
- Sync API settings, permissions, secrets, promises, conflicts, and remote
  provenance are execution/sync metadata. Do not mix them into CFD setup
  profiles, solver evidence rows, or reusable physical-domain records.
- Remote evidence references are allowed only when they are immutable,
  checksummed pointers to another trusted XFoilFOAM instance. A remote media or
  evidence reference must include source instance identity, remote row identity,
  byte size, MIME type, checksum when available, and a proxyable download URL;
  it must never masquerade as locally stored evidence.
- In remote-solver mode, the configured up-tier server is authoritative for the
  catalog, simulation setup, promises, and result identity used by that remote
  work. Local canonical rows may be mirrored for solving, but conflicting local
  truth must not silently change unless the user explicitly chose that sync
  mode and the imported rows are attributable to the up-tier.
- Browser clients must never receive upstream sync secrets. Remote media,
  evidence, and render requests must be proxied by the local API so secrets stay
  server-side and artifact access remains auditable.

## Admin Authentication

- Admin access must be enforced by the API pre-handler that protects admin
  routes. UI sign-in screens are convenience only and must not be treated as
  security boundaries.
- Google OAuth admin access is valid only after the API verifies a real Google
  OAuth callback, confirms the email is verified, and enforces the configured
  allowed domain. A Google `hd` hint in the authorization URL is not sufficient
  authorization by itself.
- OAuth client secrets, upstream sync secrets, and admin session secrets remain
  server-side. Browser clients may receive only provider availability, allowed
  domain display text, and a login URL.
- Password admin login is a fallback/development path only when explicitly
  configured. If OAuth credentials are missing in production, the UI must show a
  misconfigured/unavailable auth state rather than pretending OAuth works.

## UI Concept Implementation Verification

- When ImageGen or any visual concept is used to guide a product UI, preserve
  the concept's hierarchy, scale, and first-viewport intent. Do not compress the
  primary visual artifact into a narrow form column, secondary card, or inline
  helper just because that is the easiest component insertion point.
- Before delivery, capture the affected browser route and compare the rendered
  page against the concept at the same journey point. Verification must check
  visual priority, occupied space, placement, and whether the primary artifact
  appears before low-frequency controls, not only whether labels or text exist.
- Explanatory infographics in admin setup screens belong in the wide context
  panel next to the compact editor, or in a dedicated details surface. Numeric
  inputs and raw engine parameters stay in the editor; the teaching diagram
  must not be buried among form fields.
- If the user explicitly prefers the generated bitmap itself, use that image as
  a project asset instead of recreating it with weaker code-native drawing.
  Overlay only real live values or interactive controls, and mask or remove any
  decorative generated UI chrome that would look like a fake control.
- Infographic assets used behind live setup controls must not bake in dynamic
  values, counts, units, defaults, or placeholder numbers. Generate empty visual
  anchor pads and place real HTML controls over them so form state, focus,
  validation, accessibility, and tests remain owned by the application.
- Generated infographic detail panels and zoom callouts must correspond to a
  real user-facing explanation. Remove decorative callouts that point to the
  wrong place or explain nothing. If repeated detail panels are kept as part of
  the visual concept, fill them with accessible HTML explanatory text or real
  controls; do not leave empty fake inspector pads in the delivered UI.
- If explanatory text is moved out of a generated image, regenerate or edit the
  image to remove the now-empty explanation boxes, callouts, zoom panels, and
  placeholder pads. Keep only anchor pads that will be occupied by real live
  application controls.
- Do not fix an explanatory gap by placing paragraphs over the primary bitmap,
  chart, image, or simulation artifact. Overlays on primary visuals are for live
  controls, small markers, or direct annotations that do not compete with the
  artifact. Longer explanatory copy belongs below or beside the artifact in a
  caption, legend, disclosure, or details panel.
- When overlaying HTML on a responsive bitmap, verify overlay geometry at the
  actual user-facing viewport and at a narrower breakpoint. Percentage
  positions scale with the image, but text, padding, borders, and sliders may
  not; tests must assert that overlay text and borders stay inside the image or
  intentionally move outside it without clipping.

## Production Deployment And OpenFOAM Safety

- Production VPS deployment is done manually over SSH or through GitHub Actions,
  not through the local development coordinator.
- The VPS host does not need host-level OpenFOAM. OpenFOAM is provided by the
  Docker `worker` image/container and its live child processes run inside that
  container.
- Normal production redeploys must update only the Node control-plane services:
  `node-api`, `web`, and `sweeper`. Do not restart or recreate the OpenFOAM
  engine services `api` or `worker` during an ordinary deploy, because that can
  terminate active CFD solves.
- Redeploying `api` or `worker` in production requires an explicit solver
  maintenance action and an idle-worker guard that checks for active
  `simpleFoam`, `pimpleFoam`, meshing, decomposition, reconstruction, or
  related OpenFOAM processes first. If such processes are active, preserve them
  and defer the solver-service redeploy.
- Manual engine rebuilds MUST go through `scripts/deploy/rebuild-engine.sh`
  (never a raw `docker compose up -d --force-recreate api worker`). Build-id
  expectations are baked into container env at recreate time
  (`AIRFOILFOAM_BUILD_ID` for api/worker/sweeper, `ENGINE_EXPECTED_BUILD_ID`
  for node-api), so recreating services before editing `.env.deploy` leaves a
  stale "Engine build mismatch" banner; and a worker recreate kills in-flight
  celery tasks whose persisted engine status keeps reporting `running`
  (zombie jobs). The script edits both env vars first, force-recreates exactly
  the services that read them, verifies the engine `/health` build id, and
  triggers `POST /api/admin/jobs/recover-stale`.

## Solver Evidence Versus Valid Polars

- Treat stored solver evidence and valid polar points as separate concepts.
- Apply the global no-fake rule strictly: no generated placeholder, invented,
  synthesized, reference, sample, or estimated geometry, aerodynamic
  coefficients, polars, rankings, media, status, or action controls may appear
  anywhere in runtime product/API behavior. If OpenFOAM or source geometry
  evidence is missing, show a missing or queued state and keep the relevant
  values null.
- Airfoil geometry must come from imported coordinates, trusted seed coordinate
  files, or an explicit deterministic airfoil definition requested by the user
  and stored with provenance. Never seed or retain random/demo `pw-%` profiles
  or invented shapes as catalog data.
- A completed solver row proves a calculation happened; it does not prove the
  result is physically acceptable for a published polar.
- Final polar curves must include only accepted points: URANS results with
  stored unsteady evidence, or RANS results that converged and were not marked
  stalled. Detail views may also show `needs_urans` RANS evidence as
  provisional points with a distinct visual style and explanation.
- Suspicious post-stall RANS points are `needs_urans`, not invalid, until URANS
  evidence for the same AoA arrives. Once accepted URANS exists, the matching
  RANS evidence becomes `superseded_by_urans` and must be excluded from final
  metrics and final curves.
- Failed, non-converged, stalled, noisy, or otherwise rejected RANS attempts must
  remain stored as evidence/attempt history so they are not silently repeated,
  but they must not be drawn as valid polar curves or used for Browse ranking.
- Tests that touch solver display must assert both sides of the contract:
  rejected evidence is retained, and rejected evidence is excluded from valid
  polar metrics/charts.
- Chart legends, polar tabs, ranking rows, and comparison chips must be created
  only from accepted stored solver points. Do not render configured Reynolds,
  queued sweeps, defaults, or zero-count placeholders as if they were polars;
  scheduled/running work belongs in a separate queue/work panel.
- When a chart/list/table item represents a stored solver evidence row,
  follow-up actions must use the stable evidence id (`resultId`, attempt id, or
  preset revision id) instead of rediscovering the row from rounded display
  values such as Re, Mach, or AoA. Display values are not lookup keys.
- Tests for solved-point interactions must assert that opening/clicking the
  point fetches its stored evidence, including dynamic non-canonical Reynolds
  values from simulation preset revisions.
- In normal Browse/Search/Compare UI, do not add persistent labels explaining
  that values are "solved only", "accepted only", "evidence only", or similar
  pipeline mechanics. Missing or unavailable polar data may be represented by
  null, a dash, an empty chart state, or a concise tooltip/detail panel when the
  user needs evidence context.
- Solver charts must keep axes, labels, points, legends, and hover affordances
  inside their owning component at narrow and desktop widths. SVG/chart overflow
  must be clipped or accommodated by the viewBox; do not rely on visible overflow
  for axis labels.
- Do not show persistent legend semantics such as "post-stall -> URANS" unless
  the displayed data actually contains such points or state. Generic pipeline
  legends create false expectations about unscheduled or unavailable evidence.
- Browse/Search/Compare metrics must be derived from the cached fitted polar for
  the actual solved setup revision, not from ad hoc raw result aggregation. If
  no fit cache exists, aerodynamic metric cells stay empty until the cache is
  rebuilt from stored evidence.
- Fitted polar caches are evidence-derived artifacts. They must include an
  evidence signature/version, mark final versus provisional status, and be
  refreshed after solver ingestion, URANS supersession, imports, migrations, or
  any operation that changes solver evidence.
- Result-attempt classification must be scoped to the solver job/sweep that
  produced the attempts. Do not classify one job's RANS attempts using unrelated
  attempts from a different sweep, even when they share the same airfoil and
  setup revision.
- Catalog pages must be designed for thousands of airfoils and tens of
  thousands of queued/result rows. Avoid per-airfoil correlated solver-metric
  subqueries, and do not ship full coordinate geometry to pages that only need
  ranking/search metadata.
- Admin queue pages must stay usable while solvers are saturated. Do not make a
  frequently-polled queue view wait on one monolithic payload that recomputes
  all backlog details and external engine observability every few seconds.
  Keep queue polling bounded, prevent overlapping browser polls, cache or
  stale-while-refresh slow observability probes, and page or defer large queue
  detail lists.
- Polled admin payload handlers must never await a live engine/observability
  round-trip — EVERY engine-dependent block goes through a TTL cache with
  stale-while-refresh AND a bounded race cap on its cold path (the fresh-cache
  hit must also be capped: returning an in-flight refresh promise reintroduces
  the live wait). Test this class with a slow-endpoint stub (sleep seconds),
  not only a connection-refused stub — refused connections fail fast and hide
  the saturation defect. Stale snapshots ship with their true fetch timestamp
  (asOf/checkedAt); missing data is null plus an error string, never invented.
- Long-running Playwright solver monitors must be observe-only after the sweep
  is launched. Do not reuse setup/launch E2E specs as detached monitors because
  retries can mutate presets, pause/resume the sweeper, or restart scope
  selection. Keep launch verification and passive monitoring as separate
  commands/artifacts.
- Long-running solver monitors must judge liveness from real execution
  progress and step duration, not from a coarse `running`/`stale` status alone.
  Track the current phase, active case/AoA, completed case count, child solver
  process, and last progress timestamp. A 2D meshing or RANS step that exceeds
  its configured reasonable time budget is a defect even when the worker still
  appears alive.
- Long-running solver jobs must publish completed case evidence
  incrementally. A `completed_cases` counter or worker heartbeat is not enough
  user-visible progress; once an AoA has stored coefficients/media/attempt
  evidence, the engine must make a partial running result available and the
  sweeper must ingest it idempotently without marking the whole job complete.
- Monitors must flag the mismatch "completed cases increased but no solver
  evidence rows changed" as a queue/evidence publication defect, not as normal
  CFD slowness.
- Completed OpenFOAM result evidence is the ground truth. Before a result is
  marked complete, archive immutable raw evidence artifacts: mesh/polyMesh,
  dictionaries, logs/stdout/stderr, force coefficients, y+ output when present,
  selected RANS latest time or exact URANS integer-period window, and VTU/VTK
  field exports.
- Result media is a stored artifact, not an on-open side effect. Solver
  finalization must render and persist the default media for every supported
  evidence-backed field. Detail dialogs, Browse/Search/Compare surfaces, and
  downloads must read stored media/artifacts; they must not generate renders
  merely because a user opened a page or dialog.
- Missing OpenFOAM fields must be represented as unavailable evidence metadata.
  Do not synthesize vorticity, turbulence, pressure, or any field image/video
  unless the required raw field data exists.
- Custom field rendering is an explicit user action. Cache custom renders by
  evidence signature plus typed render parameters, and reuse cache hits for all
  future viewers. Never expose custom-render controls that cannot produce and
  persist real artifacts.

## Web Runtime Verification

- Do not run `next build` against the same `.next` directory used by an active
  `next dev` server. Production builds and dev servers must use separate Next
  output directories, or the dev server must be stopped and its cache cleared
  before restart.
- After touching the web app, Next config, package scripts, generated caches, or
  coordinator runtime, verification must include a browser-equivalent request
  to the exact user-facing route class affected by the work, not only `/`, a
  package build, or a shallow health endpoint. For Detail-page work, hit at
  least one real seeded detail URL such as `/airfoils/ag24`.
- After substantive multi-file edits to apps/web, do not rely on HMR for
  browser verification: the Next dev compiler can wedge (requests hang before
  reaching the request logger while /health keeps answering). Restart the web
  server through the coordinator (its start command clears .next) and verify
  the affected route class afterwards.
- A coordinator health check that returns 200 before a route is compiled is not
  enough evidence that a Next dev server is healthy. Check server logs for
  `MODULE_NOT_FOUND`, missing chunk, or cache errors after route verification,
  and treat any such error as a failed delivery until the cache/runtime cause is
  fixed.

## RANS Sweep Abort And URANS Promotion

- Batch polars should be submitted as continuous marched sweeps whenever the
  goal is to build a production polar, so the engine can observe whether the
  attached low-AoA range is physically reliable.
- If a marched RANS sweep produces a failed, non-converged, or rejected RANS
  point anywhere from 0 through 5 degrees AoA, stop the remaining RANS points
  for that polar and switch the whole requested polar to forced URANS.
- The failed RANS attempt must still be stored as attempt evidence, but the
  canonical solved polar for that request should come from the URANS sweep.
- The URANS replacement sweep must reuse the already-built airfoil mesh just
  like the RANS sweep; do not rebuild one mesh per AoA.
- URANS does not have to run until a fixed configured duration or timeout. It
  may stop early only after measured shedding has two phase-repeatable periods
  and each period has at least 20 real saved field frames; postprocessing must
  average exactly that integer-period window.
- Tests for sweep scheduling must assert the early-abort path, full-polar URANS
  promotion, attempt evidence retention, mesh reuse, and the stable-period
  early-stop rule.
