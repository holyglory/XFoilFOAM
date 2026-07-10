# Decision History

## 2026-07-08 — Auto-retry-once route gap: running-partial ingest + released-cell guard

- LIVE GAP (prod campaign 495d78e0, minutes after stage-2 opened): s1223 −5°
  @ 100 m/s / 1.0 m crashed in its precalc wave-2 child ("transient diverged
  at t=1e-05", divergence watchdog — working as designed) and sat
  status=failed / auto_retried_at NULL / needs_review with no marker and no
  log line. Trace: the watchdog kills only the CASE (tasks.py
  `_condemn_diverged_case`) and the marched engine path ships the failed
  point in the RUNNING partial result immediately (jobs.py `record_outcome`
  → `write_partial_result_locked`, `bump()` counts failed cases too), so the
  point terminalized through `ingestRunningPartialJob` — the ONE ingest
  route that can terminalize a point as failed without the amendment-B hook.
  All terminal routes (ingestCompletedJob, every ingestFailedEngineJob
  branch) already called `autoRetryFailedPointsForJob`; the retry would only
  have fired when the whole child finally went terminal, many minutes later.
- Fix 1 (apps/sweeper/src/reconcile.ts, ingestRunningPartialJob): run the
  one-shot requeue after the partial-path polar-cache refresh too (same
  refresh-before-flip ordering as the terminal paths — at-ingest
  classification preserved, prod row 741db07a).
- Fix 2 (apps/sweeper/src/ingest.ts, RELEASED-CELL GUARD +
  `RELEASED_CELL_MARKER`): an incoming FAILED point never re-terminalizes a
  cell its job no longer owns (row pending/queued/running under a
  different/NULL sim_job). Required for exactly-once semantics: the same
  job's later partial/terminal ingests re-ship the identical failed case,
  and the natural-key upsert used to re-fail the released row — re-claiming
  ownership and letting the terminal auto-retry pass falsely ESCALATE the
  cell to needs_review (one crash consumed both the retry and the
  escalation). Also fixes the same false escalation on
  recoverFailedEngineJobs ingest replays. Failure evidence still lands as an
  attempt row (artifacts isolated resultId:NULL, replace-guard style);
  done-point upserts and rows still owned by the ingesting job are
  unchanged; worker-restart orphan release (solvedPointsOnly) and manual
  requeue paths untouched.
- MUST-CATCH suite (apps/sweeper/test/auto-retry-partial.test.ts, driven
  through the production reconcile() surface): (1) precalc wave-2 child's
  diverged point in a RUNNING partial → retried immediately (marker +
  requested + loud log + gap-finder re-pick); (2) same job's terminal failed
  re-ship → released cell untouched, no false escalation, sibling claimed
  rows get their own first retry; (3) second crash through the same path →
  escalates, needs_review counts it; (4) batched-partial: one crashed point
  inside an otherwise-COMPLETED campaign job → retried (regression pin).
  Verified: sweeper 136/136, api 108/108, sweeper typecheck clean.

## 2026-07-07 — Fidelity-ladder final adversarial review: starvation fix + deferred design notes

- CONFIRMED fix — tier-2a gated-retry scan-window starvation
  (apps/sweeper/src/urans-ladder.ts): parents with EMPTY retry plans never
  grow a wave-2 child, so they never left the NOT-EXISTS SQL filter; they
  were skipped only via the in-memory settled set, which did not shrink the
  finishedAt-ASC LIMIT window. With more no-retry parents than the window
  (the common healthy majority — needy parents finish last because the gate
  stays closed until the final RANS gap), parents past the window were never
  fetched → needs_urans cells never re-solved → phase stuck
  `running_precalc` forever, restart re-blocked identically. Fix: settled
  parents are now ALSO excluded in SQL (`NOT IN`), so the window slides
  forward every tick (bounded progress ≥3 parents/tick; restart re-settles
  from the front and still advances). MUST-CATCH added
  (urans-ladder.test.ts "scan-window starvation": 13 no-retry parents ahead
  of one needy parent); recall proven by running it against the pre-fix
  code (fails: no child after 10 ticks) and the fixed code (passes).
- CONFIRMED fix — campaign detail page scrolled horizontally
  (formal-ui critical, desktop + mobile): the condition-strip wrapper in
  CampaignDetail.tsx is a grid item whose automatic minimum size was the
  strip's min-content (~6.7k px on the paused 1.5M-point campaign), which
  inflated the grid track and defeated the strip's own overflowX:auto.
  Fix: `minWidth: 0` on the wrapper; verifier re-run = 0 criticals.
- PLAUSIBLE, deferred by design (documented, not silently accepted):
  - `OSCILLATING_AMPLITUDE_REL_MAX = 2.0` certifies a ±100%-of-scale ripple
    as "steady with a ripple" and suppresses automatic URANS escalation.
    Deferred: the acceptance ships the full steady_history + an explicit
    amplitude note (±a Cl, ±b Cd) as evidence, the classifier only waives
    not-converged/solver-stalled when `mean_stable === true`, and an admin
    can request-URANS any such cell. Tightening the bound is a physics
    policy change (would reject mid-campaign points already certified under
    R1) and needs user sign-off — flagged as an open decision.
  - Verify-disagreement thresholds are ABSOLUTE only (|ΔCl|>0.05,
    |ΔCd|>0.01, pinned contract 4). Near zero-lift a 0.049 ΔCl (~250 %
    relative, enough to shift α₀ visibly) still counts "agreed". Deferred:
    contract-pinned; a relative-or-absolute hybrid is a contract amendment,
    not a bug fix. Flagged as design risk for the α₀-objective lanes.
  - Verify tier can be delayed indefinitely while the continuous catalog
    sweep keeps submitting (ladder tick only runs on RANS-idle ticks).
    Deferred: intentional rank ordering (verify is the GLOBAL lowest tier);
    bounded by the finite catalog.
  - Cosmetic: a no-shedding precalc attempt classifies at regime `rans`, so
    `supersedePrecalcWithVerifiedUrans` (requires rc.regime='urans') never
    marks it `superseded_by_urans` after verification. Display-only
    (attempt-history chip); the results row itself is the verified solve.
  - Minor request-URANS notes: the insert race-retry recursion is unbounded
    in theory (each pass either inserts or finds — terminates in practice);
    `aoaDeg` is not validated against the revision's angle grid (admin can
    mint an off-grid cell); an engine-rejected request is cancelled with a
    log line and surfaces only via GET state. All admin-only surfaces.

## 2026-07-07 — URANS Fidelity Ladder: web surfaces (task #30, web side)

- ONE chip rule for every classification surface (`fidelityChipView` in
  apps/web/lib/point-history.ts, pure + pinned by
  test/fidelity-ladder.test.ts): plain for `rans`/pre-ladder/drifted values
  (never guessed), amber `precalc · verify pending` while an open verify item
  covers the cell, teal `verified` for `urans_full`, red
  `verify disagreed (Δcl 0.06)` with the REAL stored deltas — the disagreed
  state always outranks the fidelity label. Rendered in Points-tab rows,
  story header, campaign cell panel, and the solver-results modal header.
- Verify truth comes from the verify QUEUE, not inferred from fidelity: the
  point-history read model (packages/db/src/point-history.ts) and the sim
  detail (apps/api/src/services/sim.ts) join the LATEST
  sim_urans_verify_queue item per cell+angle ("latest decides" — a
  re-verified cell stops reading disagreed; API-pinned in
  apps/api/test/point-history.test.ts).
- Points tab filters: `pverify=pending|disagreed` URL param (same replace
  semantics as the other p* params); the derived-mirror arm is excluded under
  a verify filter (mirrors are never verified in their own right).
- Request-URANS (contract 6) wired on three surfaces: story panel
  (single point, idempotent-aware buttons fed by GET /api/admin/urans-requests
  — an open item disables the button and names its state), Points-tab row
  overflow menu (POST response `created` flag is the honest replay signal),
  and the campaign cell panel (whole polar, aoaDeg omitted). Confirm copy
  states the engine-derived budget (3 periods/1 h/half mesh vs 7 periods/6 h)
  but the request carries only the fidelity literal.
- Campaign phase display (contract 7): `campaignPhaseBadge` renders
  RUNNING RANS / RUNNING PRECALC URANS / RUNNING URANS REFINEMENT from the
  summary payload's derived phase; the liveness-split gate badge OUTRANKS the
  phase (a blocked campaign never shows a running phase), and a `completed`
  phase is suppressed once the lifecycle chip already says COMPLETED.
  Per-tier open counts render via `tierCountsLine` in the header strip; older
  payloads without tierCounts render nothing (no invented zeros).
- Solver-results modal: oscillating-steady points draw the REAL recorded
  Cl/Cd/Cm(iteration) samples (lib/steady-history.ts model; strict-parsed
  server-side — a drifted steady_history payload resolves to null and the
  modal renders nothing new) with the averaging window shaded and the
  "averaged over the last N iterations" note + engine note verbatim.
- E2E for the ladder surfaces intentionally deferred: deterministic coverage
  needs live verify-queue/disagreed rows, which the dev seed does not carry
  yet; the pure rules are unit-pinned and the SQL/API paths are pinned by the
  DB-backed api suite instead.

## 2026-07-07 — URANS Fidelity Ladder: node data + scheduler (task #30, node side)

- Migration `0034_urans_fidelity_ladder` (dev :5544 applied; verified backup
  taken first): `results.fidelity` text (backfill: urans ⇒ `urans_full`,
  rans ⇒ `rans`, unsolved stays NULL), `results.steady_history` jsonb
  (attempts need no column — `evidence_payload` persists the whole engine
  PolarPoint), `sim_urans_verify_queue` (pinned contract 4 column set,
  partial-unique open-item-per-cell), `sim_urans_requests` (admin work items,
  expression-unique per (cell, fidelity) with `COALESCE(aoa_deg,'NaN')` so
  whole-polar requests are idempotent too).
- Contract pins mirrored node-side in `@aerodb/engine-client/fidelity.ts`
  (same pattern as frame-track): fidelity literals, engine-derived values
  (3/7 periods, 3600/21600 s, mesh scale 0.5) as parity constants only —
  requests carry ONLY the literal; strict `parseSteadyHistory` (exact keys,
  ≤2000 samples) + fixture pin tests
  (`apps/sweeper/test/fidelity-contract-pin.test.ts`,
  `fixtures/steady-history-contract.json`). Verify disagreement bounds pinned
  as `URANS_VERIFY_DELTA_CL_LIMIT`/`_CD_LIMIT` (0.05 / 0.01).
- Classifier bumped to `fidelity-ladder-v4` (packages/core/polar-fit.ts):
  frame-track period bar is fidelity-aware (`urans_precalc` ≥ 3,
  full/legacy/unknown ≥ 5, fail-closed on unknown strings), and
  oscillating-steady rows accept as RANS evidence iff
  `steady_history.mean_stable === true` (waives ONLY not-converged /
  solver-stalled; reasons stay rejection-only — the honest note surfaces via
  the `steady-oscillating-mean:` quality-warning marker appended at ingest,
  which the existing point-story UI already reads).
- R2 whole-polar kill: `decideRansRetry` is TARGETED-ONLY (job's own
  rejected/needs_urans angles; `whole-polar-urans` mode, `fullUrans`, the
  tiny-polar `<5 valid` and 0..5° revision heuristics all removed, including
  the dead legacy copies in packages/db/polar-cache.ts). Whole-polar URANS is
  now exclusively an admin request (`aoa_deg NULL`). Must-catch tests pin the
  old promotion inputs producing targeted plans
  (campaign-scheduling.test.ts, sweeper.test.ts).
- Scheduler ladder (ONE priority scale): RANS branch (`submitOneBatch`)
  always wins the tick; `uransLadderTick` (apps/sweeper/src/urans-ladder.ts)
  runs only when it submitted nothing and capacity remains — tier 2 = gated
  campaign wave-2 retries + admin requests, tier 3 = verify queue only when
  no campaign RANS/precalc work exists machine-wide (stale claims of
  paused/cancelled campaigns deliberately do NOT starve the verify tier).
  "Open RANS gap" = the gap-finder definition (schedulable cells) plus
  in-flight wave-1 claims — a cell parked queued for its wave-2 child is
  URANS work, not a RANS gap (otherwise the gate would deadlock the very
  retry that resolves it). Wave-2 retries run at `precalc` fidelity;
  `submitUransRetryForJob` defers when its campaign still has open RANS gaps
  and the ladder tick re-attempts (in-memory settled-parent set; restart
  rescans).
- Verify queue lifecycle: precalc-ACCEPTED rows enqueue idempotently after
  every classification refresh; consuming stashes the precalc cl/cd/cm in the
  verify job payload (the results row is overwritten in place by the
  full-fidelity ingest — same natural key); settle computes deltas, flips
  done/disagreed, and on disagreement appends a `urans-verify-disagreement:`
  quality marker to the VERIFIED row (classification stays on it; nothing
  silently swapped). Ladder jobs never claim-flip done rows: a failed verify
  or admin re-solve must not destroy previously good evidence.
- Campaign phases (contract 7, derived — no stored enum):
  `campaignOpenTierCounts` + `deriveCampaignPhase` feed
  `campaignSummary.tierCounts`/`phase`; completion now flips only when all
  three tiers are terminal (probeCampaignCompletion gains `precalc_open`
  (needs_urans cells) + `verify_open` guards; `refreshCampaignCompletion`
  holds `active` while tiers are open). NOTE: needs_urans cells previously
  allowed `completed` — they now hold the campaign in `running_precalc`
  until the URANS verdict supersedes or rejects them.
- Admin request-URANS: `POST /api/admin/urans-requests`
  {airfoilId, revisionId, aoaDeg?, fidelity} (requireAdmin, idempotent
  replay returns the open item, created=false) + cell-scope GET returning
  open requests and verify items for the Points tab / cell panel.
- Suites green: core 82, api 77, web 152 (untouched), sweeper 107;
  `pnpm typecheck` clean; migration applied + schema pinned by
  apps/sweeper/test/urans-ladder.test.ts.

## 2026-07-07 — Engine Fidelity Tiers (precalc/full URANS) + Oscillating-Steady Averaging (task #30, engine side)

- Contract (pinned cross-runtime, same pattern as frame_track; node mirrors in
  build-request + engine-client parser + own pin tests):
  - `solver.urans_fidelity`: `"precalc" | "full"` (default full).
    precalc ⇒ urans_min_periods 3, transient solver budget 3600 s, derived
    half-resolution URANS mesh (n_surface/n_radial/n_wake halved, SAME y+
    target and domain extents); full ⇒ 7 periods, 21600 s (6 h), full mesh.
    Echoed on `PolarPoint.fidelity`: `"rans" | "urans_precalc" | "urans_full"`.
  - `PolarPoint.steady_history` (nullable): `{iterations, cl, cd, cm,
    window{start_iter, end_iter}, mean_stable, note}`, ≤ 2000 samples
    (`STEADY_HISTORY_MAX_SAMPLES`), shipped whenever the steady solve used
    oscillating-averaging OR failed to stabilise (analysis evidence on the
    escalation path); null for classic pointwise convergence.
- Decision — tier ownership: the fidelity tier owns the URANS period target
  and wall budget (`apply_urans_fidelity` / `urans_budget_seconds` in
  models.py, applied at the `_finalize_outcome` → `_run_transient` boundary),
  so the transient stage no longer inherits `settings.solver_timeout`
  (full-tier transients now get 21600 s, not 7200 s). Steady stages keep the
  existing `rans_solver_timeout` cap; media budgets stay derived from
  `settings.solver_timeout`.
- Decision — precalc mesh derivation is param-level (`derive_precalc_mesh_
  params` + `effective_mesh_params` in models.py): the mesh cache keys on the
  resolved MeshParams, so the derived half mesh caches under its OWN key with
  zero cache-schema changes. Applied in jobs.execute_job (job mesh for
  force_transient+precalc requests) and in run_case when it builds its own
  mesh; a passed-in `mesh_dir` is trusted (the caller derived before
  building), which keeps steady warm-starting of the transient valid (same
  shared mesh).
- Decision — oscillating-steady averaging (R1): a steady solve failing BOTH
  residual convergence and the force plateau is accepted when the last N
  iterations (`solver.steady_oscillation_window`, default 400) show a bounded
  oscillation: half-window means agree within rel tol 0.02 for Cl AND Cd
  (scale = max(|mean|, 0.05)), window peak-to-peak ≤ 2.0× scale, and
  second-half peak-to-peak ≤ 1.3× first-half (+1e-4·scale noise floor).
  Accepted ⇒ window-averaged cl/cd/cm, converged=true, quality note
  "converged (oscillating steady, averaged over last N iterations;
  amplitude ±a Cl, ±b Cd)", steady_history shipped (mean_stable=true), NO
  URANS escalation. Not accepted ⇒ existing not-converged escalation path
  with steady_history STILL shipped (mean_stable=false + reason). Detector in
  postprocess/forces.py (`analyze_steady_oscillation`); force_transient
  jobs never run it (their steady stage is init-only, never a result).
- Decision — fidelity echo reflects the solver that PRODUCED the values: a
  no-shedding URANS run reported as a steady-equivalent point still echoes
  `urans_<tier>` (its mean came from the transient), plain steady points echo
  `rans`.
