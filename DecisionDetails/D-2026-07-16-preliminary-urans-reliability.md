# D-2026-07-16-preliminary-urans-reliability

## User journey and solver sequence

Each angle owns one fidelity journey:

1. **RANS screening** quickly resolves attached steady flow when it can.
2. **Preliminary URANS (fast)** automatically takes over when RANS is not
   publishable. RANS non-convergence is expected handoff evidence and is not a
   failed point.
3. **Verified URANS (final)** refines an accepted preliminary result in the
   background and owns the final high-fidelity generation.

The normal handoff is aerodynamic: a completed RANS attempt is not publishable,
so the same point advances to fast URANS. A deterministic mesh defect or engine
runtime interruption is different because neither RANS nor URANS has obtained
the required physical evidence. The machine must repair that condition
automatically. Only exhaustion of the current versioned mesh/runtime recovery
may stop the rail before fast URANS, and that stop is red, critical, and
system-owned—not a user setup or review task.

An explicit admin **final** request is aggregate ownership of that same
sequence, not a fourth lane or a direct full-fidelity bypass. For every angle
in its exact or whole-polar scope, the controller first reuses or creates the
preliminary obligation, then owns the resulting final-verification queue item.
The request settles only when all covered angles have a final result or a
truthful critical terminal incident. Continuing an already-started exact final
attempt may resume that exact saved state; it does not create a new path around
the preliminary result.

Once one angle's RANS parent is terminal, its preliminary handoff is eligible
for the next free solver slot ahead of unrelated new RANS backlog. It does not
wait for every RANS gap in a large campaign to close.

An accepted preliminary point also owes final verification while the campaign
continues. Final URANS remains lower priority than conditional whole-polar
promotion and targeted preliminary recovery, but it is not allowed to wait for
the entire campaign backlog to disappear. After at most eight newly admitted
wave-1 RANS jobs since the oldest pending/latest verification opportunity, one
pending final-verification point receives the next otherwise-RANS slot. The
admission proof comes from durable job history so a sweeper restart cannot
reset the point to indefinite starvation.

The per-angle interface therefore uses one shared three-stage rail and exactly
one compact row for each requested campaign angle. Symmetry may let two rows
reference one immutable positive-angle solve, but it never collapses the
requested rows or their counts; the derived row identifies its exact source
angle and opens that exact stored result. Queued/running preliminary work is
active automatic recovery.
An accepted RANS point ends the sequence without inventing URANS work. Ordinary
non-publishable RANS evidence hands the point to fast URANS; that handoff is not
a failure. Exceptional RANS recovery exhaustion is critical, and its row must
distinguish a true preflight stop with no attempt evidence from RANS that was
attempted before recovery exhausted. Counts of RANS attempt/evidence rows must
not be presented as confirmed physical runs.
Failure to obtain a preliminary or final result after its automatic recovery
path is exhausted is red, critical, and owned by the system—not a normal user
review or setup-change task. Detailed evidence remains available behind
disclosure, but raw classifier strings, batch names, and mixed attempt counts
are not primary user content.

An accepted exact final URANS generation is the authoritative publishable
result even when its coefficients differ from the earlier fast estimate beyond
the comparison tolerance. Preserve both generations and their stored deltas,
show a concise amber quality/comparison warning, and keep the final result
openable by its stable result id. The warning does not increase critical or
unavailable counts. Likewise, a failed later refresh does not invalidate an
already accepted immutable final generation. This supersedes the older red
`verify disagreed` presentation; red is reserved for automatic preliminary or
final recovery that exhausts without obtaining the required publishable result.

## Production evidence

The 20-32C/Re≈102k cell exposed two distinct reliability defects:

- α10°, 15°, 16°, 19°, and 20° had restartable preliminary evidence in engine
  job `c5f40ddbcc6543f4962291f5c82701a4`. Retention later removed the live time
  directories. Their corrective jobs then ended in roughly 20 ms with zero
  completed cases, zero mesh builds, and “nothing to restart from”, yet the
  submissions consumed the final displayed physical-run ordinal.
- α2° and 3° completed real preliminary CFD runs. Their stored coefficients
  were repeatable, but early-stop period selection and the final stationarity
  gate disagreed. One α3° retry stopped below the physical slow-shedding
  observation horizon. The controller launched a fresh unchanged solve rather
  than extending the retained same-case history.

The immutable evidence archives for the five stripped cases still contain the
mesh, transient dictionaries, force history, and hundreds of restartable field
time directories. This proves the missing results are recovery/runtime defects,
not evidence that URANS cannot solve the points.

