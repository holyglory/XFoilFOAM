# Progressive campaign polars

Status: approved implementation contract, September 6, 2026. This document does
not assert implementation or deployment readiness. Durable outstanding outcomes
and verification live in the configured completion-ledger database.

## Preliminary local inspection

The coordinator deployment `progressive-preview@worktree` provides an isolated
AG24 and AG25 detail pages plus a two-profile comparison. It imports the
repository's trusted coordinates and air property data, then calculates six actual
NeuralFoil curves per profile at explicitly selected
preview conditions: 30/90/166 m/s, chord 0.1/1 m, 288.15 K and 101325 Pa, with
angles −5 through 20 degrees and fully turbulent transition assumptions. These
are preview conditions, not an export of the production campaign database.

Start or refresh it with `devcoordinator2 deployment apply --name progressive-preview`.
Read the allocated web port with `devcoordinator2 deployment status --name progressive-preview`
and open `/airfoils/ag24` or `/compare?airfoil=ag24&airfoil=ag25` on that local
origin. AG25 is added after campaign creation and enrolled through the same
automatic profile-enrollment path used for later catalog additions. The isolated API cannot connect to
the production solver or object bucket. Its separate AG24 CFD campaign now uses
the persistent private preview engine for real fast and precise refinement.
The page is preliminary; final layout/performance verification, scientific
validation and production readiness remain separate outstanding outcomes.

Comparison preserves selected profiles in the URL, including an explicitly
cleared selection. Matching uses the exact physical-condition key, not rounded
Reynolds or Mach labels. Each profile uses its own cached best available curve
and the summary from that same curve. Curve samples are optional and are not
presented as completed CFD runs. Missing profiles and ambiguous matching targets
remain unavailable rather than being replaced with another profile or setup.

`progressive-engine@worktree` serves the persistent private CFD preview.
Finite controller verification defaults to `progressive-test-engine@worktree`,
with its own local gateway, Redis, worker, result/cache volumes and network.
Both use repository AG24 geometry,
local result/cache volumes and no production credentials or object bucket. Apply
it through the coordinator, not direct host Docker commands. The finite canaries
exercise subsonic, transonic, Mach-2 and Mach-3 dictionaries and actual force output;
their short startup histories are not converged polar validation and are never
published as campaign results. Inspect the deployment's current state before
using its allocated gateway port; a declared surface is not proof it started.
The independent `local-steady-check` surface exercises the native five-field
steady detector with must-certify and must-reject fixtures before its bounded
supersonic trial. None of these numerical fixtures becomes catalog geometry
or public solver evidence. Do not reset the persistent preview engine as if it
were still disposable verification state.

## User-visible outcome

### Supplemental prediction repair

Missing NeuralFoil predictions may be retried after their original campaign stage
has advanced. The explicit operator command is
`pnpm --filter @aerodb/sweeper predictions:repair <campaign-uuid> <maximum-count>`
(1–256 repairs). It refuses an engine without `neuralfoil_geometry_fit_version=2`.
Deploy the verified prediction implementation before running it; this command does
not rebuild an engine or relax its maintenance prerequisites.

Repair receipts and their attempts are separate from original campaign work.
The original gap, attempts, generation stage, CFD units, and CFD ownership remain
unchanged. A successful repair validates the same sealed physical target, angle
grid, numerical recipe, model provenance, and geometry limits as initial baseline
ingestion. It inserts a real prediction and queues a fitted-curve refresh, allowing
compatible existing CFD evidence to refine it without rerunning the campaign.
Existing predictions are not replaced. Paused/cancelled or obsolete scopes cannot
start repairs; failures and expired leases remain recorded with bounded retries.

The geometry fallback retains every original contour vertex and adds only points
on existing straight segments, at most 0.01 chord apart and 8192 fit points. It is
used only after the native eight-weight fit fails the unchanged geometry limits.
The same validated representation is used for inference and its method is stored
in prediction provenance. This is not a geometry correction or an aerodynamic
accuracy certificate; unsuitable profiles remain unavailable.

Every existing and new campaign first produces complete NeuralFoil prediction
curves, then improves coverage with bounded fast OpenFOAM calculations, and finally
resolves the original angle targets with precise OpenFOAM. These are strict stages
within a sealed campaign execution generation, not overlapping per-polar ladders.
Campaign priority applies before stage, least-covered target and information gain.

Public Detail and Compare put curves first. Points are opt-in. Method comparison
and a "Why this curve" disclosure explain the actual prediction, contributing
evidence, uncertainty, unresolved regions and convergence status. A location on an
estimated curve is not a solver result and cannot open nonexistent field media.
Ranking and exported metrics use the same versioned composite cache.

The public curve read model supplies per-method summaries from the exact cached
samples. Extrema refer to the stored angle range, not a certified stall boundary;
maximum lift/drag uses positive lift. Zero-lift drag requires one unambiguous
crossing and zero-angle moment requires an exact sample or bracket. Missing,
ambiguous or invalid values stay null, without extrapolated or sentinel defaults.
Detail keeps the summary tied to the selected condition and primary method.
Comparison joins physical conditions through a separate versioned value identity
that excludes only airfoil identity and coordinate geometry, not material, flow,
reference dimensions, boundary inputs, transition assumptions or sweep branch.