- Tests: tests/test_fidelity_tiers.py (tier/echo/mesh-derivation/cache-key
  pins + budget/period wiring through `_finalize_outcome` + execute_job-level
  derived-mesh build proof) and tests/test_oscillating_steady.py
  (steady_history shape pin; realistic decay-into-limit-cycle acceptance with
  no escalation; must-catch rejects: growing amplitude, drifting mean,
  oversized oscillation; classic-converged null history both accept paths;
  ≤2000 downsample; noise-floor false-positive guard). Suite: 244 passed
  (baseline 220 + 24), `pytest -m "not integration" -q`.
- Node-side follow-ups owned by other #30 work items: fidelity-aware
  classifier gate (FRAME_TRACK_MIN_PERIODS must accept periods_retained ≥ 3
  for urans_precalc rows), results.fidelity migration, verify queue,
  scheduler ladder, request-URANS endpoint, campaign phases.

## 2026-07-07 — Courant Default 4; In-Run Divergence Watchdog; Drift Denominator Floor

- Incident (prod, job b01a7d46, naca-0012 a0 u15, build
  prod-20260707-4ac0e77-fastrender): long-horizon URANS at
  transientMaxCourant=15 with the relaxed quasi-PISO PIMPLE setup (3 outer
  correctors, p relax 0.3, no residualControl, Euler ddt) accumulated
  splitting error over the 7-period horizon into a velocity singularity: Co
  spiked to 61 despite the cap, k bounding blew up (avg 9480 at 15 m/s
  freestream), dt collapsed 8e-6 → 5e-8, simulated time froze at 0.069 of
  0.333 s for the FULL 7200 s budget, and Cl exploded (mean −79.8, std 10795,
  excursions ±9.45e5). The honesty machinery all worked (honest timeout,
  partial grading, valid_for_polar=f, v3 gate rejected non-positive-drag +
  non-stationary; garbage never entered fits) — but 2 h of CPU produced
  nothing, and EVERY weak-shedding point of the 450-point campaign
  (25/50/100 m/s) is exposed, worse at higher Re.
- Decision — Courant default: `SolverParams.transient_max_courant` default
  15.0 → 4.0 (models.py), the practitioner-standard ceiling for
  relaxed-PIMPLE URANS; the field stays profile-overridable and its
  description now states honestly that >4 risks accumulating splitting error
  over multi-period horizons. Deliberately NOT changed in this pass
  (alternatives for a later pass if Co=4 alone is insufficient): tightening
  PIMPLE (more outer correctors, residualControl, less aggressive p
  relaxation), backward/CrankNicolson ddt, or a per-Re Courant schedule.
  Node-side note: the DB numerics profiles column default is still 15
  (packages/db/schema.ts); the sweeper always sends the profile value, so
  new profiles created after a node-side follow-up should adopt 4 there too.
