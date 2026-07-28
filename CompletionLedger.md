# Completion Ledger

- **Frame-evidence integrity and narrow modal navigation:** Exact production
  evidence proves the AG 455CT02R frames 15–17 Cl/Cd values are authentic; the
  apparent L/D corruption is a sub-percent instantaneous ratio ripple
  misleadingly expanded by an extrema-only chart domain. The UI now derives
  Cl/Cd from immutable frame samples, uses a minimum relative display span
  without smoothing or changing evidence, and keeps solved-point navigation
  inside the modal header instead of floating over charts. A full production
  audit found no missing numerics or non-monotonic times across 2,300 tracks
  and 210,797 frames, but found two genuinely non-positive drag samples in AH
  94-W-301 at 9° and 13° that the mean-only classifier had accepted. The v7
  frame-sample gate is deployed, both rows are rejected without mutating their
  attempts, and fresh preliminary URANS is queued for only those cells. The
  627 px production modal has no overlap. Remaining: accept the two replacement
  generations and rebuild the affected polar after ingestion.

- **Three-stage solver rollout and campaign burn-in:** The regression-backed
  RANS screening → fast preliminary URANS → final verified URANS controller,
  exact-generation continuation gate, automatic final scheduling, critical
  incident model, and physical-tail classifier are deployed with the guarded
  OpenCFD 2606 engine. Exact production and remote remediation results are
  accepted and GCS-bound, ordinary admission is resumed, and the active
  generation currently has zero blocked points. A 96-chunk last-resort
  continuation ceiling is implemented and regression-verified so a healthy
  trajectory that settles just beyond the old 24-chunk edge remains governed
  by the real wall budget; it is not yet deployed. Deferred default-media
  recovery now explicitly hydrates immutable retained archives, and the API
  image owns the ffmpeg encoder used by that endpoint; both fixes are
  regression-verified and deployed on the remote solver, but not yet on
  production. Remote delivery now has a deployed local manifest-backed
  field-inventory gate, independent weighted remote/local admission, bounded
  rotating reconciliation, concurrent queue-aware terminal priority,
  single-flight background artifact transfer, and same-tick multi-promise
  refill. Production is capped at eight OpenCFD 2606 CPU slots; the dedicated
  remote node is capped at 40 CPU slots with 48 hub promises so ingest/delivery
  ownership cannot strand executable capacity. Live burn-in restored 40 active
  engine jobs at 4006% worker CPU after a terminal burst. Exact generations
  already accepted by the hub retire obsolete local repair work.
  Readiness still requires incremental result publication, verified GCS
  generations and local reclamation for the live job, plus a burn-in with no
  recurring current-generation blocked/critical chain. Preserve immutable
  2406 histories; any new exhaustion remains a red system incident and must be
  investigated before ordinary new admission continues. The July 24 remote
  burn-in additionally exposed false watchdog SIGKILLs from copied/non-live
  coefficient histories and an untyped terminal-promise reclaim loop. Exact
  live-process monitoring, isolated-but-retained initialization evidence, and
  build-scoped terminal cancellation are regression-verified. The guarded
  remote maintenance path correctly treats durable `blocked` delivery
  conflicts as terminal, inert review records while still refusing
  retryable/claimed deliveries. The production hub is reachable. Recovery v3's
  first corrective run proved that force-only phase similarity could release
  the conservative timestep with only three field frames per period while an
  impulse remained in the newest suffix; every in-flight v3 task was cancelled
  through the normal evidence-preserving API before publication. Recovery v4
  adds the discontinuity and 20-frames-per-period release gate and is deployed
  on both OpenCFD 2606 engines. The durable transfer-only maintenance pause,
  live-writer drain, exact pause-state restoration, deployment-order
  regression, and real no-network/no-claim test are also deployed; the guarded
  remote rebuild caught and drained a delivery that arrived between its two
  quiescence checks. Production and remote admission are restored at 8 and 40
  CPU slots. Six exact pre-v3 corrupted attempts retained their audited
  source-pinned remediation allowance and began together under v4 from the
  shared mesh. Live burn-in proved the v4 discontinuity gate refused real
  simultaneous Cl/Cd/Cm impulses, but also identified their remaining source:
  `adjustableRunTime` shortened a physical timestep at every dense field-write
  boundary and repeatedly injected a new impulse. Both 2606 pools are fenced
  and the v4 generations were cancelled before publication. Recovery v5 was
  deployed on both engines and proved that non-rescheduling `runTime` output
  eliminates the dense-write timestep collapse. Its corrective burn-in exposed
  a separate high-angle pressure/PIMPLE impulse: reducing timestep alone did
  not cure it, while tighter pressure/transport convergence and a 4×3 PIMPLE
  loop did. The manually altered canary was cancelled before publication and
  all six exact obligations returned to pending without consuming attempts.
  Recovery v6 is deployed on both engines; it automatically arms the stronger
  numerical rung, restores the conservative Courant cap, restarts
  certification, and forbids later release within that physical chunk. Its
  corrective burn-in found one remaining continuation defect: a regenerated
  `controlDict` and fresh monitor closure could replace the marker-owned
  `maxDeltaT` with a cadence-sized value. Recovery v7 atomically reapplies the
  persisted numerical and timestep controls before both boundaries and
  prevents cadence refinement from changing them while recovery is armed. Its
  corrective burn-in exposed a throughput-only classification defect: the
  immutable numeric continuation seam itself armed the strong recovery rung on
  flat cases. Recovery v8 excludes only the derivative crossing a known
  OpenFOAM segment boundary from the live trigger; ordinary period similarity
  and final clean-tail publication remain strict. Its
  failing-before/fixed-after seam regression, 95-test frame-track file,
  TypeScript incident checks/typecheck, and the full 1,287-test non-integration
  engine suite pass. Both guarded engines now report recovery v8. The original
  single-remediation ceiling was exhausted by the successive v4–v7 controller
  corrections, so an immutable one-grant-per-distinct-fixed-source ledger was
  deployed before the six exact v8 corrective obligations resumed. An
  operator-side
  live-dictionary edit
  during diagnosis caused four v6 cases to stop with immutable rejected
  evidence; all four canonical archives authenticated every manifest member,
  their unpacked duplicates were restored exactly, and the runbook now forbids
  direct live dictionary edits. Both 8/40-slot execution pools are restored.
  The exact six-angle v8 corrective run reused one mesh and recomputed no
  already accepted point. AoA 13 produced accepted clean-period evidence and is
  GCS-bound. AoA -1, 0, 1, 7, and 9 retained complete restartable rejected
  checkpoints, but the accepted-result-only remote broker left those five
  archives unregistered and the controller correctly refused an unsafe
  continuation. The transfer/controller fix now brokers such checkpoints
  without fulfilling the point, preserves the exact verified GCS archive, and
  makes the same-case continuation non-consuming. Its first deployment exposed
  that campaign ingest truthfully projects physical attempts as
  `source=queued`; a second narrow predicate accepts only typed OpenCFD 2606
  hard-solver checkpoints with retained transient state and measured progress,
  plus the unambiguous budget-stop marker, while generic queued failures and
  legacy lookalikes remain excluded. Focused database and remote transfer
  regressions cover the trust boundary. That predicate is deployed and all five
  checkpoints are now exact, hub-verified GCS generations. AoA -1 continued the
  same engine case from `t=0.154775 s` with `mesh_build_count=0`, consumed no
  new physical attempt, and produced accepted evidence whose published window
  begins after the corrupt prefix. Their first automatic admission exposed a
  scheduler-query defect: broad promotion discovery embedded the complete
  archive-member trust proof twice and scanned the remote node's 3.9 million
  artifact rows for minutes. The corrected discovery is lightweight while the
  exact bounded second phase remains the sole continuation authorization gate;
  isolated promotion and exhausted-checkpoint regressions plus sweeper
  typecheck pass. A second historical-row defect left exact obligations without
  a source-attempt FK under a cancelled original promise. The current active
  replacement promise may now continue only its explicitly owned point while
  the old whole-polar promotion remains immutable provenance; it cannot adopt
  or widen the old scope. The candidate query excludes deterministic mesh
  failures and defers authenticated-archive proof to the bounded per-point
  phase. Both corrections are deployed on the remote solver and production
  control planes.
  The first exact AoA 0 continuation then advanced the retained case by
  `0.051606 s` without rebuilding its mesh, but exposed a physics-context
  defect: its 1,076 Hz tail is stable across both halves and has
  thickness-scale `St_t=0.394` on the measured `t/c=0.22` section, while the
  chord-only 30–300 Hz band rejected it. Recovery v9 derives only the
  high-frequency wake edge from immutable projected section height; actual
  production bytes select a stationary clean 4.5-period certificate and exact
  three-period publication window after the corrupt prefix. Recovery v9 is
  deployed on both OpenCFD 2606 engines. AoA 1 now has accepted exact
  clean-tail evidence and a verified GCS archive without another CFD solve.
  Hub import exposed one separate association defect: pressure frames 25 and 84
  are different real time steps with byte-identical PNGs, and blob-only
  identity rejected the second frame. Migration 0090 preserves logical
  `frameIndex` while sharing the physical content-addressed bytes; its
  failing-before/fixed-after API regression, full 51-test remote-sync file,
  seven-test migration suite, and DB/API/sweeper typechecks pass; it is deployed
  and AoA 1 is bound on the hub. AoA 7 and 9 are now live non-consuming
  continuations from their exact GCS-verified checkpoints; AoA 7 reports
  `mesh_build_count=0` and resumed at `t=0.12888 s`. AoA 0 had no authenticated
  restartable archive and is one explicit replacement solve. The remote pool is
  saturated at its 40-slot cap; AoA -2 remains pending until capacity returns.
  Readiness still requires accepted clean-period evidence plus verified
  hub/GCS binding for AoA -2, 0, 7, and 9, retirement of obsolete generations,
  the already-committed cancellation-preservation worker code to be installed
  by guarded engine maintenance after both pools drain, and no recurring
  current-generation critical chain.