## Evidence and identities

Remote execution uses the same versioned physical-case request as local execution.
The hub composes the request before assignment; workers do not select a numerical
method, change the angle list, replace mesh settings or enlarge the remaining time
allocation. A content fingerprint binds that complete request to its campaign
generation, physical target, execution UUID, per-unit attempt tokens, registered
worker and promise. The fingerprint detects changed content; existing authenticated
solver ownership, not the fingerprint alone, authorizes delivery.

Dispatch is separately owned execution metadata. Expired or cancelled promises do
not release the worker's reserved CPU slots until the exact execution has a stored
physical-stop acknowledgement. The hub's local queue, submission recovery,
reconciliation and disk cleanup must not operate on an execution assigned to
another worker. Legacy remote claims cannot schedule campaign presets, later
revisions of those presets or progressive execution variants around the ordered
controller; ordinary standalone preset claims retain their existing access and
capacity policy.

Assignment discovery is paged and authenticated with the registered worker's
existing credential. Fetching an assignment returns the exact sealed request and
the actual promise/receipt state; it is not permission to restart expired work.
Expired assignments remain discoverable until their exact physical stop has been
acknowledged. Discovery never creates solved points or changes execution status.

A separate authenticated start check verifies the current epoch, campaign stage,
exact case leases, request, worker identity, admission state and existing transfer
permissions. Its first authorization has a fixed deadline, bounded by the case and
promise leases and at most two minutes. Replays do not extend that deadline. This
records permission to submit the exact execution UUID, not proof that OpenFOAM has
started; actual engine status and physical-stop evidence remain separate.

The start response includes the hub's current database clock. Workers derive the
remaining authorization window from that clock and their local monotonic request
start, rather than granting the original full window again after a replay or
assuming that the two servers' wall clocks agree. A separate, compact continuation
read checks whether an already assigned execution still belongs to the current
campaign. An expired start window alone does not stop existing computation, and a
continuation response never authorizes a new submission.

Workers commit an immutable submission intent through the existing global CPU
admission gate before contacting the engine. A second pass through that same gate
rechecks capacity and the unchanged request immediately before submission. Lost
engine responses retain CPU ownership and reconcile only the original execution
UUID; they do not allocate another attempt. A missing result file is not the same
as a missing engine job and must not trigger cancellation of a healthy run.

Assigned worker jobs have their own observation and cancellation path. Ordinary
orphan recovery and retention cannot clear their ownership. A worker releases its
local reservation only after recording a verified stop proof; the hub independently
retains its assignment reservation until it acknowledges that exact physical stop.
Cancellation before engine registration can carry a real zero-case engine status
with a verified never-started fence; it must not invent the requested case count or
any solver evidence.

Workers persist ordered immutable reports before delivery. A lost response retries
the same sequence and bytes; only the hub's matching execution, sequence and content
signature acknowledge that local outbox row. Both ends retain unconverged attempts
and stop evidence in reports, reject regressions, and keep receipt storage separate
from canonical evidence ingestion. Pausing new computation does not discard or
prevent final report delivery; the existing transfer-maintenance pause still stops
new transfers. Changing the configured upstream cannot redirect an old report.
An independent notification-driven service delivers these reports even while an
archive upload is blocked. Settings changes wake a paused delivery service; failed
publications retry the same immutable outbox entry rather than waiting for another
solver observation. Shutdown observes the in-flight bounded publication.

Assignment intake pages through the whole registered worker queue with a durable
cursor; failed imports remain retryable on subsequent passes. Intake preserves the
hub request, and the worker scheduler submits it through the shared CPU gate rather
than replanning its angles. Hub preparation uses fresh observed gateway capabilities
and remains independent of local CPU saturation. Recovery selection stays with the
worker that owned its parent execution; local recovery cannot claim remote parents.

The separate report projector records measured active time and exact physical stops
without turning raw report coefficients into accepted evidence. Terminal jobs await
artifact ingestion, and cancellation cannot be undone by an older running report.
Worker evidence staging uses the existing immutable-attempt importer only after
the hub acknowledges the exact report. A durable ingest lease retains the previous
job state across a process restart, including cancellation. Immutable receipts bind
each staged attempt to its report and exact physical-case content signature;
interrupted staging can replay without duplicating the attempt. This path bypasses
the old worker-owned recovery scheduler. The hub archive broker checks progressive
uploads against the same reported case and manifest checksum/size before issuing
an upload session. These checks do not substitute for canonical point publication.
An independent notification-driven service stages acknowledged worker reports and
sends compact point identities and report signatures without waiting for the bulk
transfer loop. It wakes on acknowledgement, staged evidence, maintenance settings
and durable retry changes, and waits until a stored retry or ingest-lease deadline
when necessary. Failure self-notifications cannot bypass its error backoff. The hub derives values,
method provenance and histories from its exact stored report, not from coefficient
values supplied in that delivery. Its immutable retained-attempt receipt permits
idempotent retries but neither fulfills a promise nor authorizes local cleanup.
Unconverged evidence remains distinct from accepted points. The full archive path
carries the same source proof; a prior compact receipt must not suppress later
publication when the complete evidence passes the still-current execution gates.
Existing receipts may replay after cancellation without reopening that execution.
Interrupted worker staging retains its actual attempt evidence and prior job state,
defers that exact report with a durable retry deadline, and permits other eligible
reports to be staged. The selected sequence is passed through the claim boundary;
the stager must not rediscover an earlier deferred report. Successful staging
clears only its own retry record.
An older worker's late failure cannot recreate a retry after a replacement has
already staged that report. Archive references prefer the source report already
acknowledged by the hub, even if an earlier report is staged later.
Transient compact-delivery failures receive a durable retry deadline; an exact
source conflict remains blocked instead of repeatedly occupying the transfer loop.
Other eligible sources can continue. A successful exact replay clears its own
failure record, not unrelated delivery failures.