The campaign-wide audit found the same pattern beyond that one dialog. On
2026-07-16 the active generation had 26 unresolved preliminary-recovery
obligations, shown by the legacy admin model as blocked:

- five continuation submissions ended before CFD because their live time
  directories had been removed;
- 21 physical preliminary results exhausted the old acceptance path;
- every one of the 26 cells still had immutable checkpoint evidence;
- all 26 latest classifications reported `non-stationary`, 12 also reported
  `insufficient-periods`, and seven reported
  `incomplete-urans-integration`.

This is a repeated controller/runtime incident, not 26 unrelated aerodynamic
failures. Archive hydration repairs the five missing-source cases; adaptive
same-case extension aligns the early-stop and publication windows for the 21
physical results.

The retained α2° archive also exposed a restart-seam defect: an older
`coefficient.dat` segment could end with one inconsistent force row at the
exact nominal start time of its successor. The old merger kept that row and
could mint a periodic impulse train in an otherwise flat wake. The newer
physical restart segment now owns its nominal boundary; raw evidence remains
unchanged and every genuine earlier sample remains in the analysis history.

At α3°, `frame_track` progress fields were null while immutable force history
had advanced to `window_end=0.0746722`. The old no-progress circuit breaker
ignored that real work. Frame tracking remains authoritative, with per-field
fallbacks to force-history time, period, and retained-cycle measurements.

Finally, the exact live `transient_start.json` merge boundary was not included
in immutable evidence, and a cross-job resume always began with a one-period
floor even when its exact source result proved a non-stationary or sparse tail.
The marker is now archived and restored as checksummed continuation state. A
source-proven corrective tail receives three new measured periods only after
its retained-cycle target is met; ordinary shortfall and wall-budget recovery
remain deficit-sized so the fix does not create avoidable timeouts.

The version-2 deterministic mesh ladder was replayed across the 1,621 source
records. It accepts all 1,619 eligible closed airfoils and truthfully excludes
the two open, one-sided source components. GOE451 and FX79W660A, the only
eligible residuals after the structured C-grid candidates, pass the
source-preserving `cartesian2DMesh` fallback, the ordinary `checkMesh` gate,
and real `potentialFoam` plus short `pimpleFoam` canaries on OpenCFD 2606.
Missing tools, timeouts, process kills, unreadable output, and OOM signatures
remain infrastructure errors and cannot be misreported as geometry failure.

The first OpenCFD 2606 preliminary canary exposed one final live-window
mismatch without losing any solver evidence. Its exact transient marker stayed
at zero, all restart coefficient segments merged in physical order, and the
recent 5–20-cycle tail passed the established-oscillation verdict. The live
two-period monitor nevertheless stopped each continuation at exactly four of
its estimated periods. A slightly longer independent autocorrelation estimate
then saw fewer than two periods in each half, rejected that early-stop marker,
and repeated another short continuation. The continuation log independently
re-estimated cadence from the deliberately cropped three-period
`ForceHistory`, so its half-window estimates were deterministically unavailable
even though the full merged evidence was healthy.

Preliminary early-stop certification now keeps the existing half-cycle margin
*after* the four-period independent-half floor, for 4.5 monitor periods.
Continuation cadence and its diagnostics use the same merged, post-startup
coefficient window as live grading, with compact `ForceHistory` only as an
in-flight fallback. Regression evidence covers a two-percent monitor-period
undercut and multi-segment merged history; neither change relaxes the stable
period, density, trend, amplitude, or final-verification gates.

## Mixed-version release gate

The control plane and engine use an explicit integer
`urans_recovery_version` capability contract for continuation and final
recovery:

- engine health advertises the supported recovery version;
- every recovery request pins the exact version it expects;
- the engine API and worker both reject a mismatch before meshing or CFD;
- an engine that omits the capability, including the current OpenCFD 2406
  production runtime, is treated as legacy version 0;
- malformed capability data or a failed capability probe is unknown and fails
  closed;
- continuation and final-recovery work pins the exact live version. Version-2
  numerical recovery remains pending on version 0 or 1, while ordinary RANS
  screening and a version-compatible first-pass preliminary URANS request
  remain eligible.

This permits a control-plane-first deployment without accidentally applying
new recovery semantics to a still-running legacy engine. The guarded OpenCFD
2606 cutover activated version-1 cross-job recovery only after the engine
advertised and enforced the matching contract. Version 2 adds a materially new
in-engine numerical remediation: one structured watchdog/SIGFPE failure
restores a last-known-good same-case checkpoint and retries with first-order
convection, Co<=1, and a smaller initial timestep. Generic non-zero exits,
timeouts, mesh failures, and initialization failures remain infrastructure or
their existing typed class and do not consume this numerical retry.

