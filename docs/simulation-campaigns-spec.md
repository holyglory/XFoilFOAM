# Simulation Campaigns — Implementation Specification

Status: **approved design (mockups rev 4, 2026-07-04)** — this file is the authoritative
reference for the campaign/wizard/refinement implementation. Mockups:
claude.ai artifact "Simulations UX — Airfoils.Pro admin mockups". Decisions recorded in
`DecisionHistory.md` (2026-07-04 entries). Design was adversarially reviewed in three
critique passes; the rules below are binding, including every "honesty" rule.

## 1. Purpose

Give the admin one guided flow to compose and launch batch CFD work ("campaigns"),
watch and repair the results, reshape a running campaign (conditions, angles,
objectives, airfoils), and run iterative refinement objectives (max L/D, zero-lift
angle) to a user-set tolerance — on top of the existing evidence-first solver
pipeline, without changing how standing continuous presets behave.

## 2. Terminology

- **Campaign** — a user-launched execution record: airfoil set × condition set ×
  angle plan (+ objectives). Pure execution/work-definition; owns no physics values.
- **Condition** — one materialized (ambient, speed, chord) combination, pinned to an
  immutable `simulation_preset_revisions` row at creation.
- **Plan** — the campaign's editable intent: conditions envelope (ambient/speed/chord
  value sets), base angle sweep, refinement objectives. Stored as append-only
  **plan revisions**.
- **Point** — one requested solve cell: (condition, airfoil, angle).
- **Lane** — one refinement track: (airfoil, condition, objective).
- **Closure / completeness rule** — work solved for ≥1 campaign airfoil is completed
  for all campaign airfoils, even after removal from the plan (details §6.3).

## 3. Domain model (packages/db)

All new tables use uuid PKs + createdAt/updatedAt like existing tables unless noted.

### 3.1 New tables

**sim_campaigns**
- slug text UNIQUE (auto-suffixed -2, -3 on collision; launch returns final name),
  name text, notes text NULL
- status text NOT NULL: `active | paused | attention | completed | cancelled | archived`
- priority int NOT NULL default 5, CHECK 0..9
- idempotencyKey text UNIQUE NOT NULL (client-generated at Review)
- currentPlanRevisionId FK → sim_campaign_plan_revisions (nullable until first insert)
- closedWithFailedCount int NULL (set by "Close with failures")
- completedAt timestamptz NULL

**sim_campaign_airfoils** — PK (campaignId, airfoilId); FK airfoils ON DELETE CASCADE.
Campaign scope is resolved to this explicit list at launch ("snapshot at launch" is
stated in the UI; growth is via Add airfoils).

**sim_campaign_plan_revisions** (append-only audit; optimistic-concurrency anchor)
- campaignId FK CASCADE, revisionNumber int, UNIQUE (campaignId, revisionNumber)
- kind text NOT NULL: `initial | edit | force_release`
- plan jsonb NOT NULL — canonical, byte-stable:
  ```json
  {
    "mediumId": "…",
    "ambients": [["288.15","101325"], ["255.65","54050"]],   // [T_K, P_Pa] canonical strings, sorted
    "speedsMps": ["10.000","20.000","30.000","45.000"],       // sorted canonical strings
    "chordsM": ["0.1500","0.2500"],
    "spanM": "1.0000",                                        // single-valued
    "areaMode": "derived",                                    // "explicit" only while 1 chord
    "areaM2": null,
    "excludedConditions": [["288.15","101325","45.000","0.1500"]],  // click-to-exclude cells
    "baseSweep": { "fromDeg": "-10.0000", "toDeg": "25.0000", "stepDeg": "0.5000", "listDeg": null },
    "objectives": {
      "ldMax":  { "enabled": true,  "toleranceDeg": "0.10", "maxRounds": 8 },
      "clZero": { "enabled": true,  "toleranceDeg": "0.05", "maxRounds": 6 }
    },
    "numerics": { "boundaryProfileId": "…", "meshProfileId": "…", "solverProfileId": "…", "outputProfileId": "…" }
  }
  ```
- summary jsonb NOT NULL — { addedConditions, keptConditions, releasedConditions,
  addedPoints, cancelledPoints, forceReleasedConditionId? , valueDiffs }
- createdBy text NULL

**sim_campaign_conditions**
- campaignId FK CASCADE, ord int
- flowConditionId FK, referenceGeometryProfileId FK (provenance only — display reads
  the revision snapshot, never live registry rows)
- presetId FK, simulationPresetRevisionId FK (PINNED at creation, never re-pinned)
- cached reynolds bigint, mach double (copied from the pinned revision)
- status text NOT NULL: `active | kept | released`
- introducedInPlanRevisionId FK, statusChangedInPlanRevisionId FK NULL
- UNIQUE (campaignId, flowConditionId, referenceGeometryProfileId) — re-adding a
  previously released combo RE-ACTIVATES this row (same pinned revision; evidence
  continuity; no duplicate columns).

