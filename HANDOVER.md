# XFoilFOAM / Airfoils.Pro — Current Handover

_Updated 2026-07-12 UTC. This file replaces the obsolete running-campaign
snapshot in Git history. Read the 2026-07-12 and 2026-07-11 entries at the top of
`DecisionHistory.md` before changing solver scheduling or data ownership._

## Production state

- Campaign `b96594a6-e0bf-40ce-b3c6-5dee77b35116`
  (`production-campaign-20260710`) is **cancelled and must not be resumed**.
- `sweeper_state.enabled` is `false`, and the `app-sweeper-1` container is
  deliberately stopped. Setting the database flag alone does not stop media
  repair/reconciliation, so keep the process stopped through migration 0057,
  the full cache backfill, and invariant audit. The latest check found zero
  active `sim_jobs` and no OpenFOAM, meshing, decomposition, or reconstruction
  processes in the worker container.
- Forty-two verification rows remain as cancelled audit history.
- There are no active, attention, or paused campaigns. The cancelled campaign
  is the only campaign row.
- Current engine build at the last verified production snapshot was
  `prod-20260711-argate`. Commit `725cdf5` deployed the Node control plane and
  migrated production through 0056; GitHub Actions run `29192996322` / job
  `86650864629` succeeded. The Python controller is committed but has not
  replaced the engine image, and no production solver canary is recorded.
- Post-0056 media repair exposed a selected-generation race: 44 selected URANS
  attempts lacked video owned by that exact attempt, and six had already been
  reclassified rejected while remaining selected. The sweeper was stopped
  before more scopes could be exposed. Migration/runtime correction 0057 is
  implemented and verified locally but is not yet deployed at this handover
  snapshot.
- Root disk was 43% used (121 GiB of 296 GiB) at the latest check.
- The admin server-health page/API shipped separately in commit `bffc25c`
  (`Add admin server health monitoring`). Use `/admin?section=health` to read
  live host/build state; do not infer deployment from this worktree.

## What the “99 need review” headline actually meant

The 99 points were automatic RANS-to-preliminary-URANS obligations, not 99
human verdicts. The true terminal attention set was 49:

- 18 deterministic S1223 mesh-QA blockers. The same immutable setup produced
  max non-orthogonality 88.2–88.3° and accumulated 66 repeated attempts.
- 31 rejected preliminary URANS windows. Every one was non-stationary; 25
  already held at least three periods; 19 were frame-sparse and 15 were sparse
  despite holding at least three periods. None exhausted the four-hour budget;
  completed jobs took roughly 4–78 minutes.

Courant 4 was present everywhere and was not causal. The primary controller
defect was that period count stopped the live run, while the exact
established-oscillation stationarity test happened only during finalization,
after the same-case correction opportunity was gone. Short guessed-period
horizons could also mislabel a physically plausible slow wake as flat. The
repeated S1223 work was deterministic waste, not transient solver recovery.

## Controller and exact-evidence remediation

- Preliminary URANS checks the final stationarity rule while the restartable
  case is live, continues the same trajectory in bounded measured-period
  chunks, and never performs a copied precalc rerun.
- The fresh preliminary horizon is about six guessed periods rather than the
  legacy ten. Slow-period acquisition covers the physical St=0.05 edge before
  no-shedding acceptance, with sparse acquisition writes and immediate
  measured-cadence switching after lock.
- One monotonic deadline spans fresh/resumed integration, all extensions,
  reconstruction, and refinement. The march watchdog remains armed when the
  monitor extends OpenFOAM `endTime`.
- Sparse-only media repair adds exactly the last three measured periods.
- Preliminary work is a durable physical obligation with at most two
  engine-accepted attempts: initial plus one corrective attempt. Many campaigns
  may own it without owning/cancelling one another's evidence.
- Deterministic mesh-QA evidence blocks the obligation immediately. It is not
  auto-requeued and requires a changed immutable mesh/setup revision.