## Exact production recovery canary gate

The first production proof after deploying the one-shot controller is one
closed-world 20-32C/Re≈102k/α15° chain. It pins the campaign, current condition
generation, parent RANS job, airfoil, revision, AoA, source result and attempt,
preliminary obligation, engine build, mesh recovery version, and URANS recovery
version. It creates at most one marked aggregate FULL owner, requires zero
request-obligation associations before first coverage and exactly the pinned
obligation afterward, and admits only that request's preliminary job or its
linked final-verification job.

The production scheduler stays durably fenced at `enabled=false`,
`max_concurrent_jobs=0`, and `cpu_slots=0`. Before each one-shot admission,
stop the ordinary `node-api` and `sweeper` containers, run the CLI through an
ephemeral `sweeper` service container, then restart those two Node services
immediately after the single JSON receipt is written. This short exclusive
operator window closes the HTTP campaign/request mutation surface and the
ordinary scheduler across the last database/engine probes and exact claim. It
does not stop or recreate the Python gateway or OpenFOAM worker. Keep the
pinned campaign generation administratively frozen until the final receipt is
terminal; if it changes, the next invocation refuses instead of retargeting.
No other one-shot command or direct database writer may run in that window.

The canary's closed-world incident fence is deliberately target-scoped.
Pre-existing legacy incidents and obligations that do not own the pinned
result, obligation, marked request, or verify item are inert because normal
admission is disabled; they neither block nor become eligible through the
canary. The exemption applies only to records that predate this canary and
remain outside its exact ownership chain. A new target-owned blocked state
must have one open critical incident and returns a `critical` receipt. A
target-owned incident without blocked state, or blocked state without its
incident, refuses as inconsistent. Existing legacy incidents remain unresolved
campaign recovery work and must not be presented as cleared.

The exact production invocation must go through the fail-closed wrapper:

```bash
/opt/airfoils-pro/app/scripts/deploy/run-three-stage-urans-canary-once.sh \
  --campaign-id c24047fa-743f-4ae5-bcd6-f3071ff79fb4 \
  --condition-id e2db6c43-2e4a-4b15-b99e-1e2d391543be \
  --expected-campaign-generation 2 \
  --parent-job-id 28d9ac1c-ad4d-4c60-a34b-f090842eeb54 \
  --airfoil-id 4617c7ad-264e-48bf-926c-b24d33e4d7c0 \
  --revision-id fba9c1f7-222f-4399-94ae-4f777b1ef868 \
  --aoa-deg 15 \
  --source-result-id 54d62432-8ba2-4fdb-a27b-39f709f00712 \
  --source-result-attempt-id 266cc794-9498-4a77-baf0-0924e44e34fe \
  --precalc-obligation-id 6515a96c-d80f-4f35-a98d-4a29f30c0d53 \
  --expected-engine-build-id prod-20260717-8e6d9bd32615-r6 \
  --expected-mesh-recovery-version 2 \
  --expected-urans-recovery-version 2 \
  >"$AUDIT_DIR/three-stage-urans-canary.json" \
  2>"$AUDIT_DIR/three-stage-urans-canary.log"
```

The wrapper holds the shared deployment lock, runs the authoritative
environment preflight, captures the exact `api`, `worker`, `node-api`, and
`sweeper` container identities and initial states, and proves both ordinary
Node writers stopped before invoking the one-shot CLI. It restores each Node
service to its independent prior state on every exit path and refuses success
unless both OpenFOAM container identities remain unchanged. Its stdout remains
empty until the one exact receipt has been validated and service restoration
has succeeded.

The engine's accepted `POST /polars` response may truthfully be `pending`
before a worker publishes immutable runtime provenance. In that one state only,
the receipt may report the exact submitted job while its runtime-build foreign
key is still null, provided the job is `submitted`, its engine state is
`pending`, and it already has the acknowledged engine job id. Once either
state leaves pending, the same job must reference the one expected immutable
OpenCFD 2606 runtime-build row and its build label must match the pinned build.
This avoids falsely reporting a failed canary after an irreversible accepted
submission without treating engine preflight identity as invented per-job
provenance.

