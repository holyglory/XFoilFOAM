# XFoilFOAM / AERODB — Session Handover

_Generated 2026-07-11. Author: Claude (Fable 5) session f9d28dc6. Node HEAD at handover: `f2abd5eed`. Live engine build: `prod-20260711-argate`._

This document explains the current state of the project, exactly what is running on
the airfoils.pro VPS, and the prioritized debugging/next-step plan. A future agent
session should read this first, then `DecisionHistory.md` for the full rationale trail.

---

## 1. TL;DR

The **production-campaign-20260710** re-run is deep in its **URANS (wave-2) phase** on the
final engine. RANS (tier-1) is complete; the fidelity ladder is now grinding the
per-condition unsteady confirmations and the three refinement objectives (L/D-max,
α₀, Cl-max). Numbers at handover: **~990 requested / ~774 solved / 18 failed / ~36
needs-review**. The only failure class is the documented **S1223 heavy-chord mesh
degeneracy** (18 points, all one airfoil, all honest mesh-time failures). No crash
classes, no data loss, disk healthy at 55%. Everything built this session is deployed
and test-pinned.

**The one systemic open item** is the **frame-recorder needs-review class** (24 of ~36
review points): small-chord/high-α URANS points where the frame *write cadence*
undershot the real (faster) shedding period, yielding `frames/cycle < 20`. The
**coefficients are unaffected** (means come from the full force history, not the
frames) — so these are safe to **waive**, or fixed systemically by an engine change
(adaptive frame cadence from the measured period). That change is proposed, not yet
built — see §6.

---

## 2. What this system is

A pnpm monorepo web portal (**AERODB**) over a Python/OpenFOAM CFD engine, deployed at
**https://airfoils.pro**. It turns airfoil geometries into a browsable database of
solved aerodynamic polars with real CFD media.

- **Engine** (`src/airfoilfoam/`, Python): meshes airfoils (blockMesh C-grid),
  runs steady RANS + unsteady URANS in OpenFOAM (docker), classifies convergence,
  exports coefficients + field media + frame tracks. FastAPI + Celery.
- **Node control plane** (`apps/`, `packages/`): `api` (Fastify), `sweeper`
  (gap-finder/claim/ingest loop), `web` (Next.js). Postgres via drizzle.
- **Fidelity ladder**: RANS wave-1 → precalc URANS wave-2 (wall-function y+40,
  half-res, budget 4h) → full URANS (wall-function y+40 full-res, budget 12h).
  Rejected/unsteady RANS points escalate automatically; this is **normal operation**,
  not failure.
- **Campaigns**: a wizard-defined sweep (airfoils × conditions × α) plus iterative
  **refinement lanes** that re-fit the polar and solve toward objective angles
  (L/D-max, α₀, Cl-max) until an AoA tolerance is met or maxRounds is hit.

---

## 3. What is running on the VPS RIGHT NOW

**Host**: `airfoilsroot@35.234.124.80` (a.k.a. airfoils.pro), key at repo
`.ssh/airfoilsroot_ed25519`. 8 cores / 15 GB / GCP. Stack at `/opt/airfoils-pro/app`,
compose project `app`.

### Campaign `production-campaign-20260710` (id `b96594a6-e0bf-40ce-b3c6-5dee77b35116`)
- **Plan**: 5 airfoils (clarky, naca-0012, naca-4412, s1223, sd8020) × 9 conditions
  (25/50/100 m/s × 0.1/0.5/1.0 m chord, air 288.15 K) × α −15…30° step 5°, **all
  three objectives** enabled (ld_max 0.10°/4, cl_zero 0.05°/4, cl_max 0.10°/8).
- **Totals**: ~990 requested / ~774 solved / **18 failed** (all S1223 mesh, see §5).
- **Classification** (all campaign results): 734 accepted, 163 rejected (→ escalated
  up the ladder, normal), 82 needs_urans (RANS on the polar, URANS scheduled).
- **Accepted by fidelity**: 691 RANS + 43 URANS-precalc (the URANS accepts are
  climbing as wave-2 lands).