- Engine connection failures consume no answered-submit allowance. The first
  answered 5xx waits 30 seconds and receives one automatic submit retry; a
  second 5xx or any answered 4xx becomes machine-blocked. Separate ledgers own
  preliminary obligations, ordinary result claims, and full request/verify
  work; none creates fake CFD evidence.
- `needs_review` is reserved for a future genuinely adjudicable human conflict.
  Crashes, rejected windows, exhausted retries, missing media, and setup defects
  remain failed/rejected/blocked/unavailable machine outcomes. Waivers no longer
  override classification or fitted polars.
- Missing real default media is a durable repair obligation fenced by the
  exact immutable result attempt, its one valid manifest checksum, byte size,
  and SHA-256. A rejected missing-media attempt remains historical evidence
  with no public pointer; repair may publish it only after that same attempt is
  reclassified `accepted` or `needs_urans`. Ingest and media writes use database
  leases/locks so stale workers cannot overwrite newer evidence.
- Migration 0056 gives every media repair an exact `result_attempt_id` and
  every full-verification queue row an exact `sim_job_id`. Verification/request
  owner ids in JSON remain provenance and require their normalized owner row;
  they are not execution authority by themselves. Ambiguous legacy repair rows
  are not guessed; invalid selected pointers are cleared and their current
  caches are retired.
- Migration 0057 closes the post-0056 race directly from exact evidence rather
  than trusting an older stored verdict. A selected URANS generation must own
  its force history, instantaneous video, and exactly one complete matching
  manifest. Ineligible pointers and affected revision/compatibility caches are
  withdrawn atomically; rejected evidence remains immutable attempt history.
  Pointer-null usable projections are removed, and exact repair obligations are
  created before missing-media selections are withdrawn.
- Runtime refresh now enforces that invariant after every attempt
  classification and after supersession. Shipped-media replay and sync
  manifest replay are exact-idempotent or conflict; they cannot delete,
  weaken, duplicate, or rebind evidence. Renderer replacement keeps the prior
  valid media visible until the replacement is complete, and corrupt-media
  invalidation commits with reclassification, pointer withdrawal, and cache
  retirement.
- A public result projection may downgrade but never upgrade its exact selected
  attempt. A rejected low-angle RANS sibling therefore stays historical and
  pointer-null while the surviving same-job RANS points remain provisional;
  unrelated jobs remain isolated.
- Solver publication is serialized under the immutable revision and requires
  the exact job/engine identity, a live ingest lease in production, and the
  normalized request, verification, or preliminary-obligation owner. Rejected
  or stale attempts remain addressable history but cannot replace public
  coefficients.
- Multi-revision campaign jobs retain the owner-approved `conditionMap` model.
  The job's scalar revision is only its compatibility anchor; every other
  result must match an exact persisted `(revisionId, bcId)` member. Exact speed
  mapping chooses that member, and publication is then fenced by the same job
  and revision locks. Rounded Reynolds, batch labels, and nearest-speed guesses
  are never authority.
- Public compatibility caches are now `polar-compat-v4`. Coefficients,
  classification, fidelity, and the evidence signature all come from the
  immutable attempt selected by `results.current_result_attempt_id`; an
  accepted classification on a different historical attempt cannot leak into
  a public series.
- The unsafe global failed-result requeue endpoint is inert. Use campaign-scoped
  or stable-result-id actions. Test-artifact purge is transactional, refuses
  active solver jobs, deletes only target-exclusive physical work, and
  preserves every shared or historical outside owner.

## Verification status before the 0057 production rollout

- Python: 400 passed, 1 skipped, 6 integration tests deselected.
- Full package suites recorded green before the correction: core 119 and web 272. The final clean-0057 API run passed 18/18 files and 218/218 tests; the
  final clean-0057 DB run passed 9/9 files and 51/51 tests.
- Full sweeper on a freshly migrated/seeded 0057 database passed 25/25 files
  and 275/275 tests on the exact final tree (24.00 s Vitest). Focused
  correction suites passed: exact upgrade 12/12, exact repair migration 4/4,
  media repair 23/23, replace guard 19/19, sync 39/39, and polar-cache
  atomicity 12/12.