- **Production evidence capacity:** The July 19 GCS reconciliation left the
  500 GB VPS about 393 GiB free (roughly 20% used). The storage-only canary is
  now GCS-bound and signed-reclaimed. A first historical batch was stopped
  before any source reclaim when it exposed a selector defect: it treated a
  cancelled whole-promise lease as solver work even though the point itself had
  already been fulfilled. The exact settled-point and signed-receipt fences are
  deployed and regression-covered. Of 39 unbound, accepted legacy generations,
  38 are now GCS-bound and signed-reclaimed. The one complete remote generation
  that conflicted with a different hub result generation for the same physical
  cell is preserved as an immutable archived conflict; its obsolete delivery
  was automatically superseded and no remote delivery remains blocked. Six
  cancelled/invalid point generations still require the separate
  forensic/rejected-evidence path. Do not claim migration complete or remove
  any of those six local sources until their exact durable acknowledgement
  exists. Preserve the workload-aware 20 GiB system floor, measured remaining
  local-work reserve, and 24 GiB next-local-job reserve while the campaign is
  active; keep the temporary hydration cache bounded, and remeasure active-case
  growth before increasing solver concurrency.

- **Engine observability single-flight deployment:** The Node control plane now
  keeps one live owner across probe TTL expiry and changing runtime keys, and
  backs off a settled engine-observability failure for 30 minutes. The Python
  gateway also returns cached or explicitly unavailable worker-runtime data
  instead of waiting behind a stalled Celery `inspect.conf()` lock. Both paths
  have concurrency regressions. The Node guard is deployed. The original
  production gateway remains preserved and wedged for forensic inspection
  while active OpenFOAM jobs continue in the unchanged worker. A fresh
  production-image gateway now carries Node API, sweeper, and media-repair
  traffic. A later control-plane deploy exposed that this endpoint existed only
  in mutable environment state: the deploy briefly restored the wedged
  canonical gateway. The environment has been corrected, and a state-owned
  route marker plus deploy preflight regression now prevents future endpoint
  drift. Authenticated queue verification
  reports healthy exact build identity, no health/queue error, no build
  mismatch, and a cleared unreachable timestamp. Twelve concurrent admin
  polls completed without increasing the recovery gateway's Redis-client
  count. Install the Python guard through guarded engine maintenance only
  after the active OpenFOAM pool drains, then prove direct concurrent
  `/queue` polls cannot delay `/health`, retire the forensic gateway and
  temporary gateway, restore the canonical Compose service URL, and remove
  this item.