**sim_campaign_points** (materialized execution ledger)
- PK (campaignId, conditionId, airfoilId, aoaDeg)
- revisionId uuid NOT NULL (denormalized pin), planRevisionNumber int NOT NULL
- state text NOT NULL default `requested`: `requested | released | terminal`
- resultId FK → results ON DELETE SET NULL
- derivedBySymmetry boolean NOT NULL default false (negative-α cells of symmetric
  airfoils; terminal immediately when the +α source is terminal — see §9)
- Indexes: partial (campaignId) WHERE state='requested';
  (revisionId, airfoilId, aoaDeg) WHERE state='requested'; (resultId).
- Writes are set-based (INSERT…SELECT ON CONFLICT DO NOTHING; UPDATE…FROM results to
  link pre-solved evidence — that UPDATE run as SELECT count is the reuse preview).

**sim_campaign_progress** (counters; the only thing polled reads scan)
- PK (campaignId, conditionId, airfoilId)
- requested, solved, failed, running, superseded, derived int NOT NULL default 0
- Maintained: written at launch/plan-edit inside the same transaction; incremented in
  the sweeper ingest path; healed by a low-frequency reconciler (≤1 campaign / 5 min).
- Completion flip = counter comparison on ingest, never a tick-time scan.

**sim_campaign_lanes**
- PK (campaignId, airfoilId, conditionId, objective) — objective: `ld_max | cl_zero`
- state text NOT NULL: `awaiting_seed | iterating | converged_provisional |
  converged_final | converged_window | converged_stale | stalled |
  insufficient_evidence | failed | symmetric_definition`
- currentTargetAlpha double NULL, iterationCount int NOT NULL default 0
- witnessFitSetId FK → polar_fit_sets NULL (the fit convergence was judged against)
- extraRoundsGranted int NOT NULL default 0 ("Continue +N iterations")

**sim_campaign_lane_steps** (append-only evidence)
- laneId composite FK, iteration int, UNIQUE per (lane, iteration)
- predictedAlpha double NOT NULL (canonical 0.01°), fitSetId FK NOT NULL,
  solvedResultId FK NULL, outcome text: `predicted | solved | superseded | released`

### 3.2 Modified tables

- **simulation_presets** + `origin` text NOT NULL default 'library':
  `library | campaign` — set ONCE at INSERT, never reassigned. Library tab filters
  `origin='library'` by default with a "show campaign-generated" chip. NO campaignId
  column (ownership is expressed by sim_campaign_conditions joins, many-to-many).
  Campaign-created presets: enabled=false always, targetScope='all' (inert).
- **simulation_preset_revisions** + `physicsHash` text — hash over ONLY the
  physics+numerics snapshot blocks: flowState (medium identity + T/P/speed + resolved
  density/viscosity), referenceGeometry, boundary, mesh, solver (NOT name, sweep,
  scheduling, output). Backfilled by migration. Global UNIQUE index
  (physicsHash) WITH a deterministic canonical-revision rule: the launch materializer
  reuses ANY revision with a matching physicsHash (prefer: enabled-preset revision,
  else oldest). Insert with ON CONFLICT DO NOTHING + reselect (race-safe).
- **flow_conditions** and **reference_geometry_profiles** +
  `origin` text NOT NULL default 'user' (`seeded | user | campaign`),
  `createdByCampaignId` uuid NULL ON DELETE SET NULL,
  `canonicalKey` text UNIQUE — computed over INPUT values only (never derived
  columns): flow = mediumId|T|P|speed at canonical precision; geometry =
  type|kind|chord|span|area. Backfill migration must dedupe existing value-identical
  rows conservatively: only merge rows that are unreferenced or identically
  referenced; otherwise suffix the canonicalKey deterministically and log.
- **sim_jobs** + `campaignId` uuid NULL, `jobKind` text NOT NULL default 'sweep'
  (`sweep | targeted`). Refinement iterations and small campaign deltas are
  `targeted`.
- **airfoils** + `isSymmetric` boolean NOT NULL default false + `symmetryCheckedAt`
  timestamptz NULL. Computed from stored coordinates (see §9.1); backfilled by
  migration; recomputed on airfoil create/import.
- **sweeper_state** + `cpuSlots` int NOT NULL default (existing effective default).
  This is THE single global solver-capacity setting ("OpenFOAM CPU slots"), surfaced
  on the Queue page. `maxConcurrentJobs` is derived/subordinated to it (keep the
  column for compatibility; the UI exposes only CPU slots; job building passes the
  global slots into the engine `resources` block). Per-preset scheduling_profiles
  remain as tables but LEAVE the campaign composition and the wizard entirely.

### 3.3 Legacy compatibility

- results.bcId is NOT NULL: campaign launch MUST run
  `syncLegacyBoundaryConditionForPreset` for every found-or-created preset BEFORE any
  points/results rows are created. API-level test required.

## 4. Canonicalization (packages/core, shared by API + sweeper + web)

