# D-2026-08-12 — Archive truth and disposable continuation

## Context

Production held completed URANS attempts whose authenticated GCS archives and
accepted immutable engine interpretations were present, but the older mutable
classification projection had rejected them. Most were typed no-shedding
steady-equivalent evidence; a smaller set reported complete period counts a
few floating-point ulps below the integer threshold. Because those failed
projections had no `current_result_attempt_id`, the archive selector treated
the exact attempt as stale and no preliminary obligation could settle.

Separately, continuation read an aggregate multi-angle `result.json` under a
64 MiB metadata cap. Large valid jobs therefore failed before their exact case
or archive could be inspected. Repeating the same continuation could never
repair that representation problem.

## Decision

1. An accepted archive reduction remains the scientific authority. It may
   append a canonical-selection event and atomically project its exact attempt
   when the result is still the pointer-less failed projection of the same job,
   physical cell, attempt, and current archive. Any active, newer, differently
   owned, or already-selected result fails the compare-and-swap.
2. Selected periodic and steady-equivalent archive interpretations are valid
   classifier inputs. Periodic URANS still requires real stored video;
   no-shedding steady-equivalent evidence uses static fields and must not invent
   a periodic animation. Exact integer period thresholds tolerate only
   numerical representation error.
3. Successful canonical selection closes the matching physical preliminary
   obligation and refreshes campaign progress and fitted polar caches.
4. Every new aggregate result writes bounded, exact per-case continuation
   metadata with job-level engine identity. Continuation prefers that sidecar,
   so its memory and validation cost is independent of batch size.
5. A typed permanent failure of an old continuation source retains its
   immutable failed submission, excludes that checkpoint from another
   continuation, and returns the obligation to one fresh FAST solve only when
   its existing physical-attempt budget still permits it. Exhausted physical
   budgets remain blocked.
6. Numerical-noise recovery remains targeted: the existing one-time Co<=1,
   tighter pressure/transport, 4x3 PIMPLE rung now also triggers on typed
   high-frequency/noisy tails, persists with the exact trajectory, and never
   slows healthy jobs globally.

## Alternatives considered

### Mark rejected classifications accepted in place

Rejected. It mutates historical judgment and can publish from an engine summary
before immutable archive reduction.

### Increase or remove the aggregate JSON size limit

Rejected. Batch size would still control continuation memory and latency, and
an unbounded document could exhaust the worker.

### Permanently block every unusable checkpoint

Rejected for the production disposable-compute policy. The checkpoint has no
value once exact restart is impossible; a bounded fresh calculation is cheaper
and produces new real evidence.

### Apply conservative numerics to all URANS work

Rejected. Healthy trajectories should retain normal throughput. The stronger
settings are justified only after the live quality reducer identifies the
typed numerical-noise class.

## Verification

- Core regressions cover ulp-level period tolerance, a genuinely short period
  rejection, selected periodic video requirements, and selected no-shedding
  evidence without fabricated video.
- Sweeper policy regressions fence pointer-less archive promotion to the exact
  terminal projection and retain active/newer/current generations.
- Engine regressions prove a result larger than 64 MiB resumes through its
  exact bounded sidecar and prove both impulsive and high-frequency tails arm
  the persistent conservative recovery rung.
- DB-backed ladder regression proves permanent continuation failure produces
  one fresh request without another `continue_from`, while preserving the
  failed submission audit and physical-attempt limit.
