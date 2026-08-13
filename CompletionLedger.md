# Completion Ledger

- **Conservative preliminary-URANS retry rollout:** Engine/controller v12 is
  implemented and locally verified but not yet active in production. Deploy
  exact `master`, clean-reset/rebuild both authorized solver roles, verify hub
  capacity 8 and hz-solver2 capacity 64, and prove one real repeated PRECALC
  request/evidence generation carries the controller recovery flag and marker
  without changing scientific classification gates. Remove this item only
  after the production burn-in evidence exists.

- **Remote rejected-result reclamation:** A terminal hz-solver2 job containing
  rejected result rows never receives its job-level delivery terminal, so
  generic retention cannot reclaim the local case even after every publishable
  generation was delivered. This stranded roughly 2.2 TiB and stopped refill
  at 46/64 processes. Release the disposable remote promises/jobs, clean-reset
  the remote solver while retaining registration/credentials and 64-slot
  policy, then terminally account jobs whose remaining rows are immutable
  rejected evidence so their unpublishable local cases can be reclaimed and
  their unfulfilled hub points can be re-promised. Verify hub authority release,
  remote disk reclaim, 64-slot refill, valid delivery, and post-terminal strip.

- **AoA evidence rendered interaction proof:** Commit `d17c991` is deployed and
  the live API/build prove the stable result identity, classic-RANS explanation,
  retained-content transition, cache, and prefetch implementation. The two-case
  Playwright regression collects successfully, but its rendered run remains
  blocked because DevCoordinator could not materialize the declared local API
  target (`bug-0e77ea2105a944639bda2dfb740bf1b1`) and the repository test
  manifest is still unsupported schema 2. Run the exact Admin campaign modal
  scrub after the governed runtime is available; verify retained dialog/scroll,
  no full-body loading screen, one request per cached AoA, final slider/result
  agreement, and the compact classic-RANS history notice, then remove this item.

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
