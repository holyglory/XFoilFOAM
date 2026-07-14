# D-2026-07-14-campaign-capacity — Engine-observed capacity and bounded media completion

## Production evidence

On 2026-07-14, the VPS had eight CPU cores available to the worker but the
active campaign's only `simpleFoam` process used one core. The engine recorded
`requested_policy=auto`, `resolved_policy=airfoil_parallel`,
`resolved_case_concurrency=1`, and `queue_depth=20` for a 78-case,
three-speed continuous RANS request. That queue-depth value came from Node's
logical campaign group count, not the engine's Redis queue or token pool.

A separate engine-complete job remained `ingesting` because a synchronous
default-media renderer rejected its missing URANS video. The result-media
repair ledger already provides per-result leases, immutable evidence fences,
and a three-attempt bounded retry policy, but completed-job ingest invoked the
same renderer before it could mark the job done.

## Alternatives considered

1. Keep controller backlog as an engine scheduling hint. This preserves the
   previous implementation but treats queued future work as currently occupied
   CPU and leaves available capacity idle.
2. Force OpenFOAM/MPI parallelism or change continuous AoA marching. This may
   use more cores but changes solver execution and warm-start behavior, which
   is not needed to correct the measured scheduler fault.
3. Let the engine use its actual Redis queue and worker CPU-token pressure,
   retain serial angle marching within each polar, and run presentation-media
   rendering only after job finalization in a separate durable repair service.

Option 3 was selected. It is reversible in the Node control plane without an
engine rebuild, keeps the existing engine's automatic congestion behavior, and
preserves the normal evidence gate: missing URANS media remains rejected until
a real, checksummed repair artifact is stored.

## Scope and verification

- Local requests no longer include `resources.queue_pressure`; an upstream
  explicit request can still use the engine's documented field.
- Shared engine `mesh_evidence` is retained under the existing database `mesh`
  artifact kind, with `engineArtifactKind=mesh_evidence` provenance.
- Regression coverage asserts omitted logical queue pressure, retained mesh
  evidence, no synchronous rendering in completed-job ingestion, and terminal
  completion plus durable repair for an unsteady result missing video.
- The generic crash retry excludes an exact `missing-urans-video` rejection;
  that result remains with its completed job and is repaired through the
  bounded media ledger rather than launching duplicate CFD work. While that
  repair is pending, Solver Work reports automatic repair rather than a user
  actionable block.
- `media-repair` is a separately deployed Node control-plane service. It
  claims one leased repair at a time only after the producing CFD job is
  terminal; scheduler ingest never calls field-extents or default-render APIs.
- Production deployment must update Node control-plane services only. It must
  not recreate the active OpenFOAM worker or API services.