The hub also returns a separately signed progressive archive-custody receipt after
the exact source attempt, generation-pinned verified blob, current archive and all
manifest-member associations are present. It names the source report, remote and
canonical attempt identities, and immutable archive identity. Unlike an accepted
point binding, it does not certify coefficients or fulfill the promise. Compact
deliveries without an archive return no custody receipt. Receipt verification uses
the existing registered-solver credential with a distinct receipt kind and signing
domain. Local deletion still requires the separate fresh generation-pinned restore
proof; receiving custody alone does not invoke cleanup.
The worker verifies custody against its acknowledged source and prior compact hub
receipt, then stores it immutably and idempotently. Accepted-archive delivery uses
this record as a separate step before its existing fulfillment checks; cancelled
execution state is not changed by retaining a receipt.
After credential rotation, an exact receipt may be authenticated with the current
credential without replacing its original stored signature. Changed archive or
canonical identities remain conflicts.

Closed scheduling leases permit archive admission only for a previously retained
exact progressive source, original registered owner, physical case and manifest.
This does not admit an unacknowledged attempt or reactivate work. It can retain an
older attempt without changing an already fulfilled promise's selected generation.
Credential revocation and upload-capability expiry remain effective. See decision
`progressive-late-archive-custody-2026-09-07`.

Rejected or noncurrent worker attempts have a separate archive-only delivery path.
It claims an already acknowledged source, streams its actual local archive through
the existing broker, and persists signed custody without requiring accepted
coefficients or renewing the scheduling promise. Claims and bounded retry deadlines
are durable per source, so an unavailable archive does not repeatedly monopolize
the transfer pass. Existing accepted-current delivery remains on its fulfillment
path. Neither path treats archive custody alone as authority to delete local bytes.
Archive-only requests explicitly suppress canonical-point selection and promise
fulfillment even when the retained attempt's coefficients are eligible. The hub
requires a prior exact-source receipt and the real manifest plus brokered archive
for that mode; a later ordinary accepted publication can reuse the bound archive.
Disabling new remote computation does not strand retained-source archives; the
separate transfer-maintenance pause still prevents new archive claims.

Every received report now records a sealed source inventory, including an explicit
empty inventory when nothing was calculated. Exact duplicates listed as both points
and attempts share a source hash; different raw generations remain distinct, even
at the same angle and case name. Earlier sources remain inventoried when later
reports omit them. The index contains identities only, not replacement coefficients
or acceptance decisions. Existing reports are backfilled one at a time through
validated progress reconciliation without replaying an already applied running
state over a terminal job. Completion checks the historical set rather than only
the final report: every source needs an exact raw-evidence receipt, and every
declared manifest needs its verified archive and authenticated member set. Sources
without a declared archive remain raw evidence, not fabricated archive receipts.
An inventory alone does not prove retention. See decision
`progressive-remote-evidence-inventory-2026-09-07`.

Physical stop releases CPU ownership independently of evidence delivery. The worker
continues observing a stopped execution until it reads terminal output (or has an
exact never-started cancellation fence), rereading after the producer stop fence
to avoid freezing an earlier partial snapshot. Terminal result content then stays
immutable; new observation timestamps reuse the existing report. A later report
cannot replace or remove final result content. See decision
`progressive-remote-final-report-2026-09-07`.

The hub reconciles stopped executions after their progress reports have been applied.
It waits for historical raw evidence, declared archives, and separate publication
of accepted final points before recording terminal ingestion and settling units.
Stored early-RANS promotion metadata is recovered from the original report even
when the final report omits it; the normal exact-scope recovery planner validates
the trigger, attempted angles and intentionally unattempted remainder. Settlement
is idempotent, waits for pending fast fits where necessary, and does not invent
attempt rows for omitted angles. Reports replayed after terminal ingestion cannot
reopen the job. Cancelled or obsolete campaign scope releases its stopped units
without claiming that outstanding evidence was received.

Real archive transport and restore-before-reclamation, actual original-worker mesh
availability and two-host runtime proof remain integration work. Focused isolated
checks cover source identity, retry and cancellation, unconverged-evidence retention,
independent report delivery and evidence-to-stage settlement; these are not a
claim that remote production solving is enabled. See decision
`progressive-evidence-first-delivery-2026-09-07`.

