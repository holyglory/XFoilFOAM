# Conservative preliminary-URANS retries

## Decision

Keep the first FAST-URANS physical attempt on the adaptive throughput path.
When the durable preliminary obligation has already consumed a physical
attempt, start every subsequent physical attempt on the existing conservative
quality-recovery rung from its first transient step: `maxCo <= 1`, the retained
startup `maxDeltaT`, pressure tolerance `1e-8` with `relTol 0.01`, transport
tolerance `1e-9` with `relTol 0.01`, and a 4x3 PIMPLE correction loop.

The controller derives this choice from the obligation's immutable physical
attempt count, writes the choice into both the engine request and durable job
payload, and pins engine URANS-recovery capability v12. An older or unknown
engine defers a repeated attempt before job composition/submission. First
attempts continue to use the v11 live detector, which may arm the same rung
only after measured numerical contamination.

## Why

Current v11 rejected evidence is genuinely non-publishable: archive reduction
shows coefficient-mean outliers, high-frequency bursts, phase drift, and
insufficient frame density. Relaxing those gates would publish unreliable
polars. Repeating the same throughput-oriented startup and waiting for two
measured periods before tightening numerics instead spends the retry budget on
a failure mode the previous attempt already demonstrated.

Making every first attempt conservative would reduce throughput for the large
population of healthy cells. Selecting the stronger rung only for repeated
physical work concentrates the extra cost where production evidence justifies
it. The change improves the probability of a clean calculation; it does not
promise that every separated flow is periodic or acceptable, and rejected
evidence remains immutable and unpublished.

## Evidence and verification

- Python request validation permits the flag only for capability-pinned,
  forced preliminary URANS.
- Engine tests prove the complete marker and all conservative dictionary
  entries exist before the solver process starts.
- Pure scheduler tests prove first-attempt pass-through, repeat detection,
  pre-v12 deferral, and v12 request/payload pinning.
- Production verification requires both solver roles to advertise v12 and a
  real repeated preliminary job to retain `uransQualityRecovery: true` plus
  immutable evidence generated under the marker-owned dictionaries.