One module exports and EVERY producer uses it (no SQL generate_series for campaign
angle expansion — grids are generated in TS and inserted as values):

- `canonicalAoa(x)` — round-half-even to 1e-4 deg; refinement predictions first
  rounded to 0.01°. Used at every write and every join-key construction.
- Canonical value precisions (SI): T 0.01 K · P 1 Pa · speed 0.001 m/s ·
  chord 0.0001 m · span 0.0001 m · area 1e-6 m².
- Canonical strings: fixed-precision decimal strings (as in plan jsonb), sorted
  ascending; range expansion computes from + i*step in decimal, canonicalizes,
  dedupes. A 0.5° grid MUST be byte-identical to the matching subset of a 0.1° grid.
- `physicsHash(snapshot)` — sha256 over a stable-stringified physics+numerics subset
  (exact field list documented in code next to SimulationSetupSnapshot).
- Envelope diff = string-set difference over canonical chips → fully deterministic.

## 5. Launch protocol (POST /api/admin/campaigns)

1. Validate (25 values/axis max; ≤2,000 conditions; priority 0..9; objectives
   require a base sweep of ≥3 angles). There is deliberately NO point-count
   launch limit (removed 2026-07-04 by user decision): launches of 10^6+ points
   are legitimate; the >10k type-to-confirm friction and the honest scale lines
   are the only guards. The launch transaction must therefore stay efficient at
   millions of points (set-based inserts).
2. Idempotency: sim_campaigns.idempotencyKey UNIQUE; replay returns the existing
   campaign (200). Launch button disables on first click.