The accepted production preliminary generation also proved the real ingestion
transition that the original canary fixture had omitted: once preliminary
URANS is accepted, the obligation's source-attempt pointer advances from the
rejected RANS handoff attempt to that accepted preliminary attempt. A repeated
one-shot validation now permits that transition only when the linked final
verification item pins the same accepted preliminary generation from the exact
obligation. The original immutable RANS attempt remains independently pinned
and validated by the canary target. Unit and live-database seam regressions use
this post-ingestion state so final admission cannot regress to the unrealistic
pre-ingestion fixture.

Invoke once to admit or observe preliminary work. After that exact job is
terminal and reconciled, repeat the same exclusive one-shot invocation to
admit or observe final verification. Never loop the command unattended or
widen its identifiers from an open-work query.

## Selected recovery architecture

- Retention protects every recent restartable preliminary attempt, including a
  temporarily blocked/exhausted obligation, until it is satisfied, superseded,
  explicitly non-progressing, or expires under the continuation retention
  policy.
- Deterministic wave-1 mesh failures retain their immutable attempt and are
  reopened automatically only when the live engine advertises a strictly newer
  mesh-recovery strategy. The reopened point returns to its original RANS
  campaign ownership, pins that exact capability version, and never
  masquerades as an aerodynamic RANS→URANS handoff. If the newer
  engine-internal ladder also exhausts, the new occurrence is a rare critical
  screening-recovery incident grouped under that remediation version.
- Continuation first validates live state. If live fields were stripped, it
  reconstructs the exact case from the immutable local or GCS-backed evidence
  archive and verifies paths and archive integrity before solving.
- The checkpoint's immutable solver implementation identity must equal the
  requested and executing runtime identity. OpenCFD 2406 state may continue
  only on the matching 2406 implementation; an OpenCFD 2606 successor starts
  fresh and never merges predecessor coefficient or field history.
- Runtime capability must also equal the recovery version pinned by the
  request. Implementation identity prevents cross-release evidence mixing;
  `urans_recovery_version` prevents a mixed deployment from invoking recovery
  behavior that the running engine does not implement.
- A continuation-source failure is typed before scheduling policy handles it.
  It performs no meshing or CFD and does not spend a fresh physical solve.
  Transient provider/capacity loss returns to the same continuation after
  bounded backoff. A permanently missing, corrupt, or implementation-
  incompatible source records a stable
  `continuation_permanent_failure` incident and stops unchanged continuation;
  it cannot silently become a fresh physical run or an infinite retry loop.
- Non-stationary preliminary evidence extends the same case by a meaningful
  measured-period window so both half-window and final gates can settle. The
  deadline remains bounded, but a fixed small chunk count or blanket percentage
  reserve cannot create a false terminal result while measurable progress
  continues.
- Restart segments have deterministic boundary ownership, and immutable
  continuation evidence carries the exact transient-start marker.
- Cross-job progress uses the strongest available real measurement: frame-track
  values first, then force-history values only for missing individual fields.
- Corrective sizing is evidence-specific: a K-satisfied non-stationary or sparse
  tail gets three new periods, while a short or budget-limited source keeps its
  ordinary deficit-sized continuation.
- Fresh starts remain bounded. Same-case continuation segments preserve one
  physical solve’s accumulated state and immutable audit sequence rather than
  masquerading as independent solver attempts.
- Each pimpleFoam chunk checkpoints its last-known-good time fields and force
  history. A structured numerical failure preserves its failed dictionaries,
  log, force history, and last written fields before the version-2 conservative
  retry restores that checkpoint. A second numerical failure is a critical
  exhausted-recovery result; an ambiguous process exit is infrastructure.
- Same-job extension requires monotonic physical progress from saved simulated
  time or force history. A zero-progress chunk stops immediately with
  restartable state instead of spending the emergency chunk allowance.
- The recorded averaging contract is unchanged by version 2: an ordinary full
  run targets seven retained periods, while an early stop may certify only
  after the established five-period stable floor (plus its existing margin).
- Admin final requests materialize and own the ordinary per-angle preliminary
  and final ledgers for their immutable scope. An existing accepted
  preliminary point is linked directly to its verification item; a missing
  preliminary point runs fast URANS first. The aggregate request cannot be
  marked done while any owned child remains pending, running, or critically
  unresolved.
- Monitoring treats any critical preliminary incident as actionable. Multiple
  incidents with the same signature trigger investigation of the algorithm,
  runtime, storage, or mesh recovery path and a regression before normal
  campaign processing is considered reliable.
- Fast/final coefficient disagreement is stored comparison evidence, not a
  solver incident. The accepted final generation remains canonical and the UI
  presents the real deltas as a non-critical quality warning.