- **Parallel remote-solver GCS delivery:** The credential-redacted,
  generation-pinned brokered upload path and the role-separated `hz-solver2`
  cutover are live. The strict volume canary, archive-only render proof,
  restartable guarded cutover, verified
  backup/rollback artifacts, private attestation, and hub-acknowledgement
  retention fence preserve complete local evidence without giving the remote
  node a Google credential. The full-polar canary has delivered all 26
  requested angles. Its final fast generation is bound on the hub to GCS
  generation `1784546127477342`; all 2,621 archive members (manifest plus
  2,620 declared files) passed fresh verification, the hub acknowledged it,
  and the remote reclaimed only after acknowledgement. The hub registered the
  exact blob/archive/member ledger and one durable background FINAL item;
  idempotent replay returned the same archive and queue. Live-campaign PRECALC
  ownership reconciliation is complete, and the final AoA 18 retry has now
  been accepted, bound to GCS generation `1784567638818547`, acknowledged by
  the hub, and reclaimed remotely; all 26 promised angles are fulfilled. The
  restored legacy-evidence migration uses the same transfer boundary: canary
  upload `472a8929-b170-4867-8757-4d6ec117eb1b` bound to GCS generation
  `1784582269952724` and was reclaimed after a signed acknowledgement. Remote
  scheduler's local admission switch remains deliberately disabled on this
  dedicated remote node: it prevents an independent local campaign queue while
  the running sweeper reconciles and admits only hub-issued promises through
  the remote lane. Its attested OpenCFD 2606 pool is enabled with a 40-slot CPU
  budget and 48-promise hub headroom; production independently retains its
  eight-slot pool, and OpenCFD 2406 remains disabled. Only a point already fulfilled
  with the exact result/attempt may perform an archive-only replay under a
  fulfilled, cancelled, or expired promise; a receipt-backed exact delivery is
  already bound and must never be replayed. The replay must not renew the
  closed solver-work lease, and remote bytes may be reclaimed only from signed
  hub receipts. After the remaining forensic evidence is durably preserved,
  deploy the 96-chunk continuation hardening while the remote worker is idle
  and continue monitoring evidence delivery, FINAL completion, descriptor
  stability, and absence of new critical chains before removing this item.