Keep canonical physical setup, numerical recipes, execution policy, predictions,
observations and published model versions in separately owned records. Immutable
CFD evidence retains its exact mesh/numerical compatibility identity. Fusion has
a separate physical target: geometry and profile, flow state, reference geometry,
boundary/transition assumptions and hysteresis branch must match. Only explicitly
related fast and precise recipes contribute to that target.

Actual NeuralFoil output is stored as prediction data with package versions,
weight checksums, geometry-fit error, operating inputs and transition assumptions.
It is not OpenFOAM evidence. NeuralFoil analysis confidence is not a calibrated
aerodynamic standard error. Error-model calibration and its validation evidence
must remain explicit. Unvalidated models may be inspected as preliminary estimates
but cannot satisfy final numerical/uncertainty validation.

The progressive model combines a prior, a fast-method discrepancy and a
precise-method discrepancy. One independent anchor supports a regularized global
offset; two distinct angles support a slope correction; further points support
local changes. Drag is modeled in log space. Unsupported regions remain uncertain;
contradictions increase uncertainty rather than forcing an apparently exact fit.

Multiple real URANS histories across angles contribute jointly through disjoint
physical-time blocks. Weight irregular samples by elapsed time; account for
temporal correlation, drift and shared continuation lineage. More saved frames do
not automatically mean more independent information. RANS iterations are weak
numerical evidence, not physical periods. Statistical certification, numerical
convergence and eligibility to inform an estimate are independent classifications.
Divergent, corrupt, nonphysical, mismatched and startup-only data are excluded.

The engine exposes bounded joint fitting at `/predictions/progressive-polar`.
Fitted curves are persisted separately from solver results, together with exact
prediction and attempt references, source and model signatures, uncertainty
policy, and a replay manifest. The manifest references immutable raw histories
rather than copying their samples into every model revision. Excluded attempts
without measurements carry null coefficients, never replacement zero values.
New or removed source evidence, changed review verdicts, classifications and
stored history interpretations invalidate the current cache and any older fit
lease; the public reader falls back to the stored NeuralFoil curve until a fresh
fit is published. Replayed receipts, review-note edits and classification timestamp
refreshes do not invalidate an unchanged model.

The event-driven progressive service builds fit requests directly from stored
evidence. It avoids fitting an unchanged NeuralFoil-only prior, respects the global
stop gate, and does not run on a remote-solver instance. Overlapping histories
from one execution lineage are represented once, with excluded attempts retained
in the explanation. Actual retained histories are reduced into a bounded number
of time-weighted blocks; numerical iterations never become independent shedding
periods. Correlation time is used only when a stored interpretation supplies it.

The initial covariance and numerical-noise policy is explicitly unvalidated and
content-versioned. Its error floors are working assumptions, not measured solver
accuracy or a conversion of NeuralFoil confidence into physical uncertainty.
Displayed intervals remain conditional on that policy. A changed policy queues
replacement models rather than silently treating an older fit as current.
Main-loop activation, shared Compare/ranking/export integration and real CFD
deployment verification remain separate outstanding work.

The current model also returns a versioned next-point acquisition estimate.
It integrates conditional covariance reduction over the requested angle grid,
with trapezoidal weights for irregular spacing and equal relative contributions
from lift, log drag and pitching moment. A separate supported-angle envelope
term accounts for extending coverage. These are model-based estimates under
fixed current hyperparameters, not measured improvements in aerodynamic accuracy.
Every new real observation refits the model before another adaptive decision.

The stage controller waits until every initial fast anchor in the finite
generation has settled and every bound engine execution has a physical-stop
receipt. Adaptive decisions retain the exact model and measured cost evidence;
cost uses the upper median of cumulative durations, counted once per execution
attempt rather than once per history update. Temporary fit work cannot silently
close the stage or block another ready campaign. Terminal fitting gaps remain
explicit and allow the precise stage to proceed.

Precise-stage closure requires the entire sealed requested angle list to be
settled. Gaps produce an attention state, not a completed polar. Campaign
completion is reconciled separately after pending profile-expansion requests
settle, so a completed generation cannot strand its campaign. Paused campaigns
remain paused; cancelled campaigns and obsolete calculation epochs do not
advance. These paths pass database integration checks, but live CFD admission
and production deployment are not yet activated.

Claims which expire before any engine job is bound are recovered separately.
They can retry once without inventing solver time or evidence; exhausting those
bounded claims leaves explicit gaps. Expired claims already bound to jobs are
never reclaimed by this path. An evidence-free fast gap does not wait forever
for a fit which requires CFD evidence. The service includes unbound lease expiry
in its next wakeup while preserving the normal scheduling stop controls.

## Numerical methods and priorities

OpenCFD 2606 remains the pinned CFD distribution. Fast versus precise is numerical
fidelity, not a synonym for RANS versus URANS. Non-reacting air through Mach 3 is
in scope; adding support does not silently add new conditions to existing campaigns.

- Low Mach, with adequate local sonic margin: `simpleFoam`, with bounded
  `pimpleFoam` fallback where actual unsteadiness requires it.
