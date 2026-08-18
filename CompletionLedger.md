# Completion Ledger

- **FAST-URANS v14 quality and typed recovery rollout:** The separate
  aperiodic statistical-mean certificate, exact coefficient binding, v14
  engine/controller pin, evidence-driven recovery types, non-publishing
  evaluator, exact source-pinned remediation command, and typed operator copy
  are implemented. Automatic archive audit/discovery and audit-to-recovery
  routing are removed from normal sweeper startup/admission. Focused Python
  and core tests pass; the governed Node suite (workspace typechecks, web
  tests, and production build) passes. DB-backed recovery regressions are
  authored but remain unexecuted because DevCoordinator cannot start its
  declared `aerodb-pg` dependency (`repository_adoption_store_failed`: the
  authority adoption store is read-only; bug
  `bug-218972fac15b4b2f93d01be60333caef`). Remaining work: run those DB/sweeper
  regressions after the coordinator dependency is available, commit/push main,
  make a verified production backup, deploy v14 through the guarded engine
  rebuild scripts, run the read-only evaluator across both solver databases,
  requeue every exact failed cell, measure accepted points and CPU-hours, and
  delete only failed generations proven replaced by exact accepted immutable
  URANS evidence. Production additionally exposed legacy/current cycle
  diagnostics that encoded an internal infinity as JSON `null`, making whole
  result documents unreadable; the finite-sentinel producer fix and
  reject-only legacy-null reader are implemented and locally verified but must
  be deployed to both engines before this item can close.

- **Solver capacity packing and tick-progress recovery:** Live production on
  2026-08-17 proved the hub had four real progressing 1-slot OpenFOAM jobs but
  rejected every next 8-slot batch as `4+8/8`; hz-solver2 was progressing near
  its 64-slot cap. Both sweepers also repeated a postgres-js Date/string bind
  error, leaving `lastTickCompletedAt` stale despite fresh heartbeats. `master`
  now atomically shrinks only case concurrency to the exact positive remainder,
  persists the reduced job weight/resources before engine submission, and uses
  database `now()` in capacity-denial cleanup. Pure packing regressions and the
  sweeper typecheck pass; DB-backed attached-result/serialized-admission
  regressions are authored. Remaining work: run the governed change suite,
  deploy the Node control plane from pushed `master` without recreating engine
  services, and verify hub 8/8, fresh completed ticks, no bind-error recurrence,
  remote progress, and storage headroom.

- **Fresh point recalculation rendered proof:** The pointer-null continuation
  explanation and from-zero, pre-filled recalculation UI are implemented with
  a full mocked interaction regression. Unit tests, web/DB typechecks, and the
  production web build pass, and the repaired test scheduler now accepts the
  schema-3 manifest. Rendered execution is still pending because
  DevCoordinator refuses this repository's declared runtime when the effective
  Compose model requests the admin-approved `published_host_ports` access.
  Once the governed runtime is approved, run the pointer-null Solver › Points
  flow at desktop and narrow widths; exercise checkpoint disclosure, every
  preset, reset, parameter validation, tier selection, confirm
  cancellation/success, and verify the exact source attempt in the queued
  request, then remove this item.

- **Conservative preliminary-URANS retry burn-in:** Both production roles run
  engine/controller v12, and repeated hub PRECALC work carries the controller
  recovery flag and the persisted time-zero conservative-numerics marker. No
  repeated v12 job has reached terminal evidence yet. Keep the scientific
  gates unchanged and verify one real repeated attempt publishes immutable
  evidence and receives its normal classification before removing this item.

- **Remote rejected-result post-terminal strip:** The disposable remote reset,
  credential restoration, 64-slot refill, and fresh valid-result delivery are
  proven. The remaining production proof is a new terminal job containing
  rejected rows: every unpublishable point must be released for re-promise,
  the job must receive its reclamation acknowledgement, and retention must
  strip its local case without publishing the rejected evidence.

- **AoA evidence rendered interaction proof:** Commit `d17c991` is deployed and
  the live API/build prove the stable result identity, classic-RANS explanation,
  retained-content transition, cache, and prefetch implementation. The two-case
  Playwright regression collects successfully, but its rendered run remains
  blocked because DevCoordinator cannot materialize the declared local runtime
  while its effective Compose model requests admin-approved
  `published_host_ports` access. The repository test manifest now validates as
  schema 3. Run the exact Admin campaign modal scrub after the governed runtime
  is approved; verify retained dialog/scroll, no full-body loading screen, one
  request per cached AoA, final slider/result agreement, and the compact
  classic-RANS history notice, then remove this item.

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