- **Phase**: tier-1 RANS complete (0 queued). Wave-2 in flight: **~2-3 targeted
  URANS jobs** at any moment (CPU-bound at 8 cores — see "why only ~3 jobs" note
  below). Refinement lanes iterating: ld_max mostly `stalled`/`converged_provisional`,
  cl_zero has 18 `symmetric_definition` (naca-0012 shortcut), cl_max `iterating`/
  `converged_provisional`. Lanes self-terminate at maxRounds.

### Health
- **Containers**: app-{web,sweeper,node-api,api,worker,postgres,redis}-1 all Up/healthy.
- **Sweeper**: enabled, heartbeat fresh (~1 s age).
- **Disk**: **55% used, 128 GB free** (was 33% earlier; URANS job dirs are large —
  multi-GB each. The retention reaper has stripped **224 of 282** terminal job dirs,
  freeing **~63 GB**. Disk is bounded but climbing during wave-2 — watch item, not a
  problem yet).
- **Live builds**: node = master HEAD `f2abd5eed`; engine = `prod-20260711-argate`
  (the aspect-ratio-waiver rebuild).

### Why only ~3 solver jobs in parallel
Not a bug. The bottleneck is the **8 VPS cores**, enforced by the engine's CPU-token
pool (`worker_cpu_budget` auto = cpu count). A URANS case leases several tokens
(mpirun), so ~3 concurrent jobs already saturate the box. Oversubscribing would slow
wall-clock *and* trip the march-rate guard (which projects completion assuming
dedicated cores). To get more parallelism you need more cores (Windows box — §7).

---

## 4. The needs-review queue (~36 points)

Human review verdicts recorded so far: **0** (the review UI is live and waiting for the
user). Breakdown by *deciding* gate (the gate-attribution fix `f2abd5eed` ensures these
labels are now the real verdict, not a benign mesh disclosure that used to shadow them):

| gate | count | meaning | recommended verdict |
|---|---|---|---|
| **frame recorder** | 24 | `frames/cycle 3–16 < 20` — shedding faster than the pre-solve estimate, so too few frames were *written* per cycle. **Coefficients are unaffected.** | **Waive** (numbers are good, animation is coarse) — or **Retry** for a better-cadence re-record. Systemic fix proposed in §6. |
| **stationarity gate** | 11 | URANS window mean still drifting / not established-oscillation. Genuine physics ambiguity. | **Eyeball** in the review modal (Cl(t) history beside the verdict). Usual remediation: **Continue +6h**. |
| **period detector** | 1 | Conflicting half-window period estimates. | Eyeball; continue or full-tier. |

