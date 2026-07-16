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
Failure to obtain a preliminary or final result after its automatic recovery
path is exhausted is red, critical, and owned by the system—not a normal user
review or setup-change task. Detailed evidence remains available behind
disclosure, but raw classifier strings, batch names, and mixed attempt counts
are not primary user content.

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

The version-2 deterministic mesh ladder was replayed across the 1,621 source
records. It accepts all 1,619 eligible closed airfoils and truthfully excludes
the two open, one-sided source components. GOE451 and FX79W660A, the only
eligible residuals after the structured C-grid candidates, pass the
source-preserving `cartesian2DMesh` fallback, the ordinary `checkMesh` gate,
and real `potentialFoam` plus short `pimpleFoam` canaries on OpenCFD 2606.
Missing tools, timeouts, process kills, unreadable output, and OOM signatures
remain infrastructure errors and cannot be misreported as geometry failure.

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
- continuation and final-recovery work that needs version 1 remains pending on
  version 0, while ordinary RANS screening and first-pass preliminary URANS
  remain eligible.

This permits a control-plane-first deployment without accidentally applying
new recovery semantics to a still-running legacy engine. The guarded OpenCFD
2606 cutover activates version-1 recovery only after the engine advertises and
enforces the matching contract.

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
- Fresh starts remain bounded. Same-case continuation segments preserve one
  physical solve’s accumulated state and immutable audit sequence rather than
  masquerading as independent solver attempts.
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
  on a legacy version-0 runtime while version-1 continuation/final recovery
  stays pending;
- missing checkpoint state is typed non-physical infrastructure work and does
  not consume solver budget;
- transient continuation loss retries with backoff, while permanent
  continuation loss records one stable critical outcome and is not submitted
  unchanged again;
- a relaxing periodic signal reaches acceptance through adaptive same-case
  extension;
- blocked restartable attempts remain protected from destructive retention;
- a pending final-verification point is admitted after no more than eight new
  wave-1 RANS admissions, and the fairness proof survives a sweeper restart;
- exact and whole-polar admin final requests own the ordinary PRECALC plus
  verification children, never submit a direct full bypass, and settle only
  after every owned child settles;
- the UI uses one three-stage per-point sequence and reserves red critical
  treatment for exceptional preliminary- or final-URANS failure, never normal
  RANS handoff;
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