- Compressible subsonic/transonic flow below Mach 1.2: `rhoSimpleFoam`, appropriate
  transonic settings and `rhoPimpleFoam` fallback. Shock-related fallback must be
  diagnosed, not selected from iteration count alone.
- Mach 1.2 through 3: `rhoCentralFoam`, with suitable energy/thermodynamic models,
  shock-compatible discretization, mesh and time-step control. Newly materialized
  fast recipes use local pseudo-time RANS, first-order upwind reconstruction,
  a wall-function target y+ of 40 and at most 5000 iterations within the same
  900-second per-anchor allocation. Precise work retains physical-time integration
  and its requested mesh. The requested y+ is not a measured wall-resolution result.

Primary pressure-based RANS does not become accepted merely because SIMPLE stops
at its first residual convergence. Within the original iteration cap and shared
active-time allocation, the producer can continue in 200-iteration segments until
the existing raw Cl/Cd/Cm hold test certifies stability. It changes complete
dictionaries atomically between stopped solver processes, retains each segment's
settings and native log, and restores the original setup afterward. Forced-URANS
initialization and density-based calculations do not use this continuation.
Missing hold proof leaves the attempt provisional; it also excludes those fields
from accepted warm-start donors. Mesh reuse is unchanged.

An experimental, not-yet-deployed guard treats potential-flow initialization as
only a proposal for the initial velocity, not
compressible CFD evidence. Its complete finite vector field must fit the selected
gas's available stagnation enthalpy above the material's minimum temperature.
An inadmissible proposal is retained with its checksum and measured peak, while
the exact original freestream velocity is restored. Pressure, temperature and
material properties remain unchanged. The producer does not clip velocities or
extend the gas model's temperature range. This necessary energy check does not
certify convergence or aerodynamic accuracy.

Local pseudo-time advances individual cells with numerical steps to seek a steady
solution; its iteration coordinate is never a physical URANS history. The sealed
recipe and derived solver snapshot identify the time coordinate, and local/remote
job composition rejects a mismatched wave. Accepted local-steady CFD requires a
native version-2 certificate corroborated by 100 consecutive normalized update
residuals for density, momentum, total energy, k and omega. A force plateau or
bounded oscillating mean alone cannot certify this mode. Nonconverged informative
iteration histories may only contribute to the separately labeled estimate.
An explicitly diagnosed unsteady recovery changes the immutable time coordinate
to physical time rather than relabeling local iterations as seconds.

The real high-Mach controller check demonstrates a prior followed by two-angle
refinement from unconverged numerical histories, not aerodynamic accuracy or
accepted Mach-3 CFD. Mesh/model validation and uncertainty calibration remain
necessary. Density-based upwind requests now select upwind reconstruction for
all density, velocity and thermal fields, including conservative retries.

Mach, density, energy and force normalization come from the same physical gas
state. Keep fully turbulent SST targets compatible with forced-transition priors;
natural-transition assumptions are separate targets. Unsupported roughness is not
silently replaced with a smooth-wall baseline. AeroSandbox compressibility
corrections are low-fidelity priors, not validated shock solutions.

The material-to-request adapter uses the explicit material-owned gas model when
selected, preserving it in immutable setup snapshots. It supports sourced NASA7
heat capacity and independent polynomial viscosity/conductivity. Without that
model, the legacy adapter remains a calorically perfect approximation derived from
reference density and sound speed; it rejects tabulated viscosity rather than
silently fitting or extrapolating it. The seeded Air record is not automatically
replaced by the audit model. Production model installation and physical validation
remain separate from the implemented persistence and request contract.
Compressible request validation also checks that the declared NASA7 upper
temperature can contain the freestream enthalpy plus its kinetic energy. It uses
the supplied variable-heat-capacity enthalpy, not a constant ambient gamma, and
rejects an insufficient material range before case staging. This adiabatic
stagnation preflight does not prove that local expansions or numerical excursions
remain inside the lower/upper material bounds during a calculation; live-domain
validation remains required. The physical relation is documented by NASA Glenn's
Conservation of Energy guide:
https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/conservation-of-energy/.