- **Multi-solver evidence comparison and custom polars:** Preserve every
  OpenCFD 2406/2606 and future solver attempt under its immutable implementation
  and runtime identity. Add a physical operating-cell comparison identity that
  does not collapse solver/numerical settings; expose exact solver/version
  series and per-AoA candidates on public Detail and in the admin cell panel;
  and implement immutable custom-polar revisions that select at most one exact,
  machine-eligible attempt per angle while retaining explicit exclusions and
  full provenance. Public visitors need a non-mutating personal composition;
  admins need durable named/published compositions. Native solver series must
  remain distinct, and a custom mixed polar must never masquerade as native
  campaign coverage or override machine rejection.

- **A18 low-angle alternate-branch correction:** Deploy and verify the
  classifier/cache/request/public-chart correction together with the guarded
  engine update. Confirm the five exact A18 requests produce real preliminary
  evidence and that provisional points remain visibly distinct and never join
  the accepted final polar curve.

- **OpenFOAM Foundation 14 production activation:** Keep OpenCFD 2606 as the
  scheduling default and the Foundation pool disabled until a real Foundation
  14 URANS canary proves transient force parsing, integer-period evidence,
  stored media, and partial publication/recovery end to end. Validate the
  pinned arm64 build before any Foundation worker is deployed on arm64.