- A fresh empty database applied all 58 migrations through 0057 with no
  unvalidated constraints. A fresh clone of the production 0041 database
  upgraded through 0056 while conserving 933 results, 206,371 evidence
  artifacts, 8,648 media rows, 81 force-history rows, and 7,464 field extents.
  Expected exact-duplicate collapse changed attempts 906→894 and
  classifications 1,839→1,827; 618 eligible exact public pointers remained.
- The final 0057 proof started from the strongly verified post-deploy 0056
  production dump rather than layering over an earlier test migration. It
  changed selected pointers 619→575, withdrew all 44 exact-video-deficient
  URANS generations, and left zero invalid selected pointers, selected URANS
  missing exact video/force, pointer-null usable projections, dual-owned usable
  classifications, invalid repair owners, or invalid compatibility members.
  The second 0057 execution was state-idempotent. Backfill refreshed 47/47
  scopes with zero failures while all immutable evidence counts and hashes were
  conserved.
- Post-upgrade audits found zero exact-owner, provenance, projection, or
  manifest violations. All 148 foreign keys and 28 checks were validated.
  Direct-schema versus migrated-schema parity covered 65 tables and 963
  columns/constraints; the only differences were equivalent Boolean-index
  syntax and one intentional synthesized legacy enum label.
- DB, API, and sweeper typechecks plus formatting/diff hygiene passed during
  the remediation.
- Production-shaped local browser verification loaded E387, AG24, the campaign
  list/detail, and server Health at 390x844 and 1440x900. E387 exposed one
  public six-point polar spanning the compatible stored runs, contained no
  `remote-validation-e387` label, and had no document-width overflow or browser
  errors. The deterministic formal verifier checked 10/10 route/viewport pairs
  with zero critical findings. Its only overlap allowance is attached to the
  polar toolbar itself: the fixed top navigation intentionally covers ordinary
  document content after that content has scrolled underneath it.
- Commit/push status for 0057 is owned by the root task. The 0057 production
  migration/backfill, live-production invariant audit, engine rebuild, and
  isolated OpenFOAM canary are **not** claimed here.
- The default local `aerodb` database contains an obsolete, never-committed
  intermediate 0047 shape. Do not treat it as migration evidence and do not add
  compatibility SQL for it. Use a new scratch database migrated from 0000.

## Production access and deployment safety

- SSH: `airfoilsroot@35.234.124.80` with
  `~/.ssh/airfoilsroot_ed25519` (`BatchMode=yes`, `IdentitiesOnly=yes`).
- Stack: `/opt/airfoils-pro/app`, compose file
  `docker-compose.deploy.yml`, env file `.env.deploy`, project `app`.
- OpenFOAM is supplied by the Docker worker image; the VPS host does not need a
  host OpenFOAM installation.
- Ordinary deploys update only `node-api`, `web`, and `sweeper` through GitHub
  Actions or `scripts/deploy/vps-redeploy.sh`. Do not recreate `api` or `worker`.
- Engine rollout must use `scripts/deploy/rebuild-engine.sh <build-id>` only,
  after an explicit idle-process check and a fresh verified PostgreSQL
  backup/test restore. Never run raw `docker compose ... --force-recreate api
worker`.
- Keep the sweeper disabled after deployment. Do not launch or resume the old
  campaign. A solver proof must be a deliberately isolated canary.

Fresh verified post-0056/pre-0057 backup retained on the VPS and copied to
`/tmp/airfoils-prod-backups` locally:

- Container: `a7136886aaae13b40972c2c72395b2902238f8d759f29140e9688cd597a653e5`
- Dump: `/opt/airfoils-pro/.codex-db-backups/app-postgres-1-aerodb-20260712T131722Z-c8d00b90.dump`
- Bytes: `59,985,082`
- SHA-256: `9e5174f12205e07cac2b0d103c39bab7000a87cb1a9f9a32fdaed58ddc26af18`
- File modes are `0600`; the backup directory is `0700`. Strong verification
  restored it into disposable database `codex_verify_fe56412a6ef5` and matched
  all 66 source tables.