- Decision — in-run divergence watchdog (tasks.py, same heartbeat thread as
  the stall detector): while phase is solving_rans/solving_urans it reads the
  newest live coefficient.dat tail (last 20 rows, header-aware, tail-bytes
  read) per case every 10 s beat and condemns when EITHER |Cl| >
  `divergence_cl_bound` (=50, Settings) on 3 consecutive beats, OR the
  adaptive dt (median of coefficient time deltas) stays below
  `divergence_dt_floor` (=1e-7, Settings) with no recovery for
  `divergence_grace_minutes` (=5, Settings). Condemn = SIGTERM the CASE's
  solver process group (SIGKILL escalation next beat — the runner-timeout
  kill ladder) + a `divergence_condemned.json` marker with the truthful
  message "transient diverged at t=X: |Cl|=Y, dt=Z". The pipeline clears
  stale markers before every fresh attempt and, on solver exit, raises the
  marker reason as OpenFOAMError — so the case flows the EXISTING
  failed/timeout grading path (attempt evidence retained, honest error, job
  continues its other cases), NEVER the stall detector's whole-job os._exit,
  and a condemned partial window is NEVER graded like an honest timeout
  (the garbage must not even reach the node gate). False-positive guards
  pinned by tests: post-stall |Cl|~3 never trips the bound; startup-ramp
  small dt (first 60 s of a segment's observation, plus reset-on-recovery)
  never condemns; a prod-shaped blow-up fixture IS condemned within the
  grace.
- Decision — drift denominator floor (postprocess/unsteady.py): the
  stationarity metric was structurally unjudgeable at alpha~0 — drift_frac =
  |half-window mean delta| / |mean cl| divides by ~0 for symmetric airfoils,
  so those points could NEVER pass regardless of quality. Now drift =
  |mean(H2)−mean(H1)| / max(|mean cl|, retained cl rms, DRIFT_ABS_FLOOR=0.05).
  A clean near-zero periodic signal passes; a genuinely drifting near-zero
  signal still fails via the rms/absolute-floor scale (both pinned by
  tests). No existing drift tests needed recalibration: their fixtures are
  mean-dominated, so the denominator is unchanged there.
- Verification: 217 non-integration tests green (200 baseline + 17 new:
  watchdog condemn both classes, both spare guards, tail parsing, heartbeat
  integration incl. per-case kill isolation + phase guards + stale-segment
  skip, pipeline truthful-error flow + stale-marker clearing, Courant pin,
  Settings pins, drift floor both ways). Engine image rebuild REQUIRED for
  prod (models/config/tasks/pipeline/unsteady changed).
- Adversarial verify pass (same day) — CONFIRMED + fixed: the watchdog's
  in-memory per-segment verdict survived a retry that REUSES the condemned
  coefficient.dat path (the steady upwind fallback rewrites
  forceCoeffs1/0/coefficient.dat in the same case dir), so the designed
  recovery attempt was re-killed on its first beat with the stale verdict.
  Fix (tasks.py): `observe()` now takes the on-disk marker's presence —
  marker present keeps the TERM→KILL escalation; marker cleared by the
  pipeline means a retry owns the path: an UNCHANGED dead tail is not judged
  at all, and the first changed tail resets the segment for a fresh verdict
  (a retry that diverges again is re-condemned — all three pinned by
  must-catch tests, 220 total green).
- Adversarial verify pass — drift-floor side effect (accepted, layered):
  prod-shaped diverged garbage (cl std ~1e4) now reads STATIONARY (the rms
  term swallows the denominator), so the v3 "non-stationary" reason that
  co-fired in the incident will NOT fire on such garbage anymore. Divergence
  rejection now rests on (1) the engine watchdog killing the run and (2) the
  node classifier's non-physical-coefficients bound — DEPLOYMENT COUPLING:
  the engine image with the drift floor must not ship without the node
  classifier bound (same release train).
- Adversarial verify pass — wall-time envelope at Co=4 (measured from prod
  job b01a7d46 logs: healthy Courant-limited dt at Co=15 ≈ 3.5–6e-5 s,
  ~0.85 s/step on the VPS): dt(Co=4) ≈ 1.3e-5 s → ~65,000 wall-s per
  simulated second at c=0.25/U=15 scale. The 7-period contract horizon
  (0.39 s sim at the St=0.5 planning period; ~0.97 s at physical St≈0.2)
  projects to ≈7–17.5 h of transient wall — 4–11x over the 0.8×7200 s
  continuation budget. A shedding case will burn its full ~2 h budget and
  retain only ~0.6–1.6 periods → rejected by the FRAME_TRACK_MIN_PERIODS=5
  gate. Steps-per-period is speed- and chord-invariant, so this holds for
  the whole 25/50/100 m/s campaign class on the current mesh resolution and
  hardware. Campaign economics decision REQUIRED before launch (options:
  bigger per-point budget, coarser URANS mesh profile, PIMPLE tightening at
  moderate Co, lower min-periods, or URANS only for fast-certifying points).

## 2026-07-07 — Engine Render Grind Killed; Media Wall Budget; Truthful Postprocessing Phase; Stall Detector; Celery Hard Limit

- Incident (prod, py-spy-proven, build prod-20260707-1dc13ea-frametrack): the
  first URANS media runs pinned both worker tasks ALIVE at full CPU for 3+
  hours inside `render_mean_contours -> compute_vorticity ->
  matplotlib CubicTriInterpolator.__init__ -> _cg` — a min-energy
  conjugate-gradient solve over the FULL refined triangulation, TWICE PER
  FRAME x up to 141 frames, GIL-serialized with OpenBLAS spin threads; the
  API container burned ~390% on the same class for scaled media. No timeout
  covers post-solve rendering (the 7200 s guard is solver-subprocess-only),
  status.json stayed phase=solving_urans with last_progress_at frozen at
  solve end while the task heartbeat stayed fresh — so node-side zombie
  detection correctly (per its design classes) stayed silent.
- Decision — vorticity scheme (root cause): per-frame CubicTriInterpolator
  builds replaced by a precomputed linear gradient operator
  (`TriGradientOperator`, src/airfoilfoam/postprocess/images.py): exact
  per-triangle P1 gradients + area-weighted (Green-Gauss) nodal recovery,
  built ONCE per triangulation (cached on the Triangulation object) and
  applied per frame in vectorised O(n_tri) bincount passes. Measured: 0.7 ms
  vs 203 ms cubic on a 3.7 k-node fixture; 140 frames x 100 k nodes in
  ~1.5 s total (was ~30–60 s PER FRAME). Parity vs the cubic gradient on a
  smooth analytic flow: max |lin−cub| = 1.7 % of field range vs the 2.5 %
  40-band contour resolution (p95 = 0.8 %) — visually identical banding;
  pinned by tests.
- Decision — single-pass rendering everywhere: `render_mean_contours`
  accumulates nodal U and takes ONE gradient of the mean (curl is linear, so
  vorticity(mean U) == mean(vorticity(U_i)) exactly — pinned by test);
  pointwise fields keep mean-of-derived semantics (|U| stays mean of
  magnitudes). New `render_animations` reads each VTU ONCE for ALL fields
  (was once per field: 8x re-read) and reports per-field encode errors +
  budget skips; the engine pipeline and the API `render-default-media`
  endpoint both use it. `compute_field_extents` restructured to one read per
  VTU for all fields (was fields x frames reads in the API process).
  `render_custom_field` mean-role vorticity also computes from mean U.
- Decision — media wall budget: the whole post-solve media/frame stage of a
  case runs under `MediaBudget` (pipeline.py), default
  `media_budget_fraction (=0.5, Settings) x solver_timeout`; foamToVTK is
  never budget-skipped (VTUs are evidence, not media). On breach the job
  COMPLETES: remaining renders are skipped, animations/frames stop at the
  deadline (a partial frame-track FIELD directory is deleted — the frame
  player contract forbids partial sequences), and ONE loud quality warning
  ships: "media rendering budget exhausted after Ns: rendered X of Y
  artifacts"; the evidence manifest unavailable map records the gaps.
- Decision — truthful phase: `_finalize_outcome` emits
  `JobPhase.postprocessing` (previously defined but UNUSED) through the
  phase_progress callback (now also wired in the default cold-case path in
  jobs.py), and render progress is observable: "rendering frames 40/120"
  every 10 frames, per-field animation messages. storage.write_status now
  bumps last_progress_at on any PHASE TRANSITION (a stage change is real
  progress; previously only completed_cases bumps did).
- Decision — engine-side stall detector (tasks.py, runs in the task
  heartbeat thread): a running job in solving_rans/solving_urans/
  postprocessing with ZERO live processes under the job dir AND no
  progress-token advance for `stall_no_progress_minutes` (=20, Settings) is
  marked failed "stalled in <phase> — no progress for Nm" and the worker
  CHILD exits (os._exit 70) — the only way to stop an in-process C-level
  grind. Progress tokens: status.json updated_at (any message/phase write),
  coefficient.dat mtimes (live march), frame PNG mtimes (advancing media),
  .vtu mtimes (docker-runner foamToVTK). FALSE-POSITIVE GUARDS pinned by
  tests: live pids spare unconditionally; advancing tokens spare;
  waiting_cpu/meshing/ingesting are never monitored. `run_polar` now
  discards redeliveries of ANY terminal result (was completed-only) so a
  stall-failed job is never resurrected by the broker.
- Decision — celery backstop: `task_time_limit` computed from config
  (celery_app.task_hard_time_limit_s): per-case unit = 2 x solver_timeout +
  media_budget_seconds() + TASK_TIME_LIMIT_MARGIN_S (900 s, named: meshing/
  y+/foamToVTK/evidence overhead), SCALED BY THE JOB'S CASE COUNT at
  dispatch (api submit passes time_limit per apply_async) because one task
  runs a whole batched polar job — a static 2x-solver limit would hard-kill
  legitimate multi-case campaign batches. Hitting it converts to the
  already-handled death class (stale heartbeat -> node classifyLostRunning
  cancel+requeue; redelivery discarded by the terminal-result guard). ONE
  node touch: reconcile.ts classifyLostRunning message no longer asserts
  "worker restarted" (a hard-kill is not a restart) — now "worker process
  died, was hard-killed, or restarted mid-solve"; the "task lost" pin all
  tests rely on is unchanged.
- Second job's dt-collapse timeout (9.2e-07 s at 25 m/s) confirmed honest and
  already handled by the 2026-07-06 truthful-transient-timeout work; no
  change needed there.
- Tests: tests/test_media_grind_guardrails.py (23) — must-catch grind
  ceiling (140 frames x 1e5 nodes < 30 s + CubicTriInterpolator constructor
  bomb), linear-vs-cubic parity within contour band, mean-pass single
  gradient build + single read per VTU + one render per field, linearity
  pin, animations read-once + budget skip, frame progress cadence + no
  partial sequences, budget breach loud degradation (partial + zero +
  generous), postprocessing phase emission, write_status phase-transition
  progress, stall detector both directions (condemn frozen; spare live pids/
  advancing coefficient.dat/advancing frames/quiet phases), condemn path
  persists failed + exits 70, redelivery terminal guard, celery limit math.
  Engine suite: 200 passed (baseline 177 + 23), 6 integration deselected.
  Engine image REBUILD REQUIRED to take effect in prod.

## 2026-07-07 — Sweeper Liveness/Progress Split; Engine Fetch Timeouts

- Incident (prod, 2026-07-06): sweeper_state.heartbeatAt was only written
  inside tick work, so ONE engine HTTP call that hung (engine API saturated by
  solvers; heartbeat age observed climbing 0–49 s between touches,
  "computeFieldExtents FAILED … fetch failed" only after unbounded stalls)
  starved the heartbeat past the web's 90 s truth gate — a LIVE process
  rendered red "PROCESS NOT RUNNING". The per-call touchHeartbeat invariant
  can never fully prevent this: any single awaited call between touches can
  hang indefinitely.
- Decision — split liveness from progress. LIVENESS: an independent 15 s
  `setInterval` in the sweeper process (`startHeartbeatTimer`,
  `apps/sweeper/src/heartbeat.ts`, wired in `index.ts`) writes heartbeatAt
  unconditionally — own DB call, in-flight flag so a hung write never stacks,
  10 s statement timeout (SET LOCAL in a transaction), cleared on shutdown.
  Tick-path touchHeartbeat calls stay, but liveness no longer depends on them.
  PROGRESS: migration 0033 adds sweeper_state.lastTickStartedAt /
  lastTickCompletedAt, stamped by the loop at tick begin/end (`markTickStarted`
  / `markTickCompleted`; completed deliberately NOT stamped on a thrown tick).
- Decision — truth derivation: stale heartbeat >90 s now means TRUE process
  death (red, regardless of tick fields). NEW amber `tick_stalled` state
  (lib/solver-state + campaign-status gate model): heartbeat fresh but
  lastTickStartedAt newer than lastTickCompletedAt AND >5 min old — copy
  "Tick running Xm — engine responding slowly; scheduling continues next
  tick.", campaign badge "SLOW — …" (not BLOCKED: scheduling genuinely
  continues). Enabled-path precedence: process death > engine unreachable >
  engine unhealthy > tick_stalled > healthy. Paused keeps its pre-existing
  pinned position above the engine gates (a paused sweeper saying "scheduling
  continues next tick" would be a false line).
- Decision — every EngineClient call carries an AbortSignal timeout with a
  per-call override (packages/engine-client): polls (health/status/queue/
  runtimes/cache) 15 s, submit/cancel/result 60 s (result JSON can be MBs of
  evidence), extents/render 120 s. A hung request aborts as
  `EngineTimeoutError` — deliberately NOT an EngineError, so
  isEngineConnectionFailure() routes it through the EXISTING release +
  engine-backoff path, never `failed`. Remote-solver hub fetches got the same
  treatment (15 s polls, 120 s media push) since they run inside the tick.
- API exposure: services/sweeper-state.ts reads the tick pair column-tolerantly
  (same pattern as 0026); campaigns list solverState + summary scheduler carry
  lastTickStartedAt/lastTickCompletedAt.
- Outcome: typecheck 6/6; core 66, api 74, web 152 (138+14), sweeper 78
  (68+10) — new must-catch pins: fresh-heartbeat+hung-tick → amber never red,
  stale heartbeat → red regardless of tick fields, timer beats while a fake
  never-resolving engine hangs a real tick, hung fetch aborts at budget into
  the connection-failure class, answered HTTP 500 stays EngineError.

## 2026-07-05 — Engine Rebuilds Get A Script; Sweeper Handles Cancelled And Lost Engine Jobs

- Incident root causes (airfoils.pro): a manual
  `docker compose up -d --force-recreate api worker` (1) left node-api with a
  stale env-baked `ENGINE_EXPECTED_BUILD_ID` (recreated before `.env.deploy`
  was edited → misleading "Engine build mismatch" banner), and (2) killed 4
  in-flight celery tasks whose persisted engine status store kept answering
  `state=running` (zombies the sweeper polled indefinitely). (3) When those
  zombies were cancelled engine-side, the sweeper's status mapping had no
  `cancelled` branch — the state fell through to "running" and nothing was
  released.
- Decision: engine state `cancelled` is a failed-class terminal in the sweeper
  (`cancelJobAndReleaseClaims` in `apps/sweeper/src/reconcile.ts`, wired into
  both the status mapping and the terminal result-file handling): job →
  `cancelled`, claimed results rows → `pending` via the same claim-release the
  admin cancel route uses, never ingest coefficients from a cancelled job.
- Decision: zombie auto-recovery (`classifyLostRunning`): engine-reported
  `running` with zero OpenFOAM processes, a stale worker runtime heartbeat,
  absence from Celery, and last progress older than a 30-minute grace
  (`SWEEPER_LOST_RUNNING_GRACE_MS`) is LOST — engine-side cancel + node-side
  cancel + claim release, loudly logged. The grace exceeds legitimate quiet
  gaps because the engine bumps `last_progress_at` only when a case completes.
- Decision: manual engine rebuilds go through
  `scripts/deploy/rebuild-engine.sh` (env edit first, force-recreate exactly
  the build-id-reading services, `/health` build check, recover-stale kick);
  ops rule recorded in `AGENTS.md`.
- Companion engine-side guardrail (separate change, `src/airfoilfoam`): worker
  startup reconciliation marks status-store `running` jobs failed on boot,
  since a starting worker cannot have inherited running tasks.

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

## 2026-07-06 — Worker-restart orphans release claims; failed rows always carry an error

- Incident (2026-07-04, airfoils.pro): the engine's worker-boot orphan
  reconciliation marks restart-killed jobs state=failed with
  "worker restarted mid-solve; task lost". The sweeper's failed-job ingest
  treated that as solver failure: `failJob` terminal-failed 12 campaign
  points (+3 symmetry mirrors) with EMPTY results.error (failJob never
  stamped error text; ERROR_CLASS_SQL buckets NULL/'' as 'unknown' → the
  "15 failed / unknown" monitor view). Infrastructure interruption became
  fake failure evidence. Repaired live via requeue-failed; this entry is the
  recurrence prevention.
- Decision: the orphan message is a cross-runtime protocol constant —
  `WORKER_RESTART_ORPHAN_MESSAGE` in packages/engine-client (pinned to
  storage.py ORPHAN_MESSAGE by hardcoded-literal tests on BOTH sides:
  apps/sweeper/test/orphan-message-pin.test.ts and
  tests/test_orphan_reconcile.py::test_orphan_message_is_pinned_for_node_clients;
  drift = test failure). On exact match, ingestFailedEngineJob routes to
  releaseWorkerRestartOrphan: solved cases in the partial result.json still
  ingest as done evidence (filtered to solved points only), every remaining
  claimed row is RELEASED via the cancelJobAndReleaseClaims semantics
  (pending, job refs nulled, re-claimable next tick), the sim_job ends
  'cancelled' with "worker restarted mid-solve; points released for
  re-solve", and NOTHING is marked failed — campaign points stay/return to
  'requested'. Loud console.error one-liner.
- Deliberately NO URANS retry submit on the orphan path: retry plans read
  revision-wide classifications, where just-released unsolved rows snapshot
  as 'rejected' until re-solved — deciding now could escalate interrupted
  points to whole-polar URANS. The follow-up re-solve job runs the same
  revision-wide retry pass on real evidence.
- Genuine failed jobs keep failing rows, but results.error must NEVER be
  empty: failJob now stamps the engine job message on every row it fails,
  and ingestResult gained failedPointErrorFallback so a failed point whose
  own p.error is null inherits the job-level message (fallback: "engine job
  failed without a message (job <id>)", which classes 'engine'). No new
  error class added — with stamps in place the existing text-derived classes
  are sufficient and orphan messages never reach results.error anymore.
- Must-catch coverage (recall proven by running them against the pre-fix
  code: both fail with the incident signatures): worker-restart-orphan.test.ts
  (orphan partial → 1 done + 2 released + 0 failed + campaign failed=0 +
  failures endpoint total 0 + gap batch re-picks; genuine failure → rows
  failed with exact message, campaignFailures class 'mesh' not 'unknown')
  plus two sweeper.test.ts cases for the no-result and partial-result
  genuine-failure message stamping.
- Known residual (pre-existing, unchanged): a genuinely failed job that DID
  ingest partial points leaves its untouched claimed rows 'queued' until the
  next sweeper restart's resetOrphans releases them.

## 2026-07-06 — Rejected-point repair, scaled-media retry, classifier regime staleness

- Rejected points get a first-class repair path: `requeueCampaignFailed` now
  optionally covers the REJECTED bucket (`includeRejected` +
  `expectedRejectedCount`, its own 409 drift check) using
  `rejectedResultsWhere` — terminal + result done + rc.state='rejected', the
  same terminal+result_id model as failed/counters, and shared verbatim with
  the new `campaignRejected` dialog-count query so counts and requeue can
  never disagree (the failures/requeue coherence rule extended to the second
  review bucket). Flip semantics mirror the failed path exactly: result →
  pending (evidence history kept, re-solve overwrites in place; the stale
  'rejected' classification row is re-verdicted by the post-ingest polar
  refresh), point → requested. Requeue response now returns
  requeued/requeuedFailed/requeuedRejected. UI: RequeueDialog gained an
  OPT-IN "also requeue N rejected points" section (default unchecked — the
  admin confirms the count explicitly); the CampaignDetail requeue action now
  also appears for rejected>0 with an honest label ("Requeue rejected (N)"),
  closing the journey gap where a 0-failed/N-rejected campaign had NO way to
  open the dialog. Rationale: prod campaign 592d40c6 had 4 done-but-rejected
  points that needed manual SQL to re-solve on the fixed engine build.
- Failed shared-scale renders now retry BOUNDED instead of failing
  permanently (live proof 2026-07-05: one transient engine fetch failure
  orphaned the vorticity scale forever). `field_color_scales.render_attempts`
  (migration 0029) counts FAILED attempts; `retryFailedScaleRenders`
  (ingest.ts) re-runs status='failed' rows on the reconcile pass every 5 min:
  fresh extents, SAME version row re-activated on success (no version churn),
  attempts+1 + failureReason on failure, capped at
  MAX_SCALE_RENDER_ATTEMPTS=3 (ingest attempt + 2 retries), loud EXHAUSTED
  log at the cap. Failed rows obsoleted by a newer version in scope are dead
  history — never retried (a later ingest's rebalance already re-rendered
  every extents row). The retry timer initializes at module load, so the
  first pass runs one interval after boot — long-lived sweeper semantics are
  unchanged and short-lived test processes never fire it implicitly (a
  0-initialized timer made every vitest worker's first reconcile() race the
  sweeper suite's failed-scale fixtures across parallel files).
- Known residual (pre-existing, unchanged): a hard process crash mid-render
  leaves a scale row stuck 'rebalancing' (not 'failed'), which the retry pass
  ignores; the next ingest for that scope self-heals by allocating the next
  version. Revisit only if crash-orphaned 'rebalancing' rows show up in prod.
- Classifier upsert staleness: `upsertClassification`'s conflict UPDATE now
  rewrites `regime` too (prod row 3db79ff8 kept regime='rans' on an accepted
  URANS verdict after the same results row re-solved as URANS).
  classifierVersion was already rewritten; the rule is that the conflict SET
  must cover EVERY verdict-scoped column. Recall proven: reverting the two
  regime lines fails the new 3db79ff8 must-catch test ('rans' ≠ 'urans');
  reverting the render_attempts increment fails the scale-retry must-catch.
- Test-isolation rule (sweeper suite): tests that add classifiable results to
  the SHARED test revision must delete them in-test before finishing — the
  whole-polar promotion heuristics read REVISION-WIDE classifications, so
  leaked evidence shifts later suites' decisions (caught: the new scale-retry
  test's α=87 accepted point flipped whole-polar-urans → invalid-rans-points).
## 2026-07-06 — Targeted URANS: steady-RANS-first warm start + timeout honesty (prod clarky -2..4 timeouts)

- Prod evidence (job 9ab16d4b, clarky alpha=4, single-point targeted-urans):
  URANS-only cases skipped every steady stage (`run_case` skipped the RANS
  solve AND `_prepare_transient_case` returned right after potentialFoam for
  `force_transient`), so a cambered airfoil at alpha=4 cold-started from
  near-uniform flow; the Courant cap collapsed dt to ~1e-6 s and the run hit
  the 7200 s solver timeout at t=0.010 of 0.333 s. The recorded error "URANS
  transient produced no coefficient.dat" was FALSE — the file existed with
  healthy rows.
- F1 decision (warm-start design): URANS-only (`force_transient`) cases now run
  the steady RANS stage first, exactly like the normal path (same
  `solve_once` incl. seed-cache donor lookup, first-order fallback,
  `rans_max_iterations` cap — the `force_transient` bypass in
  `_steady_rans_params` was removed), but a steady failure is tolerated (logged
  + quality warning) and steady coefficients are never accepted as the URANS
  result. When the steady field exists on the shared job mesh, its latest-time
  fields are copied into the transient's `0/` (`_seed_transient_from_steady`)
  — potentialFoam is skipped so it cannot clobber the developed field.
  Otherwise the transient prep now runs the short potentialFoam+simpleFoam
  init UNCONDITIONALLY (previously skipped for force_transient). Batch
  fallback-path behavior is unchanged; the batch URANS-promotion path
  (`_run_full_urans_replacement`) inherits the same steady-first fix.
- F2 decision: a transient solver TIMEOUT is not a crash. `RunResult` gained
  `timed_out`; a timed-out attempt with gradable coefficient.dat rows is graded
  through the existing history/quality machinery and reported with
  `ok=False, can_refine=False` and the honest reason "base/refined transient
  timed out at t=X of Ys; graded partial window; ..." (never refined — the
  budget is already spent). A timeout with nothing gradable raises the truthful
  "URANS transient timed out after Ns at t=X of Ys (dt collapsed to D)". A
  refined-pass timeout falls back to the completed base pass.
- F3 decision: "URANS transient produced no coefficient.dat" is raised ONLY
  when the transient's coefficient.dat is actually absent; when it exists but
  grading failed, the error says so ("coefficient.dat has data up to t=...").
  Also: a force_transient case whose transient fails must raise instead of
  silently reporting the (now-present) steady coefficients as the URANS point.
- Node compatibility: targeted result.json shape unchanged (no `attempts` added
  on the concurrent path); points may now carry `iterations`/`final_residual`/
  `first_order_fallback` from the steady stage plus extra `quality_warnings`
  strings — ingest.ts maps all of these already; `regime` still derives from
  `p.unsteady`.
- Recall proven: tests/test_targeted_urans_warmstart.py (13 tests) reproduce
  the incident shapes (prod-like dt-collapse pimpleFoam log, timeout with/
  without coefficient rows, transient-file-present false error) and fail
  against the pre-fix code; false-positive guard keeps genuine non-timeout
  crashes returning None. Engine rebuild/redeploy required for prod.

## 2026-07-06 — Point History Explorer (Solver ▸ Points tab)

- Approved feature (mockups artifact 268e8b16): a fourth Solver tab
  (`?section=queue&tab=points`, replace semantics like Background/Engine)
  giving admins a global filterable point table plus an in-place story side
  panel — the honest per-point narrative (attempt chain, interruptions,
  classification verdicts, campaign closure context) that previously required
  raw SQL.
- Read model decision: the row universe is every `results` row (the canonical
  per-(airfoil, revision, α) state — solved, failed, rejected, solving,
  backlog) UNION terminal derived-by-symmetry campaign cells (the −α mirror
  rows, shown as "mirror of +X°", no timeline of their own — source point
  link instead). Keyset pagination on (`results."updatedAt"` DESC, row key)
  with `r:<uuid>` / `d:<cell key>` row keys; page ≤50 rows, one lateral
  attempt-digest JSON per row (no N+1). Status chips and the bucket filter
  share ONE SQL CASE (`packages/db/src/point-history.ts BUCKET_SQL`) so chip
  counts always describe exactly the listed rows; `solving` covers
  pending+queued+running, done-but-superseded/unclassified rows appear under
  "all" only.
- Interruption attribution decision: cancelled `sim_jobs` are matched to a
  point through the immutable `request_payload` (aoas list + pinned revision
  or batched conditionMap) because claim release clears `results.sim_job_id`.
  Worker-restart cancels render as "interrupted — worker restarted mid-solve;
  point released" (amber). Escalation semantics: RANS→URANS is amber/normal;
  red strictly for crashes/timeouts.
- Data addition (0030): `result_attempts.quality_warnings text[]` +
  `results.quality_warnings text[]` persist the engine's non-fatal
  `PolarPoint.quality_warnings` at ingest (empty → NULL; no backfill —
  historical absence stays absent). Timeline renders them as the honest
  "why" lines. 0031 adds the explorer indexes (results activity keyset,
  partial terminal-derived cells, condition+aoa closure probe) — plans
  verified on the dev DB (index scans, <1 ms).
- Single-point requeue (`requeueSinglePoint`, POST
  `/api/admin/point-history/:id/requeue`) reuses the requeue-failed /
  requeue-rejected (PR #1) reset semantics scoped to one result row: failed
  or done+rejected only (else 409), result → pending + sim_job cleared,
  terminal campaign cells → requested, campaign progress/completion
  recomputed in the same transaction.
- The Points tab owns its own bounded fetches; the Solver queue poll is fully
  suspended while it is open (`solverScopeForTab` → null). Filters live in
  the URL (`pstatus/pairfoil/pcampaign/pregime/perr/pre`, defaults omitted)
  via pure round-trip helpers in `apps/web/lib/point-history.ts` (digest +
  timeline builders unit-tested there too).

## 2026-07-06 — URANS frame-track contract: node ingest + stationarity gate (task #24)

- Cross-runtime contract pin (same pattern as the worker-restart orphan
  message): the engine ships per URANS point `result.json →
  point.frame_track` = `{ period_s, periods_retained, stationary, drift_frac,
  window{t_start,t_end}, stats{cl,cd,cm × mean/std/min/max — time-weighted
  trapezoidal over an INTEGER number of periods}, fields[], frames[≤120 ×
  {i,t,cl,cd,cm}], image_pattern "frames/{field}/f{i04}.png" }`. Point-level
  cl/cd/cm/strouhal = frame_track.stats means / measured St (single source of
  truth). No-shedding steady points ship `frame_track = null`. Node pins the
  shape with a strict parser (`parseFrameTrack`, rejects added/removed/
  renamed/retyped keys at every level) + fixture JSON test
  (`apps/sweeper/test/frame-track-contract-pin.test.ts`,
  `fixtures/frame-track-contract.json`); the engine pins it with a
  serialization test. Drift on either side fails that side's tests.
- Migration 0032: `results.frame_track jsonb NULL` (persisted VERBATIM at
  ingest — snake_case engine shape, evidence stays byte-honest) + enum value
  `evidence_artifact_kind 'frame_image'`. Attempts need no new column: the
  full PolarPoint (frame_track included) already lands in
  `result_attempts.evidence_payload`, and the classifier reads
  `evidence_payload -> 'frame_track'`.
- Classifier gate (`frame-track-v3`): a URANS point with NON-NULL frameTrack
  must also have `stationary === true` (else reason `non-stationary`) and
  numeric `periods_retained >= 5` (else `insufficient-periods`) to classify
  accepted; rejected confidence stays 1. The gate FAILS CLOSED: a drifted
  frame_track payload (missing/renamed/retyped verdict fields) rejects,
  never accepts. BACKWARD COMPAT decision: frameTrack NULL/absent = legacy
  pre-contract evidence (or steady point) → the v2 gate (converged + force
  history + video) stands unchanged, so deploying the gate cannot
  mass-reject historical accepted URANS rows; they re-gate naturally only
  when re-solved under the new engine. Pinned by an explicit BACKWARD COMPAT
  test in `packages/core/test/core.test.ts`.
- Ingest drift behaviour: `frameTrackForPoint` validates against the contract
  and logs `frame_track CONTRACT DRIFT` loudly but persists the raw payload
  anyway — it is solver evidence, and a malformed shape can only ever REJECT
  a point downstream. Unknown evidence-artifact kinds from a newer engine are
  now loud-skipped per artifact instead of aborting the whole ingest on a pg
  enum error.
- Frames registration choice: frame PNGs are registered as
  `solver_evidence_artifacts` rows with kind `'frame_image'`
  (FRAME_IMAGE_ARTIFACT_KIND, pinned in @aerodb/engine-client) through the
  EXISTING ingest evidence sweep — NOT as `result_media`: result_media's
  unique key is (result, kind, field, role) with a closed image/video enum,
  i.e. one row per field/role — structurally wrong for ≤240 per-frame files,
  and the modal fetch needs per-(field, frame-index) URLs, which the
  evidence rows carry naturally (field column + frame index from
  metadata.frameIndex or the `f{i04}.png` filename).
- API exposure (`assembleSim → services/sim.ts`): the sim payload ships
  `frameTrack` (camelCase stats/window + frames[].imageUrls resolved to
  /api/media keys). Frames with unregistered PNGs ship WITHOUT that field's
  URL (absence stays absence); frame_image rows are excluded from the
  generic `evidenceArtifacts` list to keep the payload bounded; a
  contract-drifted stored payload resolves `frameTrack: null` (the point is
  rejected by the classifier anyway, raw jsonb stays on the row as
  evidence).

## 2026-07-06 — URANS frame-track contract: engine recording side (task #23)

- The engine now ships `point.frame_track` per shedding URANS point in
  result.json, matching the pinned cross-runtime shape in
  `packages/engine-client/src/frame-track.ts` EXACTLY (period_s,
  periods_retained, stationary, drift_frac, window{t_start,t_end},
  stats{cl,cd,cm}{mean,std,min,max}, fields, frames[{i,t,cl,cd,cm}],
  image_pattern). Engine pin: `tests/test_frame_track.py`
  (`test_frame_track_contract_pin_exact_keys_and_types`); drift on either
  side fails tests (orphan-message-pin pattern). A real engine-serialized
  payload was validated against the node strict parser during delivery.
- INTEGRATE UNTIL N WHOLE PERIODS: new solver-profile fields
  `urans_min_periods` (default 7), `urans_drift_tolerance` (default 0.05)
  and output field `frame_fields` (default vorticity+velocity_magnitude) on
  `SolverParams` (models → request → pipeline, same wiring as
  transient_cycles). The transient extends in continuation chunks by
  REUSING the existing restart mechanics (`write_transient` from latestTime
  + solver restart) — deliberately no second continuation path. Each chunk's
  coefficient.dat segment is merged for grading
  (`_transient_coeff_selection` excludes the steady-init pseudo-time
  history; must-catch test proves cl=99 init rows can never contaminate).
- Period tracking: autocorrelation (`measure_period`) on the Cl signal
  (uniform resample, demean, first peak past the first zero crossing,
  parabolic refinement) — chosen over zero crossings because it is robust to
  noise on the shedding signal; FFT `period_s` remains the fallback.
- Budget honesty: the continuation loop reuses the refine feasibility logic
  (measured simulated-seconds-per-wall-second rate vs
  URANS_REFINE_BUDGET_FRACTION × solver timeout). A budget stop grades
  "retained M.x of N periods (budget)" and disables the refined pass (it
  would blow the same budget). No-shedding early exit and the
  two-stable-period early stop remain untouched and break the loop first.
- Stats = SINGLE SOURCE OF TRUTH: point cl/cd/cm(+std) and strouhal come
  from time-weighted trapezoidal stats over exactly K=floor(retained) whole
  periods (`period_window_stats`); the biased-phase fixture proves the
  integer-period window kills the fractional-period mean bias that plain
  row-averaging carries. Stationarity = whole-period-half Cl mean drift
  (floor(K/2) periods per half, middle period skipped when K is odd, so the
  drift metric itself carries no phase bias); non-stationary windows ship a
  loud quality warning and stationary=false for the node gate.
- Frame export: ~24 frames/period over the last min(3,K) periods, cap 120,
  rendered at the contract's 640px width from the VTU frames nearest each
  target time (`render_frame_track_images`, consistent per-field color
  scale); per-frame coefficients interpolated from coefficient.dat at the
  frame's exact time. PNGs live at `frames/{field}/f{i04}.png` under the
  case dir (namespaced under the AoA subdir for marched polars) and ship in
  the evidence bundle with the pinned artifact kind `frame_image`. The mp4
  animation now renders FROM the same frame-export window so video and
  frames agree; mean images/evidence keep the full K-period window.
- No-shedding steady points ship `frame_track=null` (existing steady path
  untouched); a shedding point whose period is genuinely unmeasurable also
  ships null plus its existing quality warning — missing data is shown as
  missing, never invented.
- Verification: 174 engine tests green (151 baseline + 23 new); recall
  proven by mutation (steady-init contamination, disabled budget guard,
  plain-mean regression, contract-drift extra key — all caught). Docker
  engine image rebuild required to ship.

## 2026-07-07 — Solver-results modal redesign (task #25): frame-synced player

- The SimModal URANS view is rebuilt around ONE piece of truth: the current
  frame index into the engine-recorded frame track (`results.frame_track` →
  `SimulationDetail.frameTrack`). Scrub bar, Cl(t) window chart cursor, frame
  image pane, and overlay readout all derive from that index through pure
  helpers in `apps/web/lib/frame-player.ts` (no DOM/React — fully covered by
  vitest). Playback paces per shedding period (1 wall-second per period at
  1×, 0.5× available), so ~24 engine frames/period play at ~24 fps.
- Legacy fallback decision: points with `frameTrack` null/absent (steady,
  no-shedding, pre-contract evidence) or an empty frame list fall back to the
  stored mp4 loop with an explicit legacy-evidence note — frames are never
  invented client-side.
- Frame PNG URLs resolve from registered `frame_image` evidence rows only;
  frames whose PNG is unregistered render an honest missing state (absence
  stays absence). E2E `apps/web/e2e/sim-frame-player.spec.ts` drives the
  player against the live dev stack.

## 2026-07-07 — Adversarial-review reconciliation: early-stop retention, gate coherence, honest gaps (F1–F8)

Final pre-#27 adversarial review of the combined URANS overhaul confirmed 8
defects; fixes, in decision form:

- F1/F2 — the {early-stop 2, node gate 5, engine target 7} period triangle
  was incoherent: every early-stopped point retained ~2 startup-adjacent
  periods with a ZERO startup discard, shipping +~9%-biased time-weighted
  means that the frame-track gate then deterministically rejected
  (non-stationary + insufficient-periods). DECISION: the two-period
  comparator remains only the DETECTOR; `URANS_STABLE_RETAINED_CYCLES` is
  now 5.0 (cross-runtime parity with `FRAME_TRACK_MIN_PERIODS = 5`, +0.5
  period stop margin so downstream period re-measurement can never floor
  below the gate), the early-stop monitor keeps integrating until that many
  periods exist past the START of the first stable window, records
  `retain_from` in the marker, and `_finalize_outcome` windows early-stopped
  frame-track stats to that certified-stable tail (never a fraction discard,
  never the raw span). The 7-period full-path target stays the ideal; budget
  stops that still retain >=5 stationary periods remain acceptable evidence.
  RESIDUAL RISK (deferred to #27 by necessity): real prod wall-time per
  URANS point at Re≈6.8M is unverifiable from this machine (remote-solving
  mode, admin-only prod timings); validate ONE real URANS point end-to-end
  on prod hardware before launching the 450-point campaign.
- F3 — a shedding point whose period was unmeasurable shipped
  `frame_track=null`, indistinguishable from legacy pre-contract evidence,
  silently skipping the gate. DECISION: ingest is the trust boundary — any
  FRESH ingest is post-contract by definition, so `frameTrackForPoint` now
  persists a fail-closed sentinel (`{missing:true, stationary:false,
  periods_retained:null, reason}`) for shedding points missing frame_track;
  the gate rejects it honestly, the modal falls back to the mp4. NULL
  remains reserved for steady/no-shedding points and pre-existing legacy
  rows.
- F4 — the player scrub/playback/chart domain was the full K-period stats
  window while frames cover only the last min(3,K) periods (~57% of every
  loop frozen on frame 0 at K=7). DECISION: `buildFramePlayerModel` clamps
  the playback domain to the frame-covered span; the window STATS stay the
  full-K truth and are displayed unchanged.
- F5 — frame PNGs were stored 3× engine-side (~110–215MB/point). DECISION:
  the evidence tar bundle now EXCLUDES `frames/` (PNG is incompressible;
  manifest carries `bundleExcludes:["frames"]`); frames still ship as
  individual `frame_image` artifacts + the case-dir copy the image_pattern
  points at. Check VPS disk headroom before #27 regardless.
- F6 — campaign-batching suite flaked on shared-dev-DB residue: flow
  conditions / reference geometry profiles are find-or-create (canonical-key
  dedupe), so another suite's preset can reference "our" rows. DECISION:
  suite cleanup deletes those rows only when nothing references them
  (NOT EXISTS guard) — own-row cleanup stays, foreign referents no longer
  explode the suite.
- F7 — both image_pattern pins only covered the bare single-case literal
  while production multi-AoA jobs ship `a{i}/frames/{field}/f{i04}.png`.
  Pins added on both runtimes for the prefixed production shape.
- F8 — frame-image URL resolution rested solely on undocumented filename
  parsing (`f{i04}.png` regex); the claimed `metadata.frameIndex` mechanism
  did not exist engine-side. DECISION: the engine now stamps `field` +
  `metadata.frameIndex` on every frame_image artifact at the writer (the
  filename coupling stays engine-internal); the node regex remains only as
  a legacy fallback.
- F9 — worker-restart-orphan.test.ts flaked at file level (2 of 3 full
  `pnpm test` runs, 2026-07-07): its afterAll deleted
  reference_geometry_profiles rows unconditionally while campaign-batching's
  presets (same chord 0.2/span 1 → same canonical key → shared find-or-create
  row) still referenced them. Creation path: the file was written 2026-07-06
  copying the batching live-DB pattern; the NOT EXISTS guard fixing this exact
  flake landed in campaign-batching only (F6, 2026-07-07) without sweeping the
  sibling file — a generalization miss, not a new mechanism. DECISION:
  campaign fixture cleanup is centralized in `@aerodb/db/test-cleanup`
  (`cleanupCampaignFixtures`: dependency order; guarded registry deletes
  covering BOTH simulation_presets and sim_campaign_conditions — F6's guard
  only checked presets; candidate set = created-by ∪ referenced-by so the
  last-finishing suite removes shared rows instead of leaking them with
  created_by NULL). worker-restart-orphan now uses a file-unique chord (0.19)
  so parallel suites cannot entangle geometry at all; api-suite raw mop-ups
  (campaigns.test.ts, point-history.test.ts) gained the same guards; a
  deterministic must-catch test (campaign-fixture-cleanup.test.ts) pins the
  incident interleaving: unguarded delete raises 23503, helper cleanup of
  suite A skips the shared row, helper cleanup of suite B removes it.

## 2026-07-07 — Ladder gate stage-1 FAIL: engine ships honest non-converged steady points; primary RANS honors the profile budget

Prod evidence (campaign a1802299 ladder-gate-20260707, engine job a2379532,
naca-0012 alpha=15 / 25 m/s / 0.1 m): the single steady point ran 600
iterations, produced real force data (cl=0.5174, cd=0.1032, steady_history
with an honest "Cl half-window means differ by 29.8%" rejection, 34 evidence
artifacts) — yet result.json shipped `points: []` and the job FAILED in 73 s
with "All cases failed", so the node ladder could never escalate.

Regression mechanism (traced, engine side): NOT a raise in
`_finalize_outcome` — the RANS-tier non-converged path completes fine. The
drop lived in the warm-start marched path: `rans_outcome_rejected_for_polar`
(`not converged` ⇒ rejected, unchanged since 5118ca45b) fed
`solve_polar_marched`'s rejected-`continue`, which excluded the outcome from
`final_points`; with every point non-converged, jobs.py's
`any_ok = any(p.error is None ...)` saw zero points ⇒ JobState.failed /
"All cases failed". Pre-ladder this was masked because non-converged steadies
either escalated in-engine (`transient_fallback=true` requests) or flowed the
case-parallel `run_case` path, which ships every outcome. The ladder's
RANS-first tier (transient_fallback=false + marched scheduling) made the
silent drop the terminal behavior, and the new oscillating-averaging gate
(mean_stable=false keeps converged=false) put every honest post-stall steady
into that hole.

DECISIONS (engine):
1. A steady case with real force data NEVER fails or vanishes for
   non-convergence. `steady_outcome_shippable` (pipeline.py): a rejected
   steady outcome with finite cl/cd and no error ships as an honest point
   (converged=false, final-window coefficients per the pre-ladder
   `parse_force_coefficients` tail-average convention, steady_history
   attached) from `solve_polar_marched`; it still never publishes a
   warm-start seed. `_finalize_outcome` adds a loud quality note
   ("steady RANS did not converge; coefficients are the final-window …" plus
   the detector's rejection note) whenever the RANS tier terminates
   non-converged with no in-engine escalation configured. Case failure stays
   reserved for true crashes (error / no coefficient data ⇒ evidence-only
   attempt, honestly absent from the polar).
2. `settings.rans_max_iterations` (default 600, config.py) is scoped to the
   URANS-INIT steady stage only. Pre-fix source of the 600: jobs.py passes
   the setting into every job; `_steady_rans_params` capped
   `n_iterations` unconditionally; CaseBuilder writes
   `endTime = solver.n_iterations` (case/builder.py:146) ⇒ controlDict
   endTime 600 while the profile shipped 3000, starving moderate-AoA
   convergence (the R1 goal). Now: `_steady_rans_params` caps only
   `force_transient` params; a PRIMARY steady RANS solve runs the profile's
   full n_iterations (wall clock still guarded by rans_solver_timeout).

Guardrails: tests/test_ladder_gate_regression.py (fixtures shaped like the
gate failure: 600-iteration drifting post-stall history, real
`_finalize_outcome`, single-point marched polar) + updated marched-path pins
in tests/test_unsteady.py. Recall proven: all 6 must-catch tests fail on the
pre-fix pipeline; the false-positive guards (oscillating-accepted, true
crash, URANS-init cap) pass on both. Suite: 244 → 253 green
(`pytest -m "not integration"`). Node-side ingest gaps (zero result_attempts
ingested, generic "engine job failed" message, silent sweeper claim→failure)
are tracked separately on the Node runtime.

## 2026-07-07 — Ladder gate stage-1 FAIL, Node half: failed-job evidence ingest, real engine message, reachable gated retry, loud sweeper events

Context: campaign a1802299 (ladder-gate-20260707), engine job a2379532 FAILED
"All cases failed" with points: [] but a real shipped attempt (cl=0.5174,
cd=0.1032, converged=false, 600-sample steady_history, 34 evidence
artifacts). Node symptoms: zero result_attempts ingested, results.error
stamped with the generic "engine job failed", submitUransRetryForJob
unreachable (points===0 → failJob + return), and no sweeper log line between
claim and terminal failure.

Decisions (apps/sweeper):
1. `ingestResult` now reports `attempts` (rows ingested from
   polars[].attempts) so the failed-job path can tell "evidence shipped" from
   a true crash (ingest.ts).
2. `ingestFailedEngineJob` (reconcile.ts): points===0 && attempts>0 ⇒ fail
   the rows with the ENGINE's real message, stamp the sim_job
   engineState='failed' + ingestedAt (the gated-ladder rescan requires
   status='failed' AND ingested_at), refresh polar caches (classifies the
   fresh attempt evidence), then run submitUransRetryForJob — the wave≤2
   bound and the campaignHasOpenRansGaps gate are unchanged. points===0 &&
   attempts===0 keeps the original terminal behavior (pinned false-positive
   guard). Message preference: result.message → caller msg → pinned
   non-empty fallback; the two runtime-probe dispatch sites now fall through
   result_message → status_message → generic (the engine writes "All cases
   failed" on the STATUS, not the result payload).
3. Loud events: one `engine job FAILED (…campaign, airfoil, angles…): <msg> —
   N point(s), M attempt(s) ingested; <verdict>` line per terminal failed
   ingest (incl. the previously silent catch), one `job submitted → engine …`
   line per wave-1 submit outcome (loop.ts submitComposedJob), one
   `URANS retry submitted → engine …` line per wave-2 retry submit.
4. Test-harness cross-file races fixed while proving the above: sweeper.test
   bound its whole world to an unordered `airfoils LIMIT 1` pick that could
   select another suite's `sw-*` fixture airfoil (deleted mid-run → 19
   cascade failures); now non-fixture + ordered. The machine-wide verify-gate
   test (urans-ladder.test) waits bounded for hasOpenCampaignLadderWork quiet
   before ticking — a permanently open gate still fails.

Recall proven: the new must-catch test (failed job, zero points, shipped
attempts → attempts+evidence ingested, "All cases failed" stamped, precalc
retry child enqueued, loud lines) fails on the pre-fix sources exactly on the
prod defect. Suites: sweeper 114/114, api 82/82, pnpm typecheck clean.

## 2026-07-07 — URANS fidelity budgets retuned to measured prod rates (gate tier-2, engine half)

Decision: raise the URANS fidelity-tier wall budgets to what the gate campaign
actually measured. `URANS_FIDELITY_BUDGET_S` precalc 3600 → 7200 s, full
21600 → 43200 s (`src/airfoilfoam/models.py`), with the parity constants in
`packages/engine-client/src/fidelity.ts` updated in the same change so the
cross-runtime pin stays atomic (the sweeper pin test values are the node
agent's suite: `URANS_PRECALC_SOLVER_BUDGET_S` 7200,
`URANS_FULL_SOLVER_BUDGET_S` 43200).

Measured basis (ladder-gate campaign, naca-0012 alpha=15°, 25 m/s, 0.1 m
chord — quality_warnings quote): "URANS integration stopped by the wall-clock
budget guard: retained 1.4 of 3 periods; projected 0.6h continuation exceeds
80% of the 1.0h solver timeout". That is ~14 min/period on the HALF-RES
precalc mesh at the worst campaign class (c/U = 0.1/25), so the 3-period
precalc target needs ~1.4 h → 7200 s (the old 3600 s budget just missed a
healthy run: St 0.118, cl mean 0.689 coherent with the accepted RANS 0.652).
The full tier runs the FULL mesh (~8× cost → ~2 h/period), so 7 periods need
~14 h of integration headroom under the 80% wall-guard fraction → 43200 s;
full is the background trickle tier per the approved ladder design, so a
12 h budget is acceptable there.

Celery hard-limit derivation updated (`celery_app.py`
`task_hard_time_limit_s`): the per-case solver term is now
`2 * max(solver_timeout, max(URANS_FIDELITY_BUDGET_S))` because the full-tier
budget (43200 s) exceeds the default `solver_timeout` (7200 s) — the old
`2 * solver_timeout` formula would have let celery SIGKILL healthy full-tier
transients. Worst-case fit verified in the test: steady init (1200 s) + two
0.8-wall-guarded transients (~34.6 ks each) + media (3600 s) + margin ≈ 75 ks
under the 90 900 s single-case ceiling.

Tests: pins updated in `tests/test_fidelity_tiers.py` (7200/43200); celery
math test in `tests/test_media_grind_guardrails.py` now asserts the ceiling
covers the largest tier budget, keeps a solver_timeout-dominates case, and
proves the worst-case fit. Engine suite 253 passed;
`@aerodb/engine-client` typecheck clean (the package has no test runner —
its pins are exercised by the sweeper suite).

Open item this does NOT fix (finding 1 of the same gate review): ingest
UPSERTs cell-unique results before classification, so a REJECTED
higher-fidelity attempt can clobber an ACCEPTED lower-fidelity row — that
clobber guard is node-side work, tracked separately.

## 2026-07-07 — Ingest replace guard (gate tier-2 finding 1, node half) + verification hardening

Decision: an incoming point that would FAIL the classifier's pointwise
evidence gate must never replace a canonical row holding accepted (or
needs_urans — provisional accepted) evidence. `apps/sweeper/src/ingest.ts`
pre-classifies the incoming payload with the EXACT post-ingest gate
(`baseRejectionReasons`, now exported from `packages/core/src/polar-fit.ts`
— no re-implementation, so gate changes can't drift), and when the guard
engages the attempt row is ingested with a loud
`"higher-tier attempt rejected: …"` quality marker, evidence artifacts land
on the ATTEMPT with `resultId: null`, and campaign/request/verify
bookkeeping settles against the KEPT row. Decision matrix (all cells
pinned in `apps/sweeper/test/replace-guard.test.ts`): incoming
accept × {accepted, rejected, absent} → replace as always; incoming
reject × accepted/needs_urans → KEEP; incoming reject × {rejected, absent,
failed, claimed, unclassified, legacy-no-revision} → replace ("any honest
evidence beats none").

Drift fail-safety (verified by construction + a pinned probe test): every
gate in `baseRejectionReasons` fails CLOSED and the pre-gate's media checks
judge the payload's own shipment (which the same ingest persists), so
pre/post divergence within an ingest can only OVER-reject the incoming
point — the safe direction (guard keeps accepted evidence). Post-time
evidence loss (e.g. media rows deleted later) honestly flips the cell via
the post-classifier, which stays the sole source of truth for the canonical
row; the guard is advisory at ingest time and never resurrects.

Verification found and fixed one hole in the guard's artifact isolation:
the engine's warm-start march ships every point ALSO in
`polars[].attempts` (same evidence_artifacts, same storageKey+sha256), and
the artifact upsert's conflict SET rewrites `resultId` — so the attempts
loop re-attached the rejected shipment's manifest to the KEPT row,
re-poisoning `manifestEvidenceBaseForResult` for future re-renders of the
accepted row. Fixed with a per-polar `guardedAoas` set (attempts-loop
artifacts for guarded cells register with `resultId: null`); recall proven
by temporarily reverting the fix (the new MUST-CATCH warm-start-duplicate
test fails exactly on the poisoned resultId). Also pinned the previously
untested rejected-verify interaction: a guard-rejected FULL verify solve
keeps the accepted precalc row and reconcile's verified-row-is-the-judge
check cancels the queue item terminally (never silently supersedes, never
strands the item).

Suites after the combined change: engine pytest 253 (6 deselected),
typecheck 6/6, core 82, api 82, web 174, sweeper full battery green with
replace-guard at 9 tests (incident MUST-CATCH, supersede, matrix cells,
needs_urans false-positive guard, warm-start duplicate, verify-cancel,
drift probe, gate mirror).

## 2026-07-07 — Period tracker hardened: physical Strouhal band, sub-harmonic preference, half-window stability (engine)

Prod evidence (airfoils.pro, naca-0012 alpha=15, U=25 m/s, c=0.1 m,
half-res precalc): two IDENTICAL precalc solves measured wildly different
shedding periods. Run 1: period_s=0.0338 (St 0.118), 1.4 periods retained
in ~25 min, coherent frame_track. Run 2: 0.8 "periods" in ~55 min with a
projected 2.8 h continuation — budget-guard rejected {insufficient-periods}
(airfoil 0e209725 aoa 15). Same physics/mesh/numerics: the PERIOD ESTIMATE
moved ~4x, not the solver speed. `measure_period` (autocorrelation, global
argmax past the first zero crossing) locked onto a ~0.12 s sub-harmonic /
low-frequency modulation of the broadband post-stall lift signal, so
retained-cycle counts collapsed and precalc acceptance became a lottery at
exactly the deep-stall angles that need URANS.

Decisions (src/airfoilfoam/postprocess/unsteady.py):
1. PHYSICAL BAND: plausible shedding window St in [0.05, 0.5]
   (`SHEDDING_STROUHAL_BAND`) -> period in [c/(0.5 U), c/(0.05 U)]
   (`shedding_period_band` / `shedding_frequency_band`; U=25, c=0.1 =>
   [0.008, 0.08] s — contains 0.0338, excludes 0.135). `measure_period`
   gains `period_band` (restricts the autocorrelation lag search);
   `dominant_frequency` gains `freq_band` (restricts the FFT peak search —
   this is the `force_history`/`stable_two_period_window` path backing
   history.strouhal/period_s and evaluate_urans_quality). Callers without
   flow context pass None and keep the legacy behavior verbatim.
2. SUB-HARMONIC PREFERENCE: within the band the HIGHEST-frequency local
   peak whose strength is >= SUBHARMONIC_PEAK_TOLERANCE=0.8 of the
   strongest in-band peak wins. 0.8 because the fundamental keeps >= ~80%
   of a strong sub-harmonic's autocorrelation under comparable-amplitude
   modulation (the T/2T lottery regime), while noise peaks fall well below;
   when modulation is SO dominant the fundamental drops under 80%, the
   signal genuinely repeats only at the longer period and rule 3 guards the
   budget math instead. In-band FFT fallback (used when the lag grid cannot
   resolve the band or no autocorrelation peak clears corr_threshold) must
   be CORROBORATED by autocorrelation >= corr_threshold at its lag — pure
   noise always has an in-band spectral argmax and must not mint a period.
3. STABILITY CHECK: `estimate_period(times, values, speed=, chord=)`
   measures the two halves of the analysis window independently; half
   estimates differing by > PERIOD_AMBIGUITY_TOLERANCE=0.30 flag "period
   ambiguous" (quality warning discloses both values) and the CONSERVATIVE
   SHORTER period feeds retained-cycle counting and budget projection —
   shorter period => more counted cycles => the guard can never inflate the
   projected hours off a long-period lock, and the ambiguity is disclosed
   rather than hidden.
4. Plumbing (src/airfoilfoam/pipeline.py): continuation tracking in
   `_extend_transient_until_periods` and frame_track assembly in
   `_finalize_outcome` now call `estimate_period` with spec.speed/chord
   (ambiguity -> quality warning at the frame_track site, note in the
   budget-guard reason); the FFT chain (force_history -> history.strouhal
   -> evaluate_urans_quality retained-cycle math; stable_two_period_window
   early-stop monitor) is band-constrained at the source.

Recall proven (tests/test_period_tracker.py, 14 tests): fixtures shaped
like the prod breakage — broadband fundamental + 1/4-frequency modulation
at comparable amplitude + noise locks the shedding band on BOTH of two
different window samplings (legacy locks ~0.135 on both; the lottery is
reproduced and killed); an in-band sub-harmonic-DOMINANT peak still
resolves to the fundamental via rule 2; continuation budget guard sizes
the chunk off the in-band period and ships the honest point (the prod
rejection path); frame_track single-source-of-truth ignores the
out-of-band modulation; ambiguous drift warns + uses the shorter period
end to end; clean periodic / no-flow-context / no-shedding behavior pinned
unchanged as false-positive guards. All six must-catch classes verified to
FAIL with the band disabled (pre-fix simulation) and pass with it. Engine
suite: 267 passed (253 baseline + 14), 6 deselected.

Adversarial verification addendum (same day): an old-vs-new replay
(HEAD-worktree legacy tracker vs banded tracker, prod-shaped broadband
signal with narrowband phase-drifting modulation) reproduced the lottery —
legacy locked 0.033/0.135/0.10-0.37 s across 20 identical-physics
realizations (3/11/6 split), banded locked the 0.0339 s fundamental 20/20
within ~5%. Verification also found and fixed three out-of-band honesty
defects in the banded search (genuinely long-period phenomena, e.g.
bluff-body-like St < 0.05):
5. IN-BAND SPECTRAL CREDIBILITY GATE (`IN_BAND_CREDIBILITY_FRACTION`=0.05):
   an in-band period may only be locked when the band contains a real
   spectral LINE — an interior local FFT peak at >= 5% of the strongest
   spectral magnitude anywhere. Pre-fix, a clean St 0.04 signal (T=0.100 s)
   was silently reported as 0.0799 s (the band-edge Hanning leakage skirt,
   corroborated by the rising autocorrelation slope), and a noisy one
   minted 0.0117 s (8.5x short) from a noise wiggle on the sloping in-band
   autocorrelation. The in-band-argmax fallback in `dominant_frequency`
   (slope, not peak) was removed for banded searches. Post-fix these grade
   as None — no lock, honest {no measurable period} — while legit St
   0.05-0.06 (thick-airfoil) cases still resolve to <0.1% error.
6. AC/FFT UNDERCUT GUARD (`AC_FFT_UNDERCUT_TOLERANCE`=0.25): at
   modulation/fundamental amplitude ratio ~2 the in-band autocorrelation
   ripple peaks ride the out-of-band modulation's correlation slope and
   were dragged 30-36% SHORT of the fundamental, unflagged. The refined lag
   must now agree with the credibility-gated FFT line (may not undercut it
   by >25%); a dragged lag falls back to the corroborated FFT line, else
   None. Asymmetric: an autocorrelation period LONGER than the FFT line
   stays trusted (harmonic-rich signals). Known conservative edges: St
   exactly at the 0.5 band edge and shedding lines >~20x weaker than an
   out-of-band modulation line grade as no-lock (disclosed) rather than
   guessed; an in-band harmonic >= 80% of the fundamental's FFT magnitude
   could still halve the period in the pure-FFT chain (rule-2 design
   trade-off; the autocorrelation-primary `estimate_period` paths require
   ~3x amplitude for the same flip).
Recall of the fixes proven the same way: 3 new must-catch tests (band-edge
leakage lock, noise-minted period, slope-dragged period) fail on the
pre-fix code and pass post-fix; a near-band-edge low-St false-positive
guard passes in both worlds. Engine suite: 271 passed (253 baseline + 18),
6 deselected; node typecheck 6/6 with zero node-side diff.

## 2026-07-08 — Cl_max refinement objective: third lane type (clMax / cl_max)

Decision (user-approved plan parsed-painting-ocean): campaigns gain the third
iterative refinement objective — the angle of maximum lift — alongside ld_max
and cl_zero, reusing the objective-generic lane machinery end to end.

1. IDENTITY: id `clMax`, key `cl_max`, label "Cl_max", chip `Cl_max ±0.10°`.
   Added to `CAMPAIGN_OBJECTIVES`; the lane/step tables' plain text objective
   columns needed no DDL.
2. FINE TARGET `alphaClmaxFine`: computed exactly like `alphaLdmaxFine` —
   golden-section argmax of the LOWESS-evaluated Cl bracketed ±1 sample step
   around the coarse argmax, rounded to 0.01°. NULL when the coarse argmax
   sits on the evidence-range boundary (lift curve still rising at the edge —
   stall not bracketed; honest absence, never an extrapolated value, and the
   API detail service does NOT substitute the coarse peak the way it does for
   pre-v2 alphaLdmaxFine). `POLAR_FIT_VERSION` evidence-lowess-v2 → v3;
   existing fits refresh lazily on next ingest per revision. Migration 0035
   adds nullable `polar_fit_sets.alpha_cl_max_fine`.
3. SYMMETRIC AIRFOILS: Cl_max is a real nonzero-α target — lanes take the
   ld_max α ≥ 0 clamp branch in laneTick, NEVER the cl_zero
   `symmetric_definition` shortcut (the ensureCampaignLanes CASE stays
   cl_zero-only). Locked by launch-lane and laneTick-level tests (negative
   fine target −1.5° must iterate at the clamped 0° representative).
4. DEFAULTS: toleranceDeg 0.10, maxRounds 8 (same as ld_max — the Cl curve is
   flat near its peak, so α(Cl_max) is ill-conditioned; tighter defaults would
   burn rounds for negligible Cl gain). Wizard-adjustable per campaign.
5. BACKWARD COMPATIBILITY (implementation decision surfaced during build):
   plan revisions stored before clMax have no objectives.clMax block. Absence
   = disabled-with-defaults everywhere — API zod defaults the block,
   normalizeCampaignPlan substitutes DISABLED_CLMAX_OBJECTIVE,
   classifyPlanChange falls back for the OLD plan side (this is the exact
   path that lets the running production campaign gain the objective live via
   Edit angle plan), and all web plan readers treat `clMax` as optional.
6. STALL-REGION EVIDENCE: no new machinery — near-peak points classify
   through the existing fidelity ladder; `insufficient_evidence` / `stalled`
   / `awaiting_seed` already state the truth, same as ld_max.

Verified: typecheck 6/6; core 85 (82+3: analytic 8.3° peak within 0.02°,
0.01° rounding, boundary-argmax null), api 89 (12-lane 2×2×3 launch +
symmetric cl_max awaiting_seed; laneTick clamp e2e; legacy plan-edit enable;
single-current refresh invariant), web 196, sweeper 124 (both sweeper
campaign fixtures now carry explicit clMax-disabled blocks).
Migration 0035 applied to dev :5544 after a verified pg_dump backup.

Independent verification pass (same day) confirmed the above and added:

7. PLAN-EDIT PROOF: new api tests launch a campaign, strip the stored
   revision's objectives.clMax jsonb block (true pre-clMax artifact), then
   preview → apply enabling Cl_max: classifyPlanChange survives the absent
   block, objectiveDeltas reports exactly [cl_max enabled ±0.10°], and
   applyPlanEdit materializes the cl_max lanes for every airfoil×condition —
   symmetric included, awaiting_seed, never symmetric_definition.
8. DEFECT FOUND AND FIXED — single-current invariant on version bumps:
   polar-cache storeFit un-currented only rows of the CURRENT fit version, so
   every POLAR_FIT_VERSION bump (v1→v2 before, v2→v3 now) left the stale
   prior-version row co-current with the freshly refreshed one; the airfoil
   detail fitByRevision map and Browse catalog metrics pick among current
   rows with no version tie-break → nondeterministic stale-fit serving.
   Reproduced on dev with real evidence (v1+v3 both current after a lazy v3
   refresh). Fix: storeFit now retires EVERY current row for the
   (airfoil, revision) pair; migration 0035 gained an idempotent repair that
   un-currents all but the newest current row per pair (applied to dev;
   0 double-current pairs remain). Regression test proves recall: with the
   old behavior the new api test fails "expected 2 to be 1".
   laneTick was never exposed (ORDER BY createdAt DESC LIMIT 1).
9. RECALL SPOT-CHECKS: reverting the laneTick fine-target ternary makes the
   clamp tests fail (awaiting_seed / insufficient_evidence instead of
   iterating / converged_final — which also demonstrates the null-tolerant
   degradation path for pre-v3 fit rows: honest lane states, no crash).
   Real-data probes: lazy v3 refresh persisted alpha_cl_max_fine 11.9 / 13.49
   on interior-peak airfoils and an honest NULL where the coarse argmax sits
   on the +20° sweep edge.

## 2026-07-08 — Rejected-bucket semantic split, auto-retry-once, URANS continuation (node side; approved mockup c19fd74a)

Decisions (node implementation of amendments A/B/C; web dashboard is a
separate lane; engine continuation restart is the parallel python lane):

1. SEMANTIC SPLIT (A) is DERIVED LIVE, never stored: one canonical SQL
   predicate (packages/db/src/urans-ladder.ts) — awaiting_urans = terminal,
   non-derived, done+rejected at fidelity 'rans' (NULL = 0034-backfill rans);
   needs_review = terminal failed (derived symmetry mirrors EXCLUDED — see
   the review-fix entry below: the red chip's count must equal its Points-tab
   click-through, which lists source rows only; repairing the source repairs
   the mirror) OR done+rejected urans_* with NOTHING FURTHER SCHEDULED (no open
   verify item, no open request-URANS item covering the cell — exact angle or
   whole-polar NULL aoa; an in-flight re-solve already left the done+rejected
   shape, and a rejected wave-2 child never earns a second gated retry).
   Rationale: the rule reads cross-table scheduling state (verify queue,
   requests) that changes without ingest events — stored counters would go
   stale; deriving keeps sim_campaign_progress untouched. needs_review counts
   ALL surviving failed rows, not only marker-carrying ones: with auto-retry
   once, any row still failed has consumed its retry or predates the feature,
   and counting only marked rows would hide pre-feature failures from the only
   surface that shows them. Payloads: campaignSummary (campaign + per
   condition), listCampaigns items, campaignAirfoilRows per-cell (matrix
   recolor), point-history filters awaiting_urans / needs_review (+ counts,
   per-item reviewBucket), 'rejected' kept as a deprecated alias.
2. AUTO-RETRY-ONCE (B) marker = results.auto_retried_at (migration 0036), on
   the durable cell row — NOT a retry-job payload marker: the retry is not a
   composed job (row returns to pending; ordinary gap finders re-claim), and
   the ingest upsert never writes the column, so the marker survives re-ingest
   of the same failed job (a replayed crash escalates instead of earning a
   second silent retry; marker is never cleared on success — one automatic
   retry per cell lifetime, bounded by construction). Runs in reconcile AFTER
   every polar-cache refresh (at-ingest verdict preservation, prod row
   741db07a class) and AFTER submitUransRetryForJob (wave-2-claimed angles are
   queued, so the two retry mechanisms cannot double-schedule a cell). The
   requeue also re-derives campaign status: the completion probe flips a
   campaign to 'attention' the instant its last point terminal-fails, BEFORE
   the retry reopens it — without the active flip the requeued points were
   invisible to the gap finder (caught by the auto-retry must-catch suite).
3. CONTINUATION (C) extends sim_urans_requests (migration 0037:
   continue_from_result_id FK SET NULL + budget_override_s int) instead of a
   sibling table: fidelity, idempotency (one open item per cell+fidelity) and
   precalc scheduler rank carry over unchanged. POST /api/admin/urans-requests
   accepts { continueFromResultId, budgetOverrideS } and derives cell + tier
   from the SOURCE row (422 without engine_job_id/engine_case_slug — no saved
   case state means no honest resume). The ladder tick composes
   { continue_from: { engine_job_id, case_slug }, budget_override_s } into the
   engine request (typed in engine-client PolarRequest) and pins both on the
   sim_job requestPayload. Continuable detection for the UI: rejected urans_*
   row + engine ids + quality warning containing the pinned budget-stop marker
   "stopped by the wall-clock budget guard" (URANS_BUDGET_STOP_MARKER,
   packages/core/src/urans-quality.ts — engine phrasing drift is a cross-side
   test failure) → point-history page items + story ship `continuable`.

Verification: pnpm typecheck green (6 workspaces); core 85, api 101
(baseline 85: +10 review-bucket matrix incl. a recall must-catch that settles
the verify item/request and asserts the buckets MOVE, +2 continuation
endpoint), sweeper 129 (baseline 124: +3 auto-retry lifecycle must-catch,
+2 continuation payload pins). Migrations 0036/0037 applied to dev :5544
after a verified pg_dump backup (test-restored, 50 tables). Behavior change
pinned in updated legacy tests: a first genuine engine failure now requeues
once (pending + marker + message kept) and only the second terminal-fails.

## 2026-07-08 — Web dashboard lane (D/E) + adversarial-review fixes F1–F5

Web lane (amendments D/E, approved mockup c19fd74a): campaign detail gets a
pipeline hero (single stacked progress bar with a violet awaiting-urans
segment + phase line) with technical detail behind a details disclosure;
CampaignsHub cards carry the red "needs review · N" chip linking to the
Points tab pre-filtered; Points tab renames the filter chips to the semantic
split and adds repair actions on needs-review rows — Retry (requeue) for
failed/crash rows, Continue +2h / +6h (continuation POST) for continuable
budget-stopped URANS rows; the coverage matrix recolors awaiting-urans cells
violet. RequeueDialog was removed in favor of in-panel actions.

Adversarial review of the combined diff confirmed five defects; all fixed:

1. F1 (recall gap, amendment C): only the between-chunks budget projection
   guard emitted the continuable marker. A chunk killed by the ACTUAL solver
   wall-clock timeout (returncode 124) graded "timed out … partial window"
   without the marker, yet leaves the same restartable case — the UI offered
   only a from-scratch requeue. Fix: pipeline.py now owns
   URANS_BUDGET_STOP_MARKER (same literal as urans-quality.ts) and embeds it
   in ALL wall-clock-stopped grades that leave restartable state: the
   projection guard, the mid-chunk timeout partial grade, and a timed-out
   continuation chunk (new TransientTimeoutError distinguishes timeout from
   crash/divergence — crashed chunks must NEVER claim continuable, since
   resuming a diverged case integrates garbage; false-positive guard test).
2. F2 (one-sided contract pin): no engine test pinned the marker phrase —
   rewording the sentence would silently zero node continuable detection.
   Fix: tests/test_continuation.py pins the literal; the timed-out MUST-CATCH
   and both frame-track budget/chunk tests assert the marker in the grade.
3. F3 (doomed requests): API zod accepted budgetOverrideS up to 48 h while
   the engine caps at URANS_BUDGET_OVERRIDE_MAX_S = 86 400 (24 h) — a 24–48 h
   override queued, then 422-ed at engine submit and cancelled. Fix: zod max
   aligned to 24 h; test pins 24 h accepted / 48 h rejected up front.
4. F4 (fresh solve presented as resume): idempotency is per (cell, fidelity),
   so a continuation POST could silently reuse an OPEN non-continuation
   request — the admin believed a resume was queued while a from-scratch
   solve ran. Fix: the API now 409s with an honest message when the reused
   open item is not a continuation of the named result (matching replays
   still reuse with created=false); the panel surfaces the 409 message.
5. F5 (chip > click-through): needsReview counted terminal failed points
   INCLUDING derived symmetry mirrors while the Points tab needs_review
   filter lists source rows only — on symmetric airfoils the red chip
   exceeded its own list. Fix: the failed arm of NEEDS_REVIEW_POINT_SQL now
   excludes derived mirrors (both arms non-derived); MUST-CATCH test inserts
   a terminal derived mirror of a failed source and asserts chip == list.
   NOTE (pre-existing, unchanged): the legacy `failed` counter still counts
   mirrors; its click-through has the same historic skew — out of scope here,
   flagged for a follow-up.

Verification of the review-fix pass (same day, no commit yet): pnpm typecheck
6/6; core 85, api 104 (+3: derived-mirror needsReview must-catch, budget-cap
bounds, continuation/fresh-request 409), sweeper 129, web 226; engine pytest
286 (-m "not integration"; +4 marker pins incl. chunk-timeout continuable and
chunk-crash false-positive guard). e2e (local-solve openfoam-* specs skipped,
engine :8000 intentionally down in remote-solving mode): 23 passed / 2
conditional skips after updating campaign-management.spec for the shipped
D-design (plan-edit verbs behind the "⋯" overflow; objective chips behind the
details disclosure). The details disclosure was made URL-owned (?cdetails=1,
same replaceState contract as ?flog=1) — both to honor spec §11 and to give
the formal UI verifier a direct render path; pinned in the refinement-board
e2e (URL asserted + reload stays open). formal-web-ui-verification (dev web
:3004 via coordinator; campaign detail hero, detail+details-open, Points tab;
1440x900 + 390x844): 0 criticals on all 6 renders; document x-overflow false
everywhere; only intentional inner x-scrollers (topbar tabs, section nav,
condition strip, refinement lane-scroll) — the coverage matrix itself has no
x-overflow.

## 2026-07-08 — Precalc established-oscillation gate + wave-1 in-job escalation off (engine)

User decision (verbatim): "the solution should converge to a stable
oscillation" — for the PRECALC fidelity tier only, the stationarity verdict
became an ESTABLISHED-OSCILLATION test instead of the strict 5% two-half
mean-drift gate (prod: established modulated limit cycles with drift_frac
~0.14 bounced forever at tier 1 even though the oscillation was honest).
FULL fidelity keeps the strict gate byte-identical ("verified" = converged
mean).

1. Test definition (src/airfoilfoam/postprocess/unsteady.py): per-cycle Cl
   means m_1..m_K over the K whole retained periods (integer-cycle
   sub-windows of the stats window, same time-weighted trapezoidal mean as
   the drift halves). stationary(precalc) = NO monotonic trend AND period
   stable (the existing half-window PeriodEstimate.ambiguous check, passed in
   by the pipeline) AND amplitude bounded (the oscillating-steady
   OSCILLATING_AMPLITUDE_GROWTH_MAX=1.3 half-window peak-to-peak guard) AND
   K >= 3. Trend test (_cycle_mean_trend): TRENDING iff |net| = |m_K - m_1|
   >= 2% of the drift scale (same denominator as drift_frac; femto-noise
   floor) AND (all successive diffs share one strict sign AND |net| >= 3.0 x
   the dof-adjusted rms residual about the least-squares line, OR |net| >=
   4.0 x that residual — the slow-drift guard for drifts whose noise flips
   one cycle mean). The 3.0 monotone threshold is deliberately ABOVE the K=3
   collinearity bound net/s_resid = 2.449 (monotone geometry pins d = interior
   deviation from the endpoint chord < |net|/2, s_resid = d*sqrt(2/3)):
   below 2.449 every monotone triple would trend and the significance clause
   would be vacuous. At 3.0 a monotone-by-luck triple with d > 0.408|net| is
   accepted; smooth relaxations (geometric decay ratio rho > 0.105) reject.
   A slow smooth modulation (period >> 3 cycles) still rejects at K=3 — it is
   genuinely indistinguishable from a relaxing drift; rejection escalates to
   the full tier (conservative direction).
2. Disclosure, no contract change: acceptance appends the quality warning
   "cycle means scatter ±<std m_i> over K cycles (precalc)". The strict
   cross-runtime frame_track parser rejects new keys, so cycle_means /
   cycle_mean_std / stationary_reason live only on the engine-side
   PeriodWindowStats; the verdict travels through the existing `stationary`
   boolean + warning text.
3. Wiring (src/airfoilfoam/pipeline.py): period_window_stats gained
   keyword-only established_oscillation + period_stable; the frame-stats call
   passes established_oscillation=(urans_fidelity == precalc) and
   period_stable=(not frame_estimate.ambiguous). Default args keep every
   existing caller/fixture byte-identical (full suite verdicts unchanged).
4. Second fix — live incident (wave-1 sweep job 20b67295, s1223 -5 deg /
   25 m/s / 1.0 m, 7+ failed and climbing): node wave-1 jobs already ship
   transient_fallback=false (apps/sweeper/src/build-request.ts has sent
   `transient_fallback: wave === 2` since 2026-06-30 — checked, no node
   change needed), but the ENGINE ignored the flag in solve_polar_marched's
   attached-range abort: a rejected RANS point inside 0-5 deg promoted the
   WHOLE polar to in-job URANS (transient_fallback/force_transient forced
   true) with no tier fidelity, no precalc mesh, no ladder budget — startup
   divergence, watchdog kills, honest-failed points that the gated ladder
   would have handled. The promotion is now gated on
   solver_params.transient_fallback: campaign/sweep wave-1 ships the honest
   rejected-RANS point (ladder tier-1 evidence) and the node ladder owns
   escalation; direct-API requests (engine default transient_fallback=true)
   keep the in-job promotion.
5. Tests (tests/test_established_oscillation.py, 17): must-catch relaxing
   startup (exp + collinear ramp) rejects; established modulated
   (drift_frac ~0.10 unit / ~0.15 pipeline, old gate provably rejects)
   accepts with the scatter warning; clean periodic passes both gates;
   growing envelope with trendless means rejects (the drift gate MISSED this
   class); K=3 edges both directions incl. the documented d = 0.408|net|
   boundary and the femto floor; K=2 not certifiable; full-tier verdicts
   pinned drift-only (period_stable must not leak). Wave-1 must-catch:
   marched reject at aoa=2 with transient_fallback=false never calls
   _run_full_urans_replacement (recall proven: test fails on reverted gate),
   default-params promotion preserved (false-positive guard). Engine suite
   286 -> 303, all green. Engine rebuild required for deploy.

## 2026-07-08 — Failed counter excludes derived symmetry mirrors (canonical counter model amendment)

- Defect (user-directed fix): the canonical `failed` counter
  (sim_campaign_progress recompute, packages/db/src/campaign-execution.ts,
  BOTH sites: recomputeProgressForKeys + recomputeProgressForCampaign) counted
  every terminal point linked to a failed results row — INCLUDING derived
  symmetry mirrors, which onResultIngested terminal-links to the SAME failed
  +α source row. Two user-visible consequences on symmetric airfoils:
  1. Chip > click-through: the failed chip counted source + mirror while the
     Points tab failed filter lists source results rows only.
  2. Arithmetic double-count: a failed source's mirror is terminal+derived
     (already in `derived`) AND was in `failed`, so
     remaining = requested − solved − derived − failed − rejected undershot
     (hidden by the Math.max(0, …) clamp; per-cell settled sums could exceed
     requested in coverage-matrix math).
- Locked semantics: failed = terminal AND NOT derived_by_symmetry AND
  r.status='failed' (consistent with solved/rejected, and with
  NEEDS_REVIEW_POINT_SQL in urans-ladder.ts which already excluded mirrors
  from both bucket arms). `derived` keeps counting ALL terminal mirrors
  regardless of source disposition — a failed source's mirror sits in
  derived, keeping the remaining identity exactly balanced.
- Gate safety: probeCampaignCompletion's has_failed EXISTS still scans
  mirrors (truth-equivalent — a mirror cannot be linked to a failed row
  without its source being too), so mirror-exclusion in the counter can never
  hide a failure from the attention gate; asserted in the new test.
- MUST-CATCH (apps/api/test/campaigns.test.ts, "failed counter excludes
  derived symmetry mirrors"): symmetric 5-point campaign, fail the +1 source →
  mirror terminalizes; failed == 1 == Points-tab failed list length; unclamped
  identity requested == solved+derived+failed+rejected+remaining holds with
  the mirror present (pre-fix sum = 6 ≠ 5); campaign still flips attention;
  keys-path and campaign-wide recompute agree row-for-row and re-ingest is
  idempotent. Recall proven: suite run against the reverted filter fails with
  failed=2.

## 2026-07-09 — Precalc budget 7200 → 14400 s + in-run march-rate guard + continuation ops

- Evidence (first prod tier-2 wave, production-campaign-20260707): 9/9
  urans_precalc results budget-stopped at the 7200 s budget, zero completed.
  Two distinct classes:
  1. Feasible (naca-4412, Re 171–341k): the between-chunks period projection
     guard stopped early, projecting 2.3–3.1 h of continuation vs the 2 h
     budget. A 4 h budget absorbs this class outright.
  2. Hopeless-at-tier (s1223, c=1 m u=50 m/s, Re 3.4M): t=0.0094 s of the
     0.4 s chunk target in the FULL 7200 s (~85 h projected). No shedding
     cycle ⇒ no measurable period ⇒ the period-based projection guard can
     never engage ⇒ the budget burns blind to the wall.
- Decision 1: URANS_FIDELITY_BUDGET_S[precalc] 7200 → 14400 (models.py +
  engine-client fidelity.ts + pin tests on both runtimes). Full tier stays
  43200. Celery hard limit derives from max(budgets) = 43200 — unchanged.
- Decision 2 (companion, load-bearing for the raise): march-rate guard.
  The pipeline arms every pimpleFoam chunk with march_budget.json
  ({end_t, budget_s, wall_start}); the worker heartbeat's MarchRateWatchdog
  (tasks.py) measures the TRAILING simulated-time rate (900 s window, 600 s
  min span, never during the first 1800 s warmup) and, when the projected
  total wall exceeds 3× the chunk budget, SIGTERMs the case and writes
  march_stopped.json. The grading path routes that marker through the SAME
  honest timeout partial grade — reason carries the march projection evidence
  AND the pinned continuable literal ("stopped by the wall-clock budget
  guard") so the node offers Continue, and the saved state stages for
  continuation (markers never copied into staged cases). Divergence verdict
  wins if both fire; a march-stopped grade sets can_refine=False so the
  extension loop can never clear the verdict and relaunch a doomed chunk.
  Rationale for 3×: a 1.3× over-projection should reach the wall and finish
  via ONE continuation; >3× means even a full continuation cannot finish.
- Guards against false positives (tests/test_march_guard.py, recall-shaped
  from the s1223 breakage, driven through the REAL heartbeat check + kill
  path and the REAL _run_transient_attempt grading seam): warmup never
  judged; dt-ramp-then-recovery passes (trailing window sees only the
  recovered rate); feasible-but-over-budget (<3×) left to grade at the wall;
  completed chunks and zero-rate (stall watchdog's turf) never judged;
  un-armed steady segments skipped; fresh chunks re-arm with a new
  wall_start which resets sampling and any stale verdict.
- UI/ops (same change set): Continue gains a +24h option (cap 86400 s is
  API-inclusive, verified); stale tier-budget copy fixed at six sites
  ("1 h"/"6 h" pre-7200 era → 4 h precalc / 12 h full; pipeline hero
  "~2 h each" → "~4 h each").

## 2026-07-09 — Polar chart: fit-to-data domain, hard clipping, zoom/pan/hover navigation

- User-reported (screenshot, campaign cell panel, CLARK Y Re 3.41M): the polar
  drew OUTSIDE the chart canvas — curve and a solved point left of the y-axis
  over the tick labels, running off both canvas edges.
- Root cause (confirmed by pre-fix coordinate probe: 42 escaped coords per
  α tab, x −93.5..880.4 against plot rect 58..664; Cl–Cd tab 0 escaped):
  packages/core/src/chart.ts hard-coded the α domain to −8..20 (predates
  campaign sweeps −15..30), the out-of-domain guard existed ONLY for clcd,
  and PolarChart had no clipPath. CompareView duplicated the same hardcode
  AND rendered overflow:visible. Detection failure: no core test fed α
  outside −8..20 and no test asserted projected coords stay in the plot
  rect; local UI verification had no CFD rows so charts rendered empty.
- Fix (core-first, all consumers): projectChart α domain is now DATA-DERIVED
  (zoom-to-fit is the default window; −8..20 survives only as the no-data
  fallback); optional ChartDomain override; ALL chart types clip curves in
  data space (Liang–Barsky segments, boundary crossings interpolated, curves
  splitting into visible segments) and filter points; dynamic α ticks.
  PolarChart adds an SVG clipPath (belt-and-braces), wheel zoom about the
  cursor (native non-passive listener), drag pan (3-unit threshold, click
  suppression), double-click fit; PolarViewer adds −/+/fit toolbar buttons,
  a mouse-following badge: point-snap (full point data, 14-unit radius) or
  interpolated per-series readout at cursor α (readoutAtX; hidden on Cl–Cd
  where x is Cd and interpolation is ambiguous). Zoom state lives in hosts
  (DetailIsland, CellSidePanel), resets on chart-type switch. CompareView got
  the same domain/clip/ticks fix (no zoom — no interaction state there yet).
- Guardrails first, recall-proven: packages/core/test/chart-clip.test.ts
  (prod-shaped −15..30 polar, all four chart types, in-rect assertions +
  fitted-window pins + clip/zoom/pan/readout units) — 16/18 fail against the
  pre-fix file, exactly the 2 domain pins fail against a domain-only revert;
  apps/web/e2e/polar-zoom.spec.ts (live-route, 6 tests: in-rect regression,
  wheel zoom + fit restore, buttons, drag pan, snap/readout badges, badge
  follows mouse) — compare fix separately recall-proven via stash run
  (10 escaped vertices pre-fix). Local repro used REAL prod clarky rows
  (insert script + capture script in session scratchpad; local dev DB only).
- Verification: core 103/103, web 226/226, e2e 6/6, typechecks clean,
  formal-web-ui-verification desktop+mobile on the fixed route: 0 critical.
  After-fix coordinate probe: 0 escaped coords on all four tabs.

## 2026-07-09 — Lane-step churn: append on target movement, not on fit refresh

- User asked what "superseded" means on the refinement board (clarky ld_max
  Re 3.4M showed rows 5-8 all predicting 7.67° with Δ +0.00°, all amber).
  Semantics are correct — superseded = the best fit was re-derived from newer
  evidence and the target α moved before that predicted point was solved —
  but the DB held TWENTY-ONE steps for that lane, twelve of them identical
  7.67° rows: laneTick's `advances` fired on `fitSetId` change alone, so
  every tier-2 ingest (fit refresh) appended another identical step; all
  twelve were swept to 'superseded' at once when the target finally moved.
  Rounds accounting was NOT affected (iterationCount increments only on
  enqueue), so no lane stalled from this — pure evidence-table noise.
- Fix: `advances` = predicted α moved (canonical compare) — a refreshed fit
  with an unmoved argmax appends nothing; `fitStable` becomes TARGET
  stability (advances || last step at the same canonical α) because the old
  fit-id equality test would deadlock convergence once same-α refreshes stop
  appending witness steps. Convergence through a same-α refresh is asserted
  in the new test.
- Display: RefinementBoard collapses historical consecutive unsolved
  same-α 'superseded' runs into one row ("5–16 … superseded ×12 fit
  refreshes") via pure helper apps/web/lib/lane-steps.ts (append-only step
  evidence stays untouched); tooltip on the outcome explains supersession.
- Recall-proven: apps/api/test/campaigns.test.ts churn describe (4 tests,
  prod-shaped) — reverting `advances` fails 3 of them; restored 42/42.
  Collapse helper pinned by apps/web/test/lane-steps.test.ts (prod 21-step
  fixture → 9 rows; never merges solved/distinct-α/non-superseded).

## 2026-07-09 — Catalog metric sorts: NULLS LAST + honest null DTO

- Repro: GET /api/airfoils?sort=thickness&dir=desc listed 21 metric-less
  campaign/test-artifact rows (thicknessPct serialized as 0) before
  FX 79-W-660A (66.39%). Two defects: postgres DESC defaults to NULLS FIRST
  and the geometry sorts (thickness/camber/area) never overrode it; the
  summary DTO coalesced NULL geometry metrics to a fake 0 (banned — and
  camber 0.0 is REAL on symmetric airfoils, so 0-vs-missing must stay
  distinguishable).
- Fix: ORDER BY <metric> {ASC|DESC} NULLS LAST for the three geometry sorts
  (solved-metric sorts ldmax/clmax/cdmin already sent missing values last
  in their in-memory comparator); AirfoilSummary.thicknessPct/camberPct/
  camberPosPct/areaProfile are now number|null end-to-end — Browse t/c,
  CAMB, AREA cells render "—" via the existing solvedMetric idiom,
  AirfoilSelector shows "—", search ranking excludes unknown t/c when the
  constraint is on (same policy as clmax/cdmin), CompareView geometry rows
  were already null-typed.
- Must-catch (apps/api/test/catalog.test.ts): artifact-shaped NULL-metric
  fixture + real rows → desc/asc thickness, desc camber, asc area all keep
  the artifact LAST; DTO nulls asserted (not 0); HTTP leg uses the exact
  reported URL shape. Recall-proven: reverting the ORDER BY fails the test.
- Live verify (local dev, 1640 rows): desc first = FX 79-W-660A 66.39, all
  19 null rows contiguous at the tail as null; asc nulls also last; browse
  row for an artifact shows "—"/"—" in t/c and CAMB.

## 2026-07-09 — Bulk resume from the needs-attention page

- User report: the needs-review Points view showed only budget-stopped
  rejections with no visible way to resume; the per-row Continue lives in
  the story panel (click a row) and there was no bulk path at all.
- Shipped: POST /api/admin/urans-requests/bulk-continue
  {campaignId?, budgetOverrideS 60..86400} — queues a continuation for
  EVERY continuable needs-review row (budget-stop marker + saved engine
  case state; selection = NEEDS_REVIEW ∧ CONTINUABLE SQL reused from the
  point-history payload), through the same idempotent per-(cell,fidelity)
  request machinery as single-row Continue. Non-continuable rejections
  (crashes, non-budget quality rejects) are excluded server-side — they
  have no restartable state. Response {continuable, created, reused,
  conflicted}. Web: RESUME ALL +2h/+6h/+24h control on the Points toolbar,
  visible only under the needs_review filter, campaign-scoped via the
  pcampaign filter, window.confirm + outcome notice
  ("queued N · … — non-resumable rows are excluded").
- Hermetic recall-proven test (urans-requests.test.ts): fixture campaign
  via the real launch API; 2 budget-stopped + 1 non-budget rejected rows →
  {continuable:2, created:2}; replay → zeros with request table unchanged
  (queued cells leave needs_review — bucket-level idempotency); foreign
  campaign sweeps nothing; dropping the marker filter fails the test.

## 2026-07-09 — Measured: why precalc URANS is slow (evidence for the mesh-tier decision)

- Measured on prod (S1223 c=1 u=50 Re 3.4M "heavy" vs NACA 4412 c=0.1 u=50
  Re 341k "light", both precalc 7,600-cell meshes, both SERIAL 1-core):
  heavy 1.9e-6 sim-s/wall-s (~59 h/point), light 6.8e-6 (~5.8 h) — ×9.9 =
  ×2.81 (endTime ∝ chord via shedding period) × ×2.23 (steps) × ×4.45/2.8
  (per-step cost). Per-step gap is ENTIRELY pFinal GAMG: heavy saturates
  the 1000-iteration cap on all 3 PIMPLE outers every step (near-wall
  aspect ratio ~2,100 at c=1) vs ~190 iters converged on light.
- Root structural fact: derive_precalc_mesh_params halves n_surface/
  n_radial/n_wake but keeps target_y_plus=1 → first-layer height ~1.4e-5 m
  regardless of chord → Courant-capped dt ~2e-6 s (Courant MAX 4.0 pinned
  at the wall cell while Courant MEAN is 4e-4 — the whole domain marches
  10,000× slower than it needs except one cell). Precalc saves cells (×4)
  but not the time step. TRANSIENT_WALL_YPLUS=40 wall-function remesh
  exists in the engine but only on the no-shared-mesh fallback path.
- Contention measured: ×1.45 per-step when 6 sibling cases share the box.
- Proposals (pending user approval; ranked): (A) precalc tier goes
  wall-function y+≈40 (dt ×~30, kills the GAMG stiffness; est. heavy point
  59 h → <1 h; full tier keeps y+=1); (B) fix pFinal cap saturation
  (relTol/maxIter/GAMG tuning — ×3 on heavy even alone); (C) precalc
  maxCo 4→8 (×2, cheap, composable); (D) solver_processes 2-4 for
  single-case continuation/request jobs (cores idle at queue tail).

## 2026-07-09 — Implemented A+B: precalc wall-function mesh + pressure-solver fix

- A (approved): derive_precalc_mesh_params now sets target_y_plus = 40
  (URANS_PRECALC_WALL_YPLUS, = pipeline.TRANSIENT_WALL_YPLUS) and CLEARS any
  explicit first_cell_height_chords so the y+ target actually resolves per
  case (an explicit low-Re height would short-circuit resolve_mesh_params).
  Turbulence BCs needed no change — nutUSpaldingWallFunction +
  omegaWallFunction are already all-y+. First-layer height is linear in y+
  (pinned: height(40)/height(1) == 40 exactly), so the Courant-capped dt
  lifts ~40x and the AR~2100 pressure stiffness disappears. Mesh cache keys
  on resolved params → precalc meshes regenerate under new keys; full tier
  and RANS untouched. Caveat noted: precalc + sand-grain roughness (Ks >
  y+40 height) would need its own guard — smooth-wall campaigns unaffected.
- B: transient fvSolution p/pFinal smoother GaussSeidel → DICGaussSeidel
  (symmetric matrix, standard for stretched layers); pFinal tolerance
  1e-7 → 1e-6 (measured cap-saturation sat at 2.7e-7..8.4e-7 after 1000
  capped iters; 3 PIMPLE outers provide remaining contraction). Steady
  solver dicts untouched (pinned by test). Helps the full tier too (still
  y+=1 at chord 1 m).
- Authored by two Codex CLI (gpt-5.5, xhigh) lanes under precise specs;
  reviewed line-by-line here. Tests: tests/test_fidelity_tiers.py (y+40,
  cleared explicit height, 40x ratio, resolve-level check, cache-key
  separation), tests/test_transient_fvsolution.py (transient pins + steady
  unchanged guard). Engine suite 317 passed; sweeper contract pins 21/21.
- Continuations resume SAVED meshes: in-flight +6h resumes stay on y+=1;
  fresh retries (incl. march-guard re-rejects) pick up the new mesh.

## 2026-07-09 — Wall-function mesh follow-ups: startup dt cap + extension continue-gate

- New-mesh validation surfaced two behaviors (both measured on prod):
  1. Fresh-transient startup blowups at c=1 (s1223 25° and 7.49°, jobs
     0cba5e9b/7ff36caf): calm start (Co 0.53) then the adaptive controller
     grew dt 1.2x/step toward the NEW Courant-4 ceiling (~40x above the
     initial dt guess) and outran the developing separated flow —
     |Cl|→1e156..1e163 by ~step 10, dt collapse to 1e-85, honest watchdog
     kill (auto-retry same). On the old y+1 mesh the ceiling sat BELOW the
     initial dt so the growth dynamics never engaged. Fix:
     STARTUP_MAX_DELTA_T_FACTOR=2.0 — the FIRST fresh chunk caps
     maxDeltaT at 2x the period/5000 guess (Co ≲ 1 through startup);
     resumed/extension/refined chunks keep their measured-period caps.
  2. Extension loop exited with hours of budget left (naca-4412 −15° u=100:
     retained 2.00/3.00 cycles, 19.5 frames/cycle, 26 min of a 4 h budget,
     honest reject). Root cause: _extend_transient_until_periods treated
     ANY can_refine=False as terminal. Fix: _quality_allows_more_integration
     — measured-period windows blocked only by retention/frame-rate/
     stationarity (all fixed by more integration; extension chunks write at
     period/20) continue until the existing budget projection guard stops
     them; no-shedding, missing/unmeasurable period, budget-stop, timeout,
     crash, divergence still break immediately.
- Codex CLI (gpt-5.5 xhigh) lane under forensic spec; reviewed here.
  Engine suite 319 passed (must-catch: fresh first chunk receives the
  capped maxDeltaT; under-retained/sparse/non-stationary window extends;
  resume maxDeltaT==writeInterval pinned).
- Validation tally to date (new mesh): s1223 30° Re 3.4M ACCEPTED in 6 min
  (oscillating-steady; old projection 57–59 h); naca-4412 −15° u=100 ran
  2.0 cycles in 26 min (old: 0.9 cycles in 2 h).

## 2026-07-09 — RETENTION_SAFETY_CYCLES: loop/gate whole-cycle alignment

- Post-startupramp validation: naca-4412 −15° u=100 rejected at exactly
  "retained cycles 2.00 < 3.00" a SECOND time (span-retention ~2.8, new
  engine). Root cause: the extension loop breaks on FRACTIONAL span
  retention ≥ target while the quality gate counts INTEGER whole cycles —
  span 2.9 grades as 2. Fix: RETENTION_SAFETY_CYCLES = 0.6 — the loop
  targets (and sizes chunks for) target + 0.6 cycles so the integer
  boundary is always crossed. Tests updated to pin the margin sizing.

## 2026-07-09 — Performance arc closed: final validation state

- Startup crash class ELIMINATED: both previously-diverging heavy cells
  (s1223 25°/7.49°) re-ran complete jobs under the startup dt cap with
  zero divergences; campaign failed-count 0 sustained.
- Wall-function precalc validated at class level: 12 precalc results in
  the first 4 h (2 accepted avg 11 min, 5 provisional avg 70 min, 5
  honest quality rejects avg 28 min, 0 failures, 0 budget burns) — the
  59-hour heavy class now solves or honestly rejects in minutes.
- RETENTION_SAFETY_CYCLES margin: pinned by tests; the live sentinel
  (naca-4412 −15° u=100) could not prove it end-to-end because its
  period lock is run-to-run inconsistent at precalc resolution (second
  run: "missing or flat shedding history") — an honest physics limit,
  not a mechanism failure. Cells of this shape belong to the full tier
  (request-URANS) or stand as documented steady values; no further
  precalc tuning warranted on single-cell evidence.

## 2026-07-09 — Forensics round: two stacked bugs behind the heavy-chord "missing or flat" pile

- VPS forensics (3 cells + code cross-check) EXONERATED the wall-function
  mesh and both physics hypotheses. Real causes:
  1. ZERO-STEP RESTART: the in-case 600-iter simpleFoam init leaves
     uniform/time deltaT=1 s (pseudo-time); latestTime restart restores it
     (controlDict overridden, setInitialDeltaT skipped at timeIndex!=0) and
     Time::run()'s `value < endTime - 0.5*deltaT` is false for any target
     span <= 0.5 s → pimpleFoam exits with ZERO steps ("Starting time
     loop"→"End", Courant mean 167/max 31446 fingerprint) and the grader
     consumes the init's pseudo-time segment → "missing or flat" in
     minutes. Hit every freestream-fallback cell with span 20c/u <= 0.5 s.
  2. STROUHAL BAND CLAMP: the surviving class (c=1 u=25, span 0.8 s)
     integrated 4 nominal periods and shed a constant-amplitude ±0.1 Cl
     limit cycle at 17.6 Hz = chord-St 0.70 — post-stall shedding scales
     with PROJECTED HEIGHT c·sinα (St_h≈0.18, textbook) — but the
     chord-based band (0.05,0.5) capped at 12.5 Hz → real peak discarded →
     "missing or flat" → extension forbidden. A correct measurement graded
     unmeasurable.
- Fixes (Codex gpt-5.5 xhigh, reviewed): init-only uniform/time sanitize
  (rewrites deltaT/deltaT0 to the transient initial dt after
  log.simpleFoam.init, before the first fresh attempt; chunk restarts and
  continuations untouched — pinned by tests); α-aware shedding band via
  projected height h = c·max(sin|α|, 0.15) widening the HIGH-frequency
  ceiling only (low side stays chord-based; sub-harmonic 80% rule,
  credibility and undercut gates intact); α threaded through every band
  consumer. Must-catch: dt=1 uniform/time regression; chord-St-0.70
  fixture measures ~0.057 s (was None); α=2 preserves old band; noise
  still None; lottery fixtures still pass. Engine suite 335 passed.

## 2026-07-09 — Freestream fallback skips the short init (final startup layer)

- With the zero-step bug fixed, the s1223 c=1 fallback transients RAN and
  detonated on their first steps (t=600.00x, |Cl| 1e131..1e162, 11 cells):
  the 600-iter in-case simpleFoam init at steady-hostile conditions
  produces its own violently oscillating field (init Cl amp 2..4) and the
  transient inherits it — the zero-step bug had been shielding this. The
  init is a warm-start optimization with no advance way to know when it
  turns harmful.
- Fix: freestream_fallback flag — when the full steady seed was refused,
  _prepare_transient_case keeps the pristine 0/ freestream fields and
  skips potentialFoam + simpleFoam.init entirely; transient starts at
  t=0 (pseudo-time-600 axis and uniform/time hazard vanish on this path).
  Standalone no-seed cases keep their init (pinned); warm seeds unchanged;
  dt cap/march guard/watchdog unchanged. Engine suite 337 passed.
- Wave tally before this fix (post-shedband re-solves): 13 accepted
  (avg 8 min), 12 honest quality rejects — 24/25 graded cells with real
  measured periods (was 0/25 before the band fix).

## 2026-07-09 — cleanstart wave outcome: failure surface zero

- The 12 requeued s1223 c=1 cells re-ran under prod-20260709-cleanstart:
  ZERO failures (global failed count 0 — cells that detonated within
  seconds now integrate normally from pristine freestream). Grades:
  3 accepted (2.34°, 2.45°, 20° oscillating-steady); 5 honest tier-1
  "steady did not converge" rejects whose wave-2 freestream transients
  follow automatically through the ladder. Every startup crash class
  found today (dt-ramp, garbage steady seed, zero-step restart, garbage
  short-init field) is closed with recall-proven guards.

## 2026-07-09 — Correction: fallback keeps potentialFoam (cleanstart addendum)

- The "failure surface zero" call was premature: the 5 tier-1-rejected
  s1223 c=1 u=50 cells' wave-2 transients then detonated on steps 1-2
  even from PURE freestream (t~4e-5, |Cl| 1e53..1e110) — the impulsive
  no-slip start around the extreme-camber section is singular by itself.
  Lane H had dropped potentialFoam together with the SIMPLE init; the
  potential-flow field is the classic impulsive-start cure (smooth,
  irrotational, no iterations, nothing to oscillate). The fallback now
  runs potentialFoam ONLY (SIMPLE init stays banned); tests updated
  (fallback calls == [potentialFoam, pimpleFoam]). Engine 337 passed.

## 2026-07-10 — S1223 heavy-cell failures: mesh degeneracy, loop closed

- After potentialFoam init ALSO detonated on step 1 (as did steady-seed,
  short-init and pure freestream — init-independent), checkMesh on the
  failing s1223 c=1 precalc mesh gave the final answer: max
  non-orthogonality 88.2° (42 cells at AR 2559) — the 40x-thick
  wall-function first layer folds against S1223's deeply concave lower
  surface and the pressure Laplacian is near-singular; any solve diverges
  immediately. Geometry-specific mesher limitation (sd8020/naca-4412 at
  the same chord mesh cleanly and run fine); NOT solver numerics.
- Decision: the ~8 S1223 heavy cells stay honest failures (they are
  genuinely unsolvable on this mesh). No further engine iterations on
  this family. Follow-up (separate work): curvature-aware first-layer
  clamping in the C-grid mesher AND/OR a checkMesh non-orthogonality
  gate at mesh time that fails the case honestly ("mesh degenerate at
  this tier") before burning solver attempts; alternatively route
  concave-cove geometries to the resolved-wall mesh.

## 2026-07-10 — Geometry-aware precalc meshing + checkMesh gate (S1223 family fix)

- Fix A: max_concave_curvature(contour) (arc-length-windowed signed
  curvature, orientation-robust) + PRECALC_WALLFN_MAX_CONCAVE_CURVATURE
  = 2.5/c. Measured on real seed coordinates: s1223 4.889/c (OVER) vs
  naca-4412 0.360, sd8020 0.172, clarky 0.035, naca-0012 0.000 — 13x
  separation. Over-threshold airfoils keep the RESOLVED wall (y+1) at
  the precalc tier with a truthful quality disclosure ("precalc ran the
  resolved-wall mesh: concave geometry ... folds the wall-function
  layer"); the standalone TRANSIENT_WALL_YPLUS fallback gets the same
  guard. Expected S1223 heavy outcome: slow-but-structurally-sound
  integration governed by the march guard/budget (continuable budget
  stops), never detonation.
- Fix B: _run_transient_mesh_qa_gate after transient mesh build/link:
  checkMesh -time 0, fail honestly at MESH time over
  MESH_MAX_NON_ORTHO_DEG=85 ("mesh degenerate at this fidelity tier
  (max non-orthogonality X deg)") or on failed mesh checks; 75-85 deg =
  disclosure warning; gate inability to run is non-fatal (advisory).
- Codex (gpt-5.5 xhigh) lane, reviewed; engine suite 347 passed with
  prod-shaped must-catches (real checkMesh output lines; real seed
  coordinates; no-solver-call-after-gate assertion).

## 2026-07-10 — Mesh-gate task closed: S1223 family parked honestly

- Final prod state: all 8 S1223 heavy cells terminal with the exact
  honest error the task specified — "mesh degenerate at this fidelity
  tier (max non-orthogonality 88.3 deg)" — failing in SECONDS at mesh
  time (no solver burn, no detonations, no watchdog churn). The
  concavity guard verifiably engages on the wave-2 path (worker logs:
  "resolved-wall spacing for concave airfoil S1223: 4.89/c > 2.50/c");
  the checkMesh gate catches the path(s) the guard does not cover.
- Known residual (accepted): at least one submit path still builds the
  wall-function mesh before the guard can divert it; the gate converts
  those attempts into cheap honest failures and the retry chain lands
  on the guarded path — self-healing at the cost of one ~30 s attempt.
  A future pass can thread the geometry guard through that path; not
  worth another rebuild now.
- Operational equivalence note: even fully y+1-guarded, this family
  costs ~50 h/point at precalc (measured 2026-07-09) and would land as
  march-guard budget stops — the honest terminal label differs, the
  outcome (needs full tier or numerics work) does not.

## 2026-07-10 — Per-tier URANS mesh definitions + wall-function full-tier default

- Decision (user question: "final URANS mesh is still y+1 — does it make
  sense? maybe define meshes separately for RANS, URANS, precalc?"):
  per-tier mesh definitions with DERIVED DEFAULTS, and the full URANS
  tier default changes from "request mesh verbatim (typically y+1)" to
  a derived full-resolution wall-function mesh (y+~40, counts/extents
  unchanged, first-cell cleared). Rationale: transient dt is Courant-
  chained to the first wall cell — resolved-wall full tier measured
  ~50 h/point at HALF resolution; shedding physics is governed by
  separated shear layers, so wall-function URANS is standard practice.
  y+1 remains available as an explicit per-tier user choice.
- Contract: PolarRequest gains urans_mesh / urans_precalc_mesh
  (optional; None = engine derives). Explicit meshes are honored
  VERBATIM (no halving, no y+ override, no silent concavity revert) —
  the checkMesh QA gate still protects; disclosure recorded either way.
  Derived paths keep the concavity guard (now both tiers).
- Node: simulation_presets gains nullable urans_mesh_profile_id /
  urans_precalc_mesh_profile_id (migration 0038); snapshot embeds
  uransMesh/uransPrecalcMesh (null = derived); physics hash includes
  them ONLY when pinned (null preserves historical hashes byte-for-byte
  — pinned by test); snapshot signature change from the new null keys
  accepted (reseed follows). Job-batching signature value-compares the
  per-tier mesh blocks so differing pins never share an engine job.
  Wizard: numerics "URANS meshes" disclosure, Derived (default) /
  Customize with two profile selects; ReviewStep summary line.
- Verification: engine 356 passed (-m "not integration"); api 116;
  web 242; core 103; db 4; workspace typecheck green. Codex gpt-5.5
  xhigh lanes J/K/L (engine / node data path / web), contract pinned in
  specs before parallel launch.
- Incident during verification: OrbStack VM wedged (docker engine
  unresponsive, psql handshake hung, port proxy still accepting) —
  every DB-backed api/sweeper test timed out. Restarted OrbStack,
  restarted aerodb-pg, applied migration 0038 to the :5544 test DB;
  api suite went 0-green to 116/116 unchanged-code. Sweeper flakes
  under whole-suite DB contention (ladder/auto-retry files) passed in
  isolation. One PRE-EXISTING order-dependent hang found and filed
  separately: sweeper.test.ts "retries only the rejected angles…"
  times out with the full file, passes solo, reproduces at HEAD before
  this change (task chip spawned).

## 2026-07-10 — DB reseed + clean campaign relaunch (uniform provenance)

- Rationale (user-approved plan): the shakedown dataset mixed evidence
  from eight engine generations in two days; with the engine stable
  (prod-20260710-tiermesh) a clean re-run yields uniform provenance at
  ~10x the original solve speed.
- Backup FIRST (policy): aerodb-preseed-20260710T000022Z.dump (43 MB,
  sha256 05133cec…), STRONG-verified by full restore into a scratch DB
  (49 tables, 577 results, 1621 airfoils) + local copy pulled off-box.
- Wipe via packages/db reset (drops public AND drizzle schemas — the
  known migration-ledger gotcha), migrate (incl. 0038), seed (64
  mediums, 1621 airfoils), symmetry backfill (119 symmetric — matches
  2026-07-07 exactly).
- Numerics profiles recreated from values captured pre-wipe (SQL,
  slugs prod-default-*); plan JSON captured pre-wipe and re-posted by
  slug-resolved ids. New campaign production-campaign-20260710
  (b96594a6-e0bf-40ce-b3c6-5dee77b35116): 450 points, 9 conditions,
  135 lanes — all THREE objectives enabled this time (ld_max 0.10/4,
  cl_zero 0.05/4, cl_max 0.10/8; the 07-07 run predated cl_max).
  Per-tier URANS meshes: derived defaults (null pins) — full tier will
  run the new wall-function derivation when the ladder reaches it.
- Gotchas hit and handled: sweeper seed default enabled=false (flipped
  after launch); mint-admin-token.sh writes /tmp/adm.token itself —
  capturing its stdout message as the token breaks auth (401).
- S1223 heavy-chord precalc cells are EXPECTED to park again as honest
  mesh-time failures (documented geometry limit).
- Monitor re-armed on the new campaign id (state-change-only stream).

## 2026-07-10 — Prod incident: VPS disk full → postgres crash-loop (recovered, zero loss)

- Symptom: monitor surfaced "Container … is restarting"; postgres in a
  crash loop (11 restarts, exit 1: "could not write lock file
  postmaster.pid: No space left on device"); sweeper died with it. Root
  disk 296 GB at 100%.
- Root cause: engine OpenFOAM job case directories under the
  app_results docker volume are NEVER cleaned after ingest — 523 dirs,
  ~240 GB in 3 days (RANS batch dirs 50–360 MB; URANS dirs multi-GB
  with saved continuation state). 464 dirs predated the 2026-07-10
  reseed: pure orphans of the wiped DB (their media/result rows no
  longer exist). NOT the new campaign's fault — it had added ~12 GB.
- Recovery (evidence captured before acting): deleted the 464
  pre-reseed job dirs (mtime split at reseed timestamp 00:05 UTC;
  current 59 dirs kept), disk 100% → 26% (211 GB free); postgres
  self-recovered healthy via restart policy; sweeper needed a
  compose force-recreate (its crash-loop lost the embedded-DNS alias —
  "getaddrinfo ENOTFOUND postgres" on boot; also noted: sweeper boot
  heartbeat write is an uncaught exception, no retry — restart policy
  masks it). Campaign verified intact: 634 requested / 268 solved /
  0 failed; interrupted jobs resumed.
- Note on the shakedown archive: the pre-reseed DB dump remains
  restorable (rows), but the old campaign's media FILES were part of
  the deleted case dirs — the archive is data-complete, media-orphaned.
  Accepted: user approved the wipe; media is re-derivable by re-solving.
- Guardrails: monitor script now emits DISK-WARN at ≥80% root usage and
  flags restarting/unhealthy/exited containers every cycle; durable fix
  (engine-side retention: strip solver state after terminal ingest,
  keep continuable saved state + media, periodic orphan sweep) filed as
  a spawned task chip with full design constraints.

## 2026-07-10 — Sweeper "order-dependent hang": diagnosis corrected, no code bug

- The suspected hang in sweeper.test.ts ("retries only the rejected
  angles…", 120 s timeout with the full file, pass solo) does NOT
  reproduce: 7 consecutive solo-file passes and 3 consecutive FULL
  sweeper suite runs (16 files / 139 tests) all green in ~80 s each,
  with a pg_stat_activity/pg_locks sampler armed the whole time — no
  idle-in-transaction connections, no lock waits beyond sub-5 s
  sim_campaign_progress insert contention between parallel workers.
- Corrected root cause: every failure-era run fell in the cold-I/O
  window right after the OrbStack VM restart (per-FILE durations
  137–249 s vs seconds at baseline); tests timed out at 120 s while
  fixture queries crawled. The "-t filter passes" observation was load
  reduction, not order-dependence; the "reproduces at HEAD" observation
  was the same degraded window, not a pre-existing code bug.
- Guardrail: AGENTS.md now instructs comparing file duration against
  the healthy baseline and sampling pg activity before diagnosing
  DB-backed test "hangs" after a VM restart. Probe harness pattern
  (activity/lock sampler alongside vitest) recorded via this incident.

## 2026-07-10 — Job-dir retention: engine strip API + sweeper reaper (incident guardrail)

- Engine (retention.py + api): POST /jobs/{id}/strip {keep_case_state},
  DELETE /jobs/{id}, GET /maintenance/jobs, GET /maintenance/disk.
  Keep set derived from real consumers and pinned by test: root API
  JSONs; a*/images, frames, evidence/{manifest, scaled_media,
  custom_renders, openfoam_evidence.tar.gz}; evidence/VTK is the
  re-render source (render endpoints prefer it) — redundant
  evidence/openfoam/ and evidence/time_directories/ strip (measured
  ~19 MB/angle of triplicated solver state vs <400 KB referenced
  media). keep_case_state=True preserves case solver dirs AND job-root
  meshes/ — prod cases SYMLINK constant/polyMesh into meshes/
  (jobs.py mesh_reuse_mode) and a dangling link is "not restartable";
  caught in review, pinned by a symlink must-catch with toggle-revert
  recall proof. Running guard: fresh .execute.lock → 409. Unknown
  files are kept and counted, never swept blindly.
- Node (migration 0039 sim_jobs.stripped_at/strip_report): sweeper
  retentionTick — strips terminal jobs after 30 min; continuable
  budget-stop rows keep case state until superseded or 14 d
  (RETENTION_CONTINUABLE_DAYS), then full-strip revisit; live
  continuation requests protect their source job; 409 retries, 404
  stamps no-op; ≤5 strips/tick. Hourly orphan sweep deletes only dirs
  UNKNOWN to sim_jobs older than 48 h; logs disk usage each sweep and
  warns ≥80%. Verify-tier checked in code: full-tier verify re-meshes
  (no continue_from) — no precalc-state protection needed.
- Fixes made during review: Date param under ::timestamptz cast broke
  postgres.js Bind (→ toISOString); retention tests scoped to own
  fixture jobs (shared test DB has legitimate foreign candidates).
- Verified: engine 363 (incl. 7 retention tests + symlink recall
  proof); sweeper 147/147 full suite; db + typecheck green.

## 2026-07-10 — Retention validated on prod (builds prod-20260710-retention/-retention2)

- Live evidence: reaper stripped the terminal backlog within minutes of
  deploy (17+ jobs, 7+ GB in the first pass; single URANS-era test jobs
  freed 1.5–1.6 GB each). Stripped job 4f7f30ea…: .stripped.json marker
  (mode full, 131 MB / 310 files), per-angle media dirs intact, and its
  scaled-media PNG served HTTP 200 (36 KB) through /api/media — media
  survival proven live, not just in tests. Ticks kept completing
  (started/completed stamps) and the campaign never paused.
- One cross-runtime contract slip caught in prod validation: engine
  GET /maintenance/jobs shipped a bare list; node client expects
  {"items": […]} → orphan sweep failed "not iterable". Fixed engine-
  side to the pinned contract, shape now pinned in test_retention.py
  (a bare list fails the suite). After -retention2: orphan sweep runs
  clean — "deleted 0 job(s) (known=69, young=0)" — with DISK telemetry
  (28.9% used, 209.8 GB free).
- The disk-full failure class is now guarded three ways: continuous
  strip of terminal job dirs, hourly orphan sweep + disk log/warning
  in the sweeper, and the session monitor's DISK-WARN at 80%.