## Rejected alternatives

- **Keep the amber “results unavailable; no action required” state.** This
  conceals a missing required result and makes recurrence operationally normal.
- **Expose all internal attempts in the primary list.** Engine submissions,
  RANS evidence, preliminary windows, and continuation segments have different
  meanings and do not describe the user journey.
- **Start another fresh URANS solve whenever continuation fails.** This loses
  already-paid transient history, remeshes unnecessarily, and can repeat the
  same failure without new capability.
- **Increase the retry count alone.** Storage/setup failures can exhaust any
  numeric allowance without executing CFD, while one-period corrective chunks
  can repeatedly stop before the stationarity estimator settles.
- **Require a user setup change or review.** The system owns automatic mesh,
  solver, and evidence recovery; users should not diagnose internal CFD
  checkpoints to obtain requested polar data.
- **Keep final verification behind the entire RANS campaign.** This preserves
  maximum screening throughput but makes the advertised third stage
  unreachable in a 631,000-point campaign. Giving final work equal priority
  would crowd out fast preliminary recovery. Bounded one-in-eight interleaving
  keeps recovery first while guaranteeing measured final-stage progress.
- **Treat an admin `full` request as an independent direct solve.** That would
  skip the approved per-point sequence, duplicate queue ownership, and give
  manual requests different reliability and incident semantics from automatic
  work.

## Verification contract

Regression coverage must prove:

- rejected RANS is represented as a normal automatic handoff;
- deterministic RANS mesh failure is not promoted to URANS, is not replayed
  unchanged, and reopens exactly once when a newer mesh-recovery capability is
  available;
- the replacement RANS job pins the newer mesh-recovery version, preserves the
  older immutable attempt, resolves only the older mesh incident, and records a
  new critical versioned incident if the newer physical repair also exhausts;
- a live or archive-backed preliminary checkpoint resumes without remeshing;
- a cross-engine or cross-version checkpoint is refused before solve work and
  the successor cell is scheduled fresh;
- a missing capability advert is treated as legacy version 0, malformed or
  unavailable capability data fails closed, and a request/runtime recovery
  mismatch is refused by both the API and worker before solve work;
- ordinary RANS screening and first-pass preliminary URANS remain admissible
  on a version-0 or version-1 runtime while version-2 continuation/final
  recovery stays pending;
- missing checkpoint state is typed non-physical infrastructure work and does
  not consume solver budget;
- transient continuation loss retries with backoff, while permanent
  continuation loss records one stable critical outcome and is not submitted
  unchanged again;
- a relaxing periodic signal reaches acceptance through adaptive same-case
  extension;
- restart seams cannot mint false shedding, archive restore preserves the exact
  transient boundary, and force-history advancement cannot be miscounted as no
  progress;
- source-proven non-stationarity adds a three-period corrective tail only after
  K is satisfied, with a false-positive guard for ordinary shortfall;
- blocked restartable attempts remain protected from destructive retention;
- a pending final-verification point is admitted after no more than eight new
  wave-1 RANS admissions, and the fairness proof survives a sweeper restart;
- exact and whole-polar admin final requests own the ordinary PRECALC plus
  verification children, never submit a direct full bypass, and settle only
  after every owned child settles;
- the UI uses one three-stage per-point sequence and reserves red critical
  treatment for exceptional preflight, RANS-recovery, preliminary-, or
  final-URANS exhaustion, never normal RANS handoff;
- an accepted final result remains verified, publishable, countable, and
  openable when the fast/final comparison exceeds tolerance; its real deltas
  appear as a non-critical warning, while exhausted final recovery with no
  accepted exact result remains critical;
- an old cancelled or otherwise inactive preliminary obligation cannot hide a
  current campaign-owned RANS critical incident for the same natural cell; its
  row distinguishes attempted RANS from genuinely never-started preflight and
  labels attempt/evidence counts without claiming physical solver runs;
- every requested AoA remains one visible/countable row even when a symmetric
  counterpart reuses the same exact result, and fast/final result nodes open by
  stable result id rather than rounded display values;
- same-case continuation proves monotonic cross-segment progress and becomes
  one stable critical incident instead of looping when repeated segments make
  no progress;
- a non-publishable final-URANS result retains its accepted preliminary
  generation while automatic final recovery continues;
- repeated incidents are durably grouped by stage, reason, and solver
  implementation so recurrence is investigated and tied to a remediation
  version;
- affected production obligations recover publishable results without deleting
  or rewriting their existing evidence.