The earlier verified pre-0056 backup is also retained:

- Dump: `/opt/airfoils-pro/.codex-db-backups/app-postgres-1-aerodb-20260712T123527Z-12c26d85.dump`
- Bytes: `61,279,916`
- SHA-256: `925dc429af50acd3e525e2148362ed9e13ce83fb767510195ee2277d57ca7765`
- A strong test restore succeeded.

The earlier verified pre-remediation backup is also retained:

- Container: `a7136886aaae13b40972c2c72395b2902238f8d759f29140e9688cd597a653e5`
- Dump: `/opt/airfoils-pro/.codex-db-backups/app-postgres-1-aerodb-20260711T122834Z-502535d9.dump`
- Bytes: `61,133,265`
- SHA-256: `5a810d3bc2e853223fe0c748f529a8a55dc67a716bb9893582c0636732c3a0b0`
- A test restore succeeded.

After rollout, remove temporary `/tmp/postgres_docker_backup.py` and
`/tmp/adm.token` from the VPS.

## Open decisions and residual risk

- **Durable orchestration remains an agent recommendation pending owner
  confirmation.** Keeping the normalized obligation/owner rows, leases, and
  exact attempt links costs more schema, migration, and concurrency-test work,
  but makes crash recovery, shared ownership, and bounded retries auditable.
  Returning to in-memory scans or JSON-only ownership would be simpler and
  cheaper to maintain, but a restart could lose work and concurrent campaigns
  could cancel or overwrite one another. Recommendation: keep the durable
  model; do not describe it as owner-approved until the owner confirms it.
- **The one-answered-5xx/30-second retry bound also awaits owner confirmation.**
  The current rule limits duplicate load and deterministic waste, but a second
  transient server rejection becomes machine-blocked. Allowing more retries
  may recover a longer outage automatically, at the cost of extra queue delay
  and solver pressure. Recommendation: keep the bounded rule until production
  measurements justify a different number.
- **Exact selected-generation ownership remains an agent recommendation
  pending owner confirmation.** The explicit result-attempt pointer and
  attempt-owned media/evidence add migration and query complexity, but preserve
  which solve produced every public value and make corrections race-safe.
  Inferring ownership later from job ids, rounded values, or batch labels is
  simpler but becomes ambiguous after retention and can erase provenance.
  Recommendation: retain the exact pointer model.
- **Delivered remote-cancellation rows currently have indefinite audit
  retention, pending owner confirmation.** Keeping them costs one small row per
  cancelled remote promise and preserves proof of release. A fixed expiry caps
  growth but requires the owner to choose an audit-retention window and accepts
  loss of older proof. Recommendation: retain them until that policy is set.
- The engine API still lacks a client-chosen idempotency key. A process death or
  response loss after engine acceptance but before the returned id is stored
  can leave an unaddressed engine task. Database submission leases close
  cooperating duplicate/race paths, not this final network ambiguity.
- Federation still uses one shared sync secret. It proves membership but does
  not prevent one compromised solver from claiming another solver's identity.
  Per-solver revocable credentials add provisioning and rotation work but give
  isolated attribution and revocation; they are recommended before federation
  expands and require an owner decision.
- The new controller remains unproven on real production OpenFOAM until the
  isolated post-deploy canary succeeds.
- **Scheduler-policy conflict must be resolved before a new campaign.** The
  2026-07-07 decision record says the background fidelity ladder retries only
  the rejected/provisional angles, which is faster and cheaper but can leave
  surviving RANS points provisional after a low-angle failure. The current
  project guardrail says any rejected RANS point from 0° through 5° must abort
  the remaining RANS sweep and replace the whole requested polar with URANS,
  which costs more solver time but produces one physically coherent transient
  polar. Recommendation: follow the current whole-polar guardrail for new
  production campaigns unless the owner explicitly re-approves targeted-only
  escalation after weighing that cost/correctness tradeoff. The 0057 evidence
  correction is valid under either scheduling policy and does not silently
  change scheduler breadth.