The pinned OpenCFD 2606 source registers Sutherland transport with JANAF calorics,
perfect-gas density and sensible internal energy. Its JANAF temperature limiter
warns and clamps outside the declared range; selecting that model alone would not
prove that a Mach-3 trajectory remained within its validated material range.
The explicit engine request contract accepts sourced NASA7 coefficient sets
with Sutherland or polynomial transport, uses temperature-dependent heat capacity
for sound speed, and writes the matching JANAF dictionary. The worker registers
the polynomial/JANAF combination through the pinned OpenCFD templates. Input
validation checks both polynomial
branches, including interior minima, and refuses temperatures outside their bounds.
The declared join tolerance checks heat capacity, enthalpy and entropy continuity;
it is a numerical input constraint, not a claimed error bound on real air data.
Material persistence, source-fitted properties and live JANAF-clamp rejection are
connected and exercised by isolated native and controller checks; this is not
physical Mach-3 polar validation or production rollout. See
[the material model and its verification limits](air-material-model.md).
Analytic test coefficients are isolated fixtures and are never installed as catalog data.
The exact source contracts are
[psiThermos.C](https://gitlab.com/openfoam/core/openfoam/-/blob/481094fdf34f11ed6d0d603ee59a858a0124236d/src/thermophysicalModels/basic/psiThermo/psiThermos.C)
and [janafThermoI.H](https://gitlab.com/openfoam/core/openfoam/-/blob/481094fdf34f11ed6d0d603ee59a858a0124236d/src/thermophysicalModels/specie/thermo/janaf/janafThermoI.H).

Every polar receives two separated initial fast anchors before already-covered
polars receive extra anchors: near predicted zero lift and best lift/drag, snapped
to the requested grid. Additional anchors maximize normalized integrated
uncertainty reduction per measured compute cost. Initial defaults are at most
eight angles, a five-percent marginal-gain stopping threshold, and fifteen minutes
of active solver time per anchor across an initial attempt and one diagnosed retry.
Bounded failures close the fast pass with explicit gaps, allowing precise work.

The engine's `case_solver_budget_seconds` limits cumulative solver-command wall
time for one chord/speed/angle within a job, including initialization and retries.
Meshing, media and MPI decomposition/reconstruction do not consume that allowance.
`solver_active_seconds` reports measured cumulative time, not an estimated cost;
repeated snapshots of the same case must be reconciled by their cumulative value,
not summed. Durable cross-job budget reconciliation and stop acknowledgement remain
part of controller integration, not an inference from a lease timeout.

Allocation contract version two additionally supports `case_solver_allocations`:
one exact chord/speed/angle and remaining active-time limit for every requested
case. It is mutually exclusive with the shared scalar budget. Both API and worker
check `expected_solver_budget_version` before CFD; missing or mismatched capability
holds progressive admission without spending a case attempt. Historical uniform
request/evidence decoding remains available but does not authorize an unproven
engine to run the campaign. A capable worker can march a partly spent
retry beside a fresh sibling without shortening either allocation. Initialization
and recovery share each case's own cumulative counter, and live/final evidence
must acknowledge that exact allocation. Separate immutable recovery plans preserve
the original numerical recipe, exact parent execution and diagnostic evidence.
Only a structured hard RANS failure at inclusive zero through five degrees in a
continuous request promotes that original angle list to preliminary URANS.
Other eligible failures remain targeted; infrastructure and deterministic mesh
failures never establish an unsteady diagnosis. Omitted angles have no invented
RANS evidence, and all replacement requests retain the original mesh settings.

Compute policy `progressive-compute-v2` keeps fast work and ordinary retries limited
to two submissions. Older sealed policies cannot acquire the new third submission.
During precise
work, an accepted preliminary URANS result from original-sweep recovery may
authorize exactly one third submission for full URANS verification. That separate
immutable plan does not add solver time: all three submissions share the original
physical-case allocation. Rejected preliminary evidence, exhausted allocations
and unsupported recovery remain explicit gaps. Preliminary URANS alone cannot
complete the precise stage. Controller fixtures cover this sequence; actual
engine/controller recovery, scientific validation and distributed execution are
still required before production readiness.

Engine cancellation now distinguishes an accepted cancellation request from a
verified execution stop. A worker-side stop proof requires a durable cancellation
marker or terminal result, the original process namespace, an available exclusive job-execution lock,
and a readable process inventory with no remaining job children. The API accepts
only the final, post-revocation reaper's exact-job proof. Missing, older or
unreadable evidence leaves `execution_stopped` false; sending a signal alone is
not completion. Cancelled redelivery does not restart work or replace its recorded
owner. Naturally completed jobs use `/jobs/{id}/execution-stop-proof` to inspect
their worker without cancelling or changing their results.

A newly queued job also has an explicit never-started marker. Before physical
work begins, the worker records its actual namespace and consumes that marker.
Cancellation before the first worker starts can therefore use the exact
never-started marker, exclusive execution lock, pending/cancelled status and empty
strict process inventory instead of inventing a previous execution owner.
The proof identifies this distinct basis. Missing markers, wrong job identities,
running status, terminal-result substitution, unknown namespaces or remaining
children still refuse a stop proof; cancelled broker redelivery cannot launch work.

Progressive requests allocate one UUID before submission and retain the exact
transport request. Gateway registration serializes dispatch with cancellation;
identical replay cannot enqueue again, and changed content cannot reuse that UUID.
Dispatch and cancellation receipts survive ordinary job-directory retention in a
separate submission registry. The explicit solver-domain reset clears that
registry together with the other disposable runtime state.

Interrupted submissions retain their unit and result ownership across sweeper
restart. After the submission grace period and lease expiry, recovery fences that
exact UUID, including a request that never reached the gateway. No-start proof
permits one bounded retry without inventing CFD attempts or elapsed solver time;
any retained solver attempt contradicts that proof. A started execution remains
bound until its final histories are ingested. Missing cancellation acknowledgement,
unavailable process inventory and mismatched identities never release units.
This recovery is integrated into reconciliation. Startup runs the event-driven
baseline, fitting and stage service alongside controller reconciliation. Both
services share shutdown ownership, and either service failing or exiting early
stops and awaits its peer before the database closes. The controller tick now
fills local capacity exclusively through progressive CFD admission, preserving
hazard, disk, engine-health and capability checks. It does not fall back to old
automatic campaign or continuous-polar admissions when progressive work is not
ready. Assigned remote jobs have a dedicated admission branch; existing standalone
remote work retains its own non-campaign path. Remote reconciliation and transfer
maintenance remain live. Full remote artifact ingestion and real-engine verification
of bounded precise recovery are still unfinished.
Explicit administrator point-correction requests retain their separate targeted
lane and share the same CPU capacity; this does not reopen automatic legacy
campaign or continuous-polar scheduling.
Transient CFD is claimed only when the gateway reports the exact pinned unsteady
contract. Unknown or mismatched capability leaves those finite attempts untouched
while compatible steady targets can still use available CPU slots.

The progressive admission entry point now composes and reserves a whole fast or
precise polar under the existing scheduler lock, then submits its stable UUID
through the ordinary serialized hazard gate. It shares the same CPU capacity
calculation as the controller and checks paused, disk-blocked and remote-only
states before claiming. Unavailable composition rolls back without consuming a
finite attempt. An ambiguous dispatch retains its reserved slots. Campaign jobs
without the progressive execution contract cannot fall back to legacy admission.

Bound progressive jobs reserve their actual CPU allocation until the exact engine
execution has a persisted physical-stop acknowledgement, even if a coarse job or
attempt status says cancelled, failed or done. That proof releases CPU capacity,
not evidence ownership: terminal histories must still be ingested before the units
settle. Legacy jobs retain their existing reservation rules. Progressive failures
and cancellations never enter legacy missing-job retries or cancellation handlers.
An unexpected acknowledged engine identity remains quarantined with its reservation;
the controller must not poll, cancel or ingest an unrelated execution to clear it.
Status/result identity mismatches likewise cannot establish completed evidence.
Cancelling a generation finishes only unbound claims immediately. Bound attempts
remain owned until stopped, including submissions with no acknowledgement yet;
obsolete scope bypasses the normal submission grace period to obtain that proof.
A replacement generation cannot start the same campaign/physical target while
any earlier generation still owns an unacknowledged physical execution.

Each measured case outcome can now acknowledge the versioned per-physical-case
budget actually enforced by the engine. The controller verifies its exact limit
against the immutable request and remaining allocation before persisting it with
the evidence receipt. Exhausting that guarded angle blocks further work on the
angle without cancelling its siblings. Missing guard evidence retains conservative
whole-job cancellation; obsolete campaign ownership still cancels regardless of a
guard. Neither guard acknowledgement nor a fitted curve replaces the final
whole-job stop and ingestion requirements. Nonblocking elapsed-time snapshots now
pass through the worker heartbeat and exact-job status API with their original
observation time. The controller stores them separately from solver evidence,
checks the physical case and budget allocation, rejects changed replays and
decreasing counters, and combines runtime and final durations by cumulative
maximum rather than addition. A progress-only case never becomes a polar point.
Runtime guard acknowledgement protects sibling execution at the case limit while
final ownership release still waits for physical stop and evidence ingestion.
Production admission and distributed runtime verification remain unfinished.

Stop acknowledgements are persisted immutably against the exact epoch, engine job
and unit tokens. Unit settlement waits for both this proof and terminal ingestion.
The normal reconciliation pass performs these stop checks even while scheduling is
paused. Progressive jobs use a separate ingestion path: cancelled final histories
are retained after a physical-stop proof, omitted angles stay absent, and the legacy
RANS-to-URANS handoff cannot launch replacement work from that ingestion. A terminal
job status without a completed ingestion stamp cannot settle current-scope units.
Transient retrieval failures remain retryable and do not consume a running job's
completed-case publication counter.
Informative fitted evidence may complete a fast anchor, but precise work requires
accepted stored RANS or full-URANS evidence; an estimated curve alone cannot complete
it. Diagnosed infrastructure failures and immutable numerical recovery plans may
receive bounded retries with measured budget remaining. Exhausted, uninformative
and unresolved cases remain explicit gaps rather
than invented successful points. Adaptive stage advancement, main-loop activation
and distributed-runtime verification remain controller work.

Compressible requests carry an explicit gas law, pressure/temperature state,
solver family and pinned turbulent Prandtl. Density and viscosity must agree with
that state. The runtime selects pressure-based or density-based commands without
changing the shared engine dialect. Density-based runs skip pseudo-steady and
incompressible potential-flow initialization. These routing contracts have focused
regression coverage; real numerical canaries and Mach-3 accuracy validation remain
separate readiness requirements.

The isolated `progressive-numerics` development deployment executes AG24 integration
smokes at Mach 0.72, 0.9, 2 and 3 using the real OpenCFD runtime. Its numerical
containers have no network, broker or production credentials; a separate read-only
artifact server exposes the retained case directories. Every invocation creates a
new directory rather than overwriting an earlier failed run. Mesh checks use the
production quality gate, retain anisotropy warnings and refuse incomplete verdicts.
Receipts record measured solver time, finite force-sample counts and mesh diagnostics,
and explicitly state that converged polars have not been validated. The transient
smokes integrate only one microsecond: passing them establishes executable dictionary
compatibility, not settled flow, shock accuracy or a publishable polar. These checks
do not replace the representative physical validation described below.

Precise work covers every original requested angle, prioritized by missing data,
uncertainty, stall and drag rise. A steady solution need not become URANS.
Distinguish periodic, stationary aperiodic and drifting behavior. The initial
twelve-hour ceiling is finite; continuation requires measured quality progress.
Exhaustion remains unresolved work, not successful campaign completion. Reuse
compatible meshes and warm starts. Benchmark physical cores versus SMT/MPI by
useful throughput rather than assuming nominal thread count means equal capacity.

## Catalog growth and lifecycle

Database-owned enrollment detects public/admin uploads, bulk imports, sync and
direct SQL insertions. It is restart-safe and idempotent. New profiles join finite
sealed expansion batches without rerunning old results or continually resetting
an in-flight stage. Materialize from campaign intent, not whichever solver points
survived a reset. Preserve original intentional profile exclusions.

Active and attention campaigns expand. Completed campaigns reopen only additional
work. Paused campaigns acquire pending scope but stay paused. Cancelled and
archived campaigns neither schedule nor reactivate automatically; they catch up
after explicit reactivation. Unarchiving does not itself un-cancel or unpause.

## Reset and rollout

Stop both hosts' admission and result writers before the reset. Restore-test a
configuration-only export outside GCS, retaining geometry, campaign identity,
membership, conditions, original targets, plan/lifecycle history, reusable setup,
authentication, remote registration and connection credentials.

Delete old solver rows, artifacts, caches, recovery work, deliveries/promises,
queues, live cases and old solver database backups. Delete all live and noncurrent
objects in the dedicated GCS bucket without changing bucket/IAM/soft-delete policy.
Soft-deleted generations expire according to that retained policy. Generation
fences reject delayed old results. Append reset/replan history and reset execution
counters without pretending the historical campaign request never existed.

For a cleared solver domain, `packages/db/src/prepare-progressive-reset-cli.ts`
reads an exact campaign id, expected plan revision, material id, sourced gas model
and source reference from standard input. Run `--rehearse` to execute the entire
transaction and roll it back, then `--apply` against the same unchanged target.
It requires disabled admission and no existing solver data or campaign requests.
It appends an unchanged campaign plan with reset provenance, resolves new material
snapshots without altering historical revisions, and restores requested angles
using the existing symmetry rules. Changed operating or numerical setup values
require an explicit replan rather than being silently adopted.

Deploy the same tested pushed-master revision to the VPS and hz-solver2 using the
canonical deployment wrappers. Restore their deployment roles and verified capacity,
prove real distributed work, incremental evidence ingestion and public curve updates,
and do not call the implementation complete based on unit tests alone.

## Verification

Windowed URANS histories carry `source_start_time`, the first recorded source
coefficient time before startup discard or period selection. The retained `t`
array still describes only its original selected window. Uncertified-history
startup age is measured from that recorded origin, never from an assumed zero
or the first already-trimmed sample. The reduction starts at the later of the
producer's window start and the required post-startup elapsed time; an earlier
window prefix does not discard an otherwise informative suffix. The suffix must
still contain enough real samples. An unknown legacy origin is omitted from
serialization and retains the conservative existing fallback. An invalid origin
cannot contribute evidence. This metadata does not certify convergence or relax
the retained-coefficient and physical-window checks.

Validate numerical recipes on representative low-Mach airfoils, RAE 2822 transonic
cases, a Mach-2 wedge, a viscous supersonic airfoil and Mach-3 cases. Perform mesh and
time-step studies on these representative recipes, not on every production cell.
Validate uncertainty with held-out whole profiles and conditions. Keep numerical
verification separate from physical-model validation. Exercise real public
wide/narrow UI journeys, method/evidence controls, lifecycle expansion, stale
delivery rejection, saturated queue responsiveness and recovery after restart.

The RAE 2822 reference in `tests/fixtures/rae2822` preserves the original NASA
Study 1 geometry and measured pressure bytes. Its loader checks hashes and the
documented lower-surface and negative-Cp plotting signs. The condition is Mach
0.729 at 2.31 degrees, not the similarly named nominal Mach-0.725 case. The source
Reynolds number and the value resolved from the selected material are reported
separately; no measurement uncertainty is invented.

Run `rae-reference` through the coordinator before the isolated `rae-fast`,
`rae-precise`, `rae-refined` or experimental `rae-transonic` deployments. These
use separate native jobs so a failed case cannot terminate another deployment.
The original `rae-verification` deployment serves retained first-pass artifacts
only. Reports distinguish convergence, time-budget exhaustion, material-domain
failure and pressure-comparison error. A completed measurement command is not
an aerodynamic accuracy certificate. Experimental transonic pressure correction
changes only a newly generated benchmark dictionary before any solver starts;
it does not change the production recipe.

Progressive archive delivery uses its own notification-driven service. It drains
exact retained sources independently of legacy transfer housekeeping, reusing
the existing claims, oldest-due ordering, custody verification, transfer pause
and persisted retry deadlines. It does not create additional CFD jobs or relax
the remote promise cap.