3. In ONE transaction:
   a. Quick-created mediums/profiles commit here (never earlier — abandoned wizard
      drafts leave no rows). All quick-creates are NEW records (save-as-new).
   b. Per condition combo: value-level find-or-create flow/geometry rows via
      canonicalKey ON CONFLICT (origin='campaign' only on genuine insert; a matching
      library row is reused untouched).
   c. Compute physicsHash; global lookup → reuse ANY matching revision; else create
      an origin='campaign' preset (enabled=false) + revision (advisory lock on the
      hash during launch kills races).
   d. syncLegacyBoundaryConditionForPreset for every preset used.
   e. Insert campaign, airfoils, plan revision #1 (kind=initial), conditions
      (status=active, pinned revisionIds), points (set-based; symmetric airfoils get
      only α ≥ 0 solver points + derivedBySymmetry rows for the negative side),
      link pre-solved evidence, write progress counters, create lanes for enabled
      objectives (symmetric airfoils' cl_zero lanes start as `symmetric_definition`).
4. The wizard reuse preview endpoint (GET …/campaigns/preview) is READ-ONLY: computes
   would-be physicsHashes in memory, looks up existing revisions, counts solved
   points; explicit "computing…" state; honest degrade copy on timeout
   (statement_timeout ≈ 5 s): "Couldn't compute the reuse preview in time — launching
   is still safe: already-solved points are never re-run." If reused == total, Review
   shows "all N points already solved — nothing will run" + explicit
   "mark reused points stale & re-solve" checkbox (sets those results rows stale so
   the campaign branch treats them as gaps).

## 6. Plan editing (Edit conditions / Edit angle plan)

Both reuse the SAME editor components as wizard steps 2/3, with exactly three deltas:
medium read-only ("fixed once launched — duplicate this campaign to change it"), a
one-line semantics banner, submit → acknowledge dialog instead of next step.

### 6.1 Preview → acknowledge protocol (exactly-once)

- PREVIEW: client sends edited plan + basePlanRevisionNumber. Server computes the
  canonical set diff, classifies removed combos/angles (closure), returns diff with
  real counts (including "N running jobs on removed work will finish; evidence kept")
  + a diff hash. NO writes.
- ACKNOWLEDGE: client sends baseRevisionNumber + diffHash. Server: BEGIN; SELECT
  campaign FOR UPDATE; 409 if plan revision advanced; RE-CLASSIFY inside the
  transaction; if the fresh diff differs materially → ROLLBACK and return the
  refreshed diff ("Results landed while you were reviewing; the numbers changed.
  Review again."); else APPLY atomically: insert plan revision (kind=edit), flip
  condition/point states, delete campaign-claimed PENDING results rows of released
  work (running rows untouched), upsert added points (reuse via natural key;
  re-adds re-activate original conditions), update lanes for objective changes,
  recompute progress counters, reset the rate-projection baseline marker; COMMIT.
- The dialog sections are outcome-named: **Adding** / **Kept to finish** (amber,
  with the closure sentence below) / **Removing**. Primary button carries real
  totals: "Apply — add X points, cancel Y pending". Footer: "Solved results are
  never deleted." Type-to-confirm only when added points exceed the same launch
  threshold (10k).

Closure sentence (exact copy): *"Conditions that already have results for any
airfoil will stay and finish for all airfoils — removing values only cancels
conditions nothing has been solved at yet."*

### 6.2 What is editable

- Conditions: ambient chips, speed chips, chord chips, exclusions. Medium: locked.
- Angle plan: base sweep from/to/step or list (add AND remove); objectives on/off,
  tolerances, round budgets ("Continue +N" on a stalled lane = extraRoundsGranted).
- Airfoils: Add airfoils action (picker minus already-included; inherits active +
  kept cells — itemized in its confirm dialog; no opt-out).
- Any growth action on a completed campaign reopens it to `active` and clears
  completedAt.

### 6.3 Closure (completeness) rule — binding

- Granularity for sweep work: per (condition, angle) cell. "Has evidence" = a solved
  results row exists at (any campaign airfoil, the condition's pinned revision, an
  angle within the campaign's requested set) — regardless of which campaign/public
  job produced it (matches what the matrix shows as solved).
- Removing a condition: if it has ≥1 solved cell → status `kept`; ONLY its solved
  angles remain requested (for all campaign airfoils); unsolved angles are released.
  Zero solved cells → `released`; its pending campaign-claimed rows are deleted.
- Removing angles: symmetric rule — solved angles stay for all airfoils; unsolved
  are released.
- Later angle additions do NOT extend `kept` conditions (kept work only shrinks).
- Objective lanes: closure per lane — a lane iterates to convergence for all campaign
  airfoils at that condition once triggered.
- No auto-resurrection: closure is evaluated at acknowledge time. Late evidence from
  an in-flight job landing on released work is kept as evidence, the condition gains
  a "released, gained evidence" flag and the detail page shows a non-blocking
  suggestion: "1 released condition gained evidence after release — restore it to
  keep the dataset closed?" Restore re-activates through the normal plan-edit path.
- Force-release: a `kept` condition with exhausted failures ("blocked", red) offers
  an explicit force-release (confirm with real counts; plan revision kind=
  force_release records it; solved evidence kept; pending deleted).
- Kept condition whose cells all solve → display state "retired · complete"
  (neutral); while work remains → amber; with exhausted failures → red "blocked".

### 6.4 Campaign lifecycle verbs

- PAUSE: campaign branch leaves the scheduler union; in-flight jobs finish and
  ingest; claimed pending rows freeze (off-grid rows are invisible to other demand);
  RESUME thaws. UI: "Paused by you — no new points will be scheduled; 1 running job
  will finish."
- CANCEL (terminal, confirm dialog with real counts): in-flight jobs finish and
  ingest; campaign-claimed pending/queued-unsubmitted results rows are DELETED (or
  marked stale if attempts reference them); all evidence/attempts/classifications/
  fit sets/lane steps retained; origin='campaign' presets with zero results and zero
  other references are GC'd. Status shows "Cancelled — N jobs finishing" until
  in-flight is zero.
- COMPLETED: system-set when every active+kept obligated cell is terminal AND zero
  failed. All-terminal-with-failures → `attention`; manual "Close with failures"
  converts attention → completed and records closedWithFailedCount.
- ARCHIVE: reversible visibility flag, only from completed/cancelled; read-only.
- No hard DELETE. e2e cleanup via the extended pw- purge endpoint (§13).

## 7. Scheduling & execution (apps/sweeper)

- **One total order.** findGaps emits a UNION: continuous branch (as today,
  effectivePriority = results.priority — 0 default, 10 public) + campaign branch
  (candidates from sim_campaign_points state='requested' of active campaigns, minus
  sync-promised points, minus owned/in-flight results; effectivePriority =
  campaign.priority stamped onto created results rows as
  GREATEST(existing, campaign band)). ORDER BY effectivePriority DESC, reynolds ASC,
  slug ASC, aoa ASC, LIMIT as today. Wizard caps campaign priority at 9 so public
  on-demand (10) always wins. Priority levels named in UI: Background (0) /
  Standard (5, default) / High (8) with the honest starvation copy.
- **Campaign job building** (batched, 2026-07-04): one campaign job =
  (campaign, airfoil, chord, compatible physics group, identical open-angle set)
  × all its open speeds, capped at CAMPAIGN_MAX_CASES_PER_JOB (256) with greedy
  reynolds-ordered chunking. Compatibility is value-based: identical ambient
  (T/P/density/viscosity) + identical boundary/mesh/solver/output blocks; one
  chord per job (a mesh is per-chord); identical open-angle sets only (one aoa
  list per engine request — unioning would re-solve solved points). The job's
  requestPayload carries a conditionMap [{conditionId, revisionId, presetId,
  speed, reynolds, bcId}]; ingest maps each returned polar to its entry by
  canonical speed (exact equality, never nearest-guess); wave-2 URANS plans are
  computed per entry and submitted as per-condition single-revision preliminary
  children whose angle list follows the RANS-failure policy below. One entry's
  promotion must never widen a sibling entry. Jobs without a conditionMap keep
  the legacy single-revision path.
  Campaign jobs never bundle foreign gaps; refinement iterations are
  single-angle `targeted` jobs; sim_jobs.campaignId set.
- **Engine-side reuse** (2026-07-04, supersedes §15's "no engine changes"):
  the Python engine keeps persistent content-addressed caches on the
  engine_cache volume (env AIRFOILFOAM_CACHE_DIR, LRU-capped by
  AIRFOILFOAM_CACHE_MAX_GB, default 20 GB): a MESH cache keyed
  (normalized geometry, canonical chord, resolved mesh params) so repeat
  meshing is a verified copy, and a SEED cache keyed (mesh key, fluid,
  canonical speed, solver signature) so a new steady case within 2.0° of a
  stored accepted solution starts from that field (same inlet-rewrite
  mechanism as the in-job march) instead of potentialFoam. Verified on real
  OpenFOAM: second job logged "mesh cache hit" and "seeded … from cached
  solution at aoa 2". Engine build id: dev-20260704-batch-cache.
- **RANS→URANS retry scoping** (2026-07-12 owner decision, superseding the
  earlier revision-wide heuristic and the 2026-07-07 categorical targeted-only
  rule): only an exact job-local RANS attempt with structured `hard_solver`
  provenance at inclusive 0..5° promotes a continuous multi-angle production
  sweep. Stop the remaining RANS march and create preliminary URANS obligations
  for the original requested AoA list of that exact parent job, condition, and
  immutable revision. Do not use the currently open subset, revision history,
  rounded values, batch labels, `<5 valid points`, or longest-run length to
  derive scope. Hard failures below 0° or above 5°, `needs_urans`, and explicit
  single-angle/refinement/admin work remain targeted. Infrastructure and
  deterministic mesh failures never promote and stay on their existing
  retry/block paths. The failed attempt stays immutable evidence; angles omitted
  by the abort are scheduling obligations, not invented failed attempts. The
  normalized promotion event and per-angle obligations are the restart-safe,
  idempotent execution authority. For a remote-solver promise, a fulfilled
  exact accepted RANS pointer may advance only to the newly accepted canonical
  URANS generation for that same promise and cell; the RANS attempt remains
  immutable. Changed RANS, competing URANS, and expired/cancelled promise
  generations remain conflicts.
- **Engine-down backoff**: before composing a job, check the cached engine probe; on
  submit connection failure do NOT mark the job failed — release the composed row,
  set engineUnreachableSince in sweeper state, back off exponentially (5 s → 5 min
  cap). Queue + campaign pages show one truthful banner ("Engine unreachable since
  14:02 — no jobs are being submitted."). `failed` is reserved for jobs the engine
  actually rejected/ran.
- **Ingest hooks**: after each result upsert, update matching campaign points →
  terminal (+ link resultId), bump progress counters, mark symmetric derived cells
  terminal alongside their +α source, enqueue dirty lane keys, run the completion
  probe (cheap partial-index check) → status transitions (active → attention/
  completed).
- **Global CPU slots**: job resources block built from sweeper_state.cpuSlots at
  compose time; Queue page exposes exactly one capacity control.
- **Reconciler**: low-frequency healing of counters, orphaned pending rows of
  cancelled/released work, and lane states.

## 8. Refinement objectives

- Targets computed IN the fit (packages/core `buildPolarFit`): `alphaLdmaxFine` and
  `alphaClZeroFine` — densified/golden-section argmax (resp. root) near the coarse
  grid value, rounded to 0.01°, stored in polar_fit_sets metrics. Bump
  POLAR_FIT_VERSION; the backfill script regenerates current fit sets.
- Lane tick (event-driven via ingest dirty-queue + 60 s safety sweep; O(dirty lanes)):
  1. Load isCurrent fit F for (airfoil, pinned revision). Missing/insufficient →
     if base-sweep points still pending → `awaiting_seed`; if all terminal and fit
     still insufficient → `insufficient_evidence` (lane-scoped requeue-failed
     affordance).
  2. α* = F.target (per objective). Append step (iteration, predictedAlpha, fitSetId)
     when it advances the lane.
  3. CONVERGED iff: (a) no in-flight/requested point for this lane; (b) an ACCEPTED
     evidence point exists at the pinned revision within tolerance of α*; (c) the fit
     did not move since the last prediction (fitSetId equals previous step's).
     `converged_final` when F.status = final, else `converged_provisional`.
     There is deliberately NO |α_new − α_prev| term (iteration 1 well-defined: a base
     sweep that already brackets the target converges immediately).
  4. If canonicalAoa(α*) duplicates an already-requested lane angle and (3) fails:
     oscillation check — last 3 predictions within a 2·tolerance window →
     `converged_window` (reported as the current fit value ± the observed window);
     else keep iterating until maxRounds (+extraRoundsGranted) → `stalled`.
  5. Else enqueue α* as a single-angle campaign point (targeted job, campaign
     priority band); iteration++.
  6. Supersession reopen: on any new isCurrent fit at that (airfoil, revision), if
     |newTarget − convergedTarget| > tolerance and the campaign is active → back to
     `iterating` (audit preserved; UI shows "fit changed after URANS — re-running").
     `converged_stale` marks lanes whose witness fit was replaced within tolerance
     questions pending re-confirmation only if not re-run.
  7. Tolerance edits (plan edit): tightening reopens converged lanes that no longer
     satisfy (b); loosening may immediately converge iterating lanes. Disabling an
     objective freezes its lanes at their last evidence-backed state (nothing
     deleted); enabling builds lanes from existing evidence (may converge at once).
- Symmetric airfoils: cl_zero lanes are `symmetric_definition` (α₀ = 0° by
  definition, no solve, stated as such); ld_max lanes search α ≥ 0 only.

## 9. Symmetric airfoils

### 9.1 Detection
`isAirfoilSymmetric(points)` in packages/core: after the existing normalization
(chord-aligned, closed TE), compare upper/lower surfaces sampled at common x
stations; symmetric iff max |y_up(x) + y_low(x)| ≤ 1e-4 (relative to chord = 1).
Stored on airfoils (isSymmetric, symmetryCheckedAt); backfilled by migration;
computed on create/import. A real geometric property — never inferred from names.

### 9.2 Solve plan
For symmetric airfoils, only α ≥ 0 points get solver work. Negative requested angles
become `derivedBySymmetry` points: terminal as soon as the matching +α point is
terminal, resultId → the +α results row. Derived coefficients: Cl(−α) = −Cl(α),
Cd(−α) = Cd(α), Cm(−α) = −Cm(α). Derivation happens at read/assembly time (detail
payload, polar fit input assembly, campaign cell rendering) — results rows are ONLY
real solves. Fit input mirrors accepted/needs_urans evidence with the same
classification state.

### 9.3 Presentation
Derived points carry `derivedFromResultId` + a "derived by symmetry" marker in every
surface (matrix cells, polar points, evidence views). Opening one shows the source
+α evidence with a "mirrored (symmetric airfoil, derived from α = +X°)" badge; field
images/animations render mirrored from the stored +α artifacts (client-side
transform), labeled. Never presented as independent solver runs. Counts shown to the
user distinguish "solver runs" from "points" (Review: "Solver runs 237,664 — 17
symmetric airfoils solve positive angles only; 5,440 points derived by symmetry").

### 9.4 Meshing
No engine change required for correctness (mesh is per chord per job, geometry
already symmetric); job building simply never submits negative angles for symmetric
airfoils. Keep the engine request untouched otherwise.

## 10. API surface (apps/api; ALL new routes `preHandler: requireAdmin`)

- POST `/api/admin/campaigns` — launch (§5). GET `/api/admin/campaigns` — hub list
  (paged, status filter, counters).
- GET `/api/admin/campaigns/preview` (POST body, read-only) — wizard reuse preview.
- GET `/api/admin/campaigns/:id` — bounded summary, 10 s poll, O(conditions):
  { campaign, totals, conditions[] (with per-condition counters + status + pinned
  revision info + drift flag), scheduler {sweeperEnabled, engineHealthy,
  engineCheckedAt, campaignJobsRunning}, rate {pointsLast24h,…}|null, lanesSummary }.
- GET `/api/admin/campaigns/:id/airfoils?cursor&limit=25` — keyset matrix rows
  (per-condition cell counters); poll refetches only the visible page.
- GET `/api/admin/campaigns/:id/failures?cursor&groupBy=errorClass&conditionId` —
  requeue dialog data.
- GET `/api/admin/campaigns/:id/lanes?objective&state&cursor` +
  GET `…/lanes/:airfoilId/:conditionId/:objective` — board + iteration table.
- POST `…/:id/plan/preview` + POST `…/:id/plan/apply` — §6.1.
- POST `…/:id/airfoils` — add airfoils (preview + apply same protocol).
- POST `…/:id/pause | resume | cancel | close-with-failures | archive | duplicate`
  (duplicate returns a wizard prefill payload, creates nothing).
- POST `…/:id/conditions/:conditionId/force-release | restore`.
- POST `…/:id/requeue-failed` — body: error classes / condition / airfoil scope +
  exact expected count (server re-verifies; 409 on drift).
- POST `…/:id/lanes/:laneKey/continue` — +N rounds.
- Queue payload additions: backlog strip (per-campaign remaining, background gap-fill
  waiting note, cached 5 min with computed-at time), campaign chips per job
  (via sim_jobs.campaignId; admin payload only), engineUnreachableSince, cpuSlots.
- GET `/api/admin/queue?scope=activity|background|engine|all` (default `all`,
  back-compat) — tab-scoped payloads. Every scope returns the FULL AdminQueue
  shape with out-of-scope sections explicitly `null` (a section is
  present-and-real or absent, never invented): `activity` = sweeper +
  backlogStrip + jobs/activeJobs/finishedJobs + results + cached engine chips;
  `background` = pendingSweeps + externalPromises (+ sweeper) and is the ONLY
  scope that awaits the full gap scan; `engine` = engine health/queue/cache
  blocks + activeJobs (stale/detached counts) + sweeper. Invalid scope → 400.
- EVERY engine-dependent block in the queue payload is TTL-cached with
  stale-while-refresh and a bounded race cap on its cold path (health ~15 s /
  queue ~5 s / cache-stats ~30 s, cap 750 ms; per-job runtime annotations
  keyed by the engineJobId set, TTL ~5 s, cap 500 ms). The handler NEVER
  awaits a live engine round-trip: while OpenFOAM solves saturate the CPU the
  engine responds in seconds, and the admin queue page must stay usable
  exactly then (§12). Stale runtime annotations ship with
  `engineRuntimeAsOf` — the snapshot's true fetch time — and degraded probes
  carry their error strings; missing data is null, never invented.
- PATCH `/api/admin/sweeper` gains cpuSlots. **Move `PATCH /api/sweeper` and
  `GET /api/sim-jobs` under requireAdmin** (keep GET /api/sweeper public read if the
  public UI needs it — verify usages; sim-jobs payload must not leak campaign names
  in any public route).
- Fix `assembleSim` fallback: exact-float AoA match (no Math.round); fractional
  campaign evidence opens by resultId.

## 11. Web UI (apps/web)

- **Nav**: Simulations (first, default) · Queue · Setup library (existing 9 tabs +
  Mediums as 10th; tab row scrolls <940) · Catalog (Add airfoils default tab,
  Categories, Hashtags) · Sync API.
- **Routing contract**: URL search params are the single source of truth
  (?section, ?campaign, ?wizard, ?step); push for section/campaign transitions,
  replace for tabs/steps/filters; popstate handled; Escape/Back close the side panel
  before leaving the page; unknown campaign id → real not-found state; wizard drafts
  persist to sessionStorage keyed by draft id with a dirty-exit guard.
- **Hub**: Active segment default (active/paused/attention), All segment; sort
  attention-first then updatedAt; CTAs "New polar sweep" / "New max-L/D refinement"
  (same wizard, different step-3 prefill); per-row Duplicate/Open; truthful status
  chips (§12).
- **Wizard (4 steps)**: per mockups rev 4. Step 2: define-in-place envelope editor —
  medium select + inline mini-form (constant viscosity; Sutherland/table opens the
  full medium editor in a modal); ambient (T,P) chips + ISA altitude helper; speed/
  chord multi-value fields (plain UnitNumberField until 2nd value; chips sorted/
  deduped/canonical; range expander; >8 values collapse to summary; field-level unit
  button; per-axis min–max derived footers; NO per-chip Re/Mach); prefill-from-library
  popovers that only ADD; condition preview grouped by ambient (grid ≤200, summaries
  beyond, ≤3 as lines; click-to-exclude); early scale line — conditions ×
  airfoils only until the user has actually reached step 3 (the angle plan is
  undefined before then; never multiply by unconfirmed default angles); the
  full conditions × angles × airfoils product appears once the plan is touched
  (and always in post-launch Edit Conditions, where the plan exists). Step 3: base
  sweep + objective toggles with tolerance/rounds; symmetric-airfoil savings line.
  Step 4: totals incl. solver-runs row, reuse preview (computing/degrade states),
  numerics current-value chips expanding to four selects, each with an inline
  "+ new profile" quick-create (save-as-new modal over the wizard; full Setup-editor
  field set incl. νt/ν presets + advanced raw value, the live mesh infographic,
  URANS knobs behind an advanced disclosure, stored-image multi-select; created row
  selected in place — existing rows never mutated); defaults from REAL rows only:
  exactly one existing row (any origin) auto-selects, else exactly one
  seeded/isDefault row among many; zero rows → unresolved chip with the quick-create
  as the only path (never a select with one dead option, never an invisible
  auto-pick); unresolved slot = validation issue. Priority select with honest copy,
  queue context (backlog + observed rate only), >10k type-to-confirm, idempotent
  Launch. All numeric inputs = UnitNumberField; validation = existing ValidationIssue
  + focus-on-error system (chips get per-chip error targeting).
- **Campaign detail**: header ≤2 rows (actions collapse to overflow <940); truthful
  status line; progress + rate line (§12); condition summary strip; virtualized
  matrix (search, failed-first default, sticky headers ≥940, stacked bar <620, own
  overflow-x, ⚑ kept badges + legend only when present, "Show released (N)" only
  when N>0, "next up" marker from real candidate order, sync-promise cell state);
  side panel: PolarViewer first (derived-by-symmetry markers), status chips, failed
  list + requeue, provenance disclosure (pinned revision + drift chip); dialogs:
  Edit angle plan / Edit conditions (shared editor + acknowledge dialog per §6.1),
  Add airfoils, Requeue failed (error-class groups, counts, ≥3-attempts warning),
  Cancel (real counts), restore suggestion chip.
- **Refinement board**: summary pills as filters; virtualized lanes (objective chip,
  status chip); expanded iteration table (predicted α → solved point by resultId →
  new fit target → Δ); "Continue +N"; provisional/stale/symmetric states.
- **Queue page**: backlog strip, campaign chips on job cards, engine-unreachable
  banner, single "OpenFOAM CPU slots" control (replaces the concurrency stepper).
- **Pinned-detail admin journey**: every admin surface that deep-links to
  `/airfoils/<slug>` as evidence of a job/result (finished/active job cards,
  campaign cell side panel) appends `?revision=<uuid>` with the job's setup
  revision, because the public detail page builds polars from ENABLED presets
  only and campaign presets are disabled by design — an unpinned link on a
  campaign-only database lands on zero polar groups. The detail page validates
  the param (UUID shape; invalid → ignored), fetches the §10 pinned scope
  (`GET /api/airfoils/:slug?revisionId=`), and shows a compact dismissible
  "Pinned to setup revision …" chip above the charts linking back to the
  public view. The queue payload carries `AdminJob.revisionId` (single-revision
  jobs; NULL for multi-revision batched jobs, which link unpinned — no single
  pinned view exists). The finished-job log's open state is URL-owned
  (`?flog=1`, replace semantics) so browser-back from an evidence link returns
  with the log still expanded.
- All admin polls pause on document.hidden, resume with immediate fetch.

## 12. Honesty rules (binding, from the global no-fake policy)

- Status lines derive from the truth table campaign × sweeper.enabled × engine
  health; never bare "Active" when nothing can run.
- Projections ONLY from measured ingest (≥50 points/trailing 24 h), phrased as
  solver-work remaining, suppressed while blocked; recomputed on a trailing window;
  baseline reset on plan edits. No calendar dates/countdowns anywhere.
- Derived Re/Mach only where fully determined; previews are real dry-run counts with
  visible computing/degrade states; destructive dialogs carry exact counts verified
  server-side; derived-by-symmetry always labeled with provenance; no invented
  defaults — numerics defaults resolve only from real rows (a single existing row of
  any origin, else exactly one seeded/isDefault row; otherwise unresolved).

## 13. Testing requirements

- Unit (core): canonicalization (range-expansion byte-equality incl. 0.5⊂0.1 grid),
  physicsHash stability + exclusion list, fine targets (alphaLdmaxFine/alphaClZeroFine
  vs analytic fixtures), symmetry detection (NACA 00xx true; cambered false;
  tolerance boundary), mirroring math.
- API integration: launch idempotency (double POST → one campaign), preview
  correctness vs actual launch reuse, plan-edit acknowledge 409 on concurrent edit,
  closure classification (kept vs released, per-angle granularity, force-release,
  restore, no-resurrection), legacy bcId path, auth on every new route + the
  hardened /api/sweeper + /api/sim-jobs, purge endpoint cascades campaign tables.
- Sweeper: campaign branch ordering vs public priority 10, campaign job isolation
  (no foreign gap bundling), and conditional retry scoping. Must-catch coverage
  includes hard-solver failures at both inclusive 0°/5° boundaries promoting
  only the exact condition's original requested polar, plus durable recovery and
  truthful intentionally omitted angles. False-positive guards cover negative
  and above-5° failures, `needs_urans`, explicit single-angle work,
  infrastructure and deterministic mesh failures, sparse evidence, and
  unrelated job/revision history. Also cover engine-down backoff (no failed-job
  spam), counters/completion transitions, and the lane convergence state
  machine (iteration-1 convergence, oscillation window, supersession reopen,
  tolerance tighten/loosen, symmetric_definition).
- Playwright e2e (pw- stamp + extended purge): wizard launch happy path with
  multi-value chips + preview; edit-conditions diff with a kept-to-finish condition;
  refinement board states; hub/URL routing (back button returns hub with state).
- Detector recall rule: every advertised failure class above ships at least one
  must-catch test shaped like real breakage, plus false-positive guards.
- Run: `pnpm typecheck`, `pnpm -r test`, targeted `pnpm test:e2e` specs,
  formal-web-ui-verification on /admin (desktop + mobile) before delivery.

## 14. Migration / backfill plan (order matters)

1. Additive columns + new tables (no destructive changes).
2. Backfill physicsHash for all existing revisions; build the global unique index
   AFTER deduplication analysis (value-identical physics across presets is expected —
   the unique index applies to NEW canonical-revision selection; if true duplicates
   exist, keep them but mark a canonical row: implement as UNIQUE index on
   (physicsHash) WHERE isCanonicalPhysics = true with a backfill that elects the
   oldest/enabled-preset revision as canonical; the materializer reuses canonical).
3. Backfill canonicalKey with conservative dedupe (§3.2).
4. Backfill airfoils.isSymmetric from stored coordinates.
5. `postgres-docker-backup` is REQUIRED before running migrations on any live DB.

## 15. Out-of-scope for this feature (recorded)

- "Keep filling forever" launch option creates/points to a continuous enabled preset
  (existing machinery); offered only for scope = all.
- Remote/sync federation behavior unchanged; campaign branch respects promises.
- Engine (Python) changes: none required.