**How to review**: on any airfoil detail page (e.g. https://airfoils.pro/airfoils/naca-0012),
the "Solver work" section groups points per condition; an orange `needs review` badge
opens the P1 popover → "review ▸" opens the results modal in **review mode** (gate
checklist + Cl/Cd time-series + frame player + verdict buttons + "review next ▸"
stepper). Verdicts: **Accept with waiver / Continue / Retry / Request full tier /
Exclude / Defer**. All admin-gated; anonymous visitors see state + evidence only.

---

## 5. The failure class (18 points, all honest)

Every `failed` row is **S1223 heavy-chord mesh degeneracy**:
`OpenFOAMError: mesh degenerate at this fidelity tier (max non-orthogonality 88.2–88.3°)`.
The mesh-QA gate fails the case in **seconds at mesh time** (no solver burn). Root
cause: S1223's deep concave cove + the wall-function layer folds the blockMesh C-grid
transfinite blending past 85° non-orthogonality. This is a **documented geometric
limit**, not a regression; the aspect-ratio-only waiver (build `argate`) correctly does
NOT apply here because non-orthogonality exceeds the hard 85° threshold. On the site
these render as `blocked` (red) with "mesh QA gate" named. Their real path is
full-tier URANS or future mesher/numerics work — **no action needed for the campaign**.

---

## 6. Open threads & prioritized debugging plan

1. **[systemic, proposed] Adaptive frame cadence** — the frame-recorder review class
   (24 pts and growing) all share one cause: `URANS_FRAME_WRITE_PER_CYCLE` cadence is
   derived from the *estimated* period, which under-resolves when the real period comes
   in shorter (small chord + high α). **Fix**: have the engine set/adjust the frame
   write interval from the *measured* period mid-solve (after the period detector
   locks), so `frames/cycle ≥ URANS_MIN_FRAMES_PER_CYCLE` is met by construction. This
   would drain most of the review queue systemically instead of case-by-case waivers.
   Not yet built — awaiting go-ahead. (~1 Codex engine lane + recall-proof + rebuild.)
2. **[watch] Disk trend during wave-2** — URANS job dirs are multi-GB; disk went
   33%→55% as wave-2 ramped. Retention is keeping pace (63 GB reclaimed) but confirm it
   stays ahead. The monitor now emits `DISK-WARN` at ≥80%. If it climbs, the
   `RETENTION_CONTINUABLE_DAYS`/strip cadence can be tightened, or continuable
   case-state kept for fewer points.
3. **[user action] Work the review queue** — 0 human verdicts so far. Frame-recorder
   points are safe waives; stationarity points want a look. The "review next ▸" stepper
   walks them.
4. **[known limit] S1223 heavy cells** — parked as honest mesh failures. Real fix is a
   curvature-aware mesher improvement (concave-cove-aware C-grid blending) or routing
   these to full-tier. Not campaign-blocking.
5. **[deferred] Remote solver on the Windows box** — validated end-to-end, dormant,
   ready to deploy (§7). Note the scope caveat there.
6. **[minor, pre-existing] sweeper.test.ts order-dependent "hang"** — diagnosed as
   cold-I/O after an OrbStack VM restart, NOT a code bug (DecisionHistory 2026-07-10).
   Left as-is with a guardrail note.

---

## 7. Remote solver / Windows deployment

**Status: validated live (this Mac ran as a remote solver against the prod hub),
6 defects found & fixed & test-pinned, now dormant.** The hub keeps its sync config;
`registered_remote_solvers` shows `mac-m5max-validation` idle (~7h stale — expected,
it's off).

**Architecture (pull model)**: a remote instance registers with the hub, **claims**
sweep-gap promises from *enabled* presets, mirrors airfoil+numerics locally, solves
through its own full pipeline (incl. the ladder), and **pushes** results + media +
evidence back to `/api/sync/v1/polars`.

**To deploy on Windows**:
1. Run the full compose (its **own** postgres — do not collide with the hub's).
2. Set `sync_api_settings` id=1: `upstream_base_url=https://airfoils.pro/api/sync/v1`,
   `upstream_secret=<hub secret>` (stored in prod `sync_api_settings.secret`),
   `remote_solver_enabled=true`, `remote_solver_cpu_budget=<box cores>`,
   `remote_solver_claim_size=<α per promise>`.
3. Keep local `sweeper_state.enabled=false` unless the box should also run its own
   public sweeps.
4. Hub grants already set: `sweeps.fetch`, `polars/evidence_artifacts/result_media.push`.

**IMPORTANT scope caveat**: remote solvers pull from **enabled presets' gaps**.
Campaign presets are **disabled by design**, so the Windows box will accelerate the
**public sweep pool**, *not* the running campaign's wave-2 directly. If the goal is to
throw the Windows cores at campaign-scale work, we must either enable broad public
presets or extend the promise source to campaign points — a small scoped change, ask
before assuming.

---

## 8. Operational runbook

```bash
# SSH (key is repo-local, NOT ~/.ssh). Use the IP if DNS flakes.
ssh -i .ssh/airfoilsroot_ed25519 airfoilsroot@35.234.124.80   # or @airfoils.pro

# Mint an admin ops token (secret rotates each deploy). Writes /tmp/adm.token itself —
# do NOT capture its stdout as the token.
ssh ... 'bash /opt/airfoils-pro/mint-admin-token.sh'   # -> /tmp/adm.token on the VPS

# Deploy NODE (api/web/sweeper): just push master. GH Actions rsyncs + restarts.
git push origin master   # workflow "Deploy Airfoils.Pro VPS"

# Deploy ENGINE (Python changed): push, then rebuild on the VPS with a new build id.
ssh ... 'TOK=$(cat /tmp/adm.token); ADMIN_COOKIE="aero_admin=$TOK" \
  bash /opt/airfoils-pro/app/scripts/deploy/rebuild-engine.sh prod-YYYYMMDD-tag'

# Campaign state (prod DB container = app-postgres-1, user/db aerodb):
ssh ... 'docker exec app-postgres-1 psql -U aerodb -d aerodb -At -F" | " -c "<sql>"'
```

**Local dev / engine tests** (this Mac):
- Test DB: OrbStack container `aerodb-pg` on `127.0.0.1:5544`.
- **Engine tests MUST be** `.venv/bin/pytest tests/ -m "not integration"` — bare
  `pytest` runs real OpenFOAM docker solves (banned; battery).
- Node suites: `pnpm --filter @aerodb/{api,sweeper,web,core,db} test`. `pnpm typecheck`.
- **No local browser launches** (sandbox Chrome SIGABRTs; user rejected Playwright).
  Verify UI via unit tests; the user eyeballs live.

**Monitor**: a persistent background Monitor (`continuation-watch.sh`, IP-pinned)
streams campaign totals / needs-review / march-guard / disk / container health on
state change. It survives DNS blips.

---

## 9. Hard-won gotchas (do not relearn these)

- **DB column casing**: drizzle's `ts()` makes **camelCase** columns (`"createdAt"`,
  `"heartbeatAt"`, `"revokedAt"`). Raw SQL and migrations must quote them; unquoted
  snake_case silently fails or 500s. Migration 0040 shipped snake_case and had to be
  renamed live.
- **Shell CWD drift**: working dirs persist across tool calls. A `cd` earlier can make
  a later `git add <path>` miss (→ a commit whose message lies about its contents).
  Start compound commands with an explicit `cd` / use absolute paths. (Now a global
  policy in `~/.claude/CLAUDE.md`.)
- **Reseed sequence**: `pnpm --filter @aerodb/db reset` drops **public AND drizzle**
  schemas (migrations no-op otherwise) → migrate → seed (1621 airfoils) → **symmetry
  backfill** (seed doesn't set `isSymmetric`; 119) → flip `sweeper_state.enabled=true`
  (seeds false). Backup with the postgres-docker-backup skill + `--test-restore` FIRST;
  prod data is VALUABLE.
- **node-api mounts engine data `:ro`**; the one writable path it needs (sync imports)
  is a dedicated nested volume `sync_imports` at `/data/airfoilfoam/sync-imports`.
- **Remote push payloads carry base64 media inline** → Postgres 256 MB jsonb ceiling +
  Fastify 1 MiB bodyLimit. Both scoped/sanitized; see commits `628e…`→`4f95…`.
- **Heavy heredoc through ssh+docker+psql**: quoting breaks silently. Write a script
  file locally, pipe via `ssh 'bash -s' < file`.

---

## 10. Everything shipped this session (deployed + test-pinned)

Per-tier URANS mesh definitions (wall-function full-tier default) · DB reseed + clean
relaunch (uniform provenance) · engine job-dir **retention** (strip/reaper/orphan
sweep) after a disk-full incident · detail-page fixes (support-gated fit curves killing
the S1223 phantom lobe, restored point-click, condition-grouped **solver-work redesign**
with honest status taxonomy — no more "rejected"/"failed" — + P1 popover + Continue
controls) · the **needs-review journey** (waive/exclude/defer verdict overlay + SimModal
review mode) · oscillating-steady snapshot caption · mesh-gate **aspect-ratio waiver**
(prod false positive) · **remote solver API** validation + 6 hardening fixes · gate
attribution fix. All green: engine 365, api 131, sweeper 150, web 259, core 108.
