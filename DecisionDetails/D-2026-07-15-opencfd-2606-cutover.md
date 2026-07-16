# D-2026-07-15-opencfd-2606-cutover

## Context

The deployed/default OpenCFD worker is currently built from
`opencfd/openfoam-default:2406`, and its logical identity, queue handshake,
setup revisions, jobs, results, caches, documentation, and execution pool all
name OpenCFD 2406. The owner directed that OpenCFD 2606 be implemented, that
the 2406 container be removed, and that the existing campaign continue on
2606.

This is a numerical-engine cutover, not a container-label update. Completed and
in-flight 2406 work already has real provenance. A 2606 process must not claim
that identity, and accepted 2406 evidence must not be reused as if it were a
2606 result. Conversely, replacing only the unfinished cells would leave the
campaign grid divided across two method-compatibility identities and would not
produce one complete 2606 polar.

## Decision

OpenCFD 2606 becomes the default and only executable OpenCFD implementation.
The 2406 execution pool is disabled and its deployed worker container is
removed after a guarded drain, but the 2406 logical implementation, runtime
builds, setup snapshots, attempts, results, artifacts, manifests, and cache
provenance remain immutable historical records.

The active campaign continues in the same campaign lineage through an explicit,
linked successor generation. The successor resolves a new immutable OpenCFD
2606 setup/method identity and requests the exact eligible source snapshot:
current-generation `active`/`kept` conditions and non-released points,
including eligible cells that already have accepted 2406 evidence. Released or
superseded historical cells are not silently revived. A 2406 result cannot
settle a 2606 obligation. Public 2606 fits,
metrics, curves, comparisons, and caches use only accepted 2606 evidence. The
2406 evidence remains inspectable under its own identity and may be exposed as
a separate historical series, but it is never merged into the 2606 series.

This decision supersedes the statement in
`D-2026-07-15-multi-engine-identity` that OpenCFD 2406 remains the default and
executable rollback path. It does not supersede that decision's immutable
engine identity, runtime provenance, separate Foundation 14 worker, typed
profiles, capability boundary, or future-engine model. A rollback image may be
reconstructed explicitly from the retained 2406 digest during maintenance; a
live 2406 pool is not retained merely for rollback.

## Authoritative OpenCFD 2606 evidence

OpenCFD/Keysight released OpenFOAM v2606 on 2026-06-26. The official release
announcement describes the supported Linux packages, source distribution, and
new functionality:
<https://www.openfoam.com/news/main-news/openfoam-v2606>. The official release
history publishes `OpenFOAM-v2606.tgz` with MD5
`35cbe9bc512fe087e4a472b1cb610063`:
<https://www.openfoam.com/download/release-history>. The tarball obtained from
<https://dl.openfoam.com/source/v2606/OpenFOAM-v2606.tgz> on 2026-07-15 also
measured SHA-256
`2a1310e3ed192cc4c521e1d22dcc176f57bec61160c878dc4348f21d6672294d`.

The protected official source tag is `OpenFOAM-v2606` at commit
`481094fdf34f11ed6d0d603ee59a858a0124236d`:
<https://gitlab.com/openfoam/core/openfoam/-/tags> and
<https://gitlab.com/openfoam/core/openfoam/-/commit/481094fdf34f11ed6d0d603ee59a858a0124236d>.
OpenCFD moved the canonical source repository from `develop.openfoam.com` to
the `openfoam/core/openfoam` GitLab project before this release, so new 2606
provenance uses the GitLab URL rather than the legacy host.

The official `opencfd` Docker Hub account publishes a runtime-specific image,
`opencfd/openfoam-run:2606`, containing applications and runtime libraries but
not source, compilers, or tutorials:
<https://hub.docker.com/r/opencfd/openfoam-run>. That is the appropriate base
for this worker because XFoilFOAM executes packaged solvers and utilities and
does not compile OpenFOAM extensions at runtime. The tag is pinned by the
multi-platform OCI index digest, never consumed as a mutable tag:

- index: `sha256:4229997e74defb81548222d511b8e3b95b98305e5df41b8e88b031813fe47eeb`;
- linux/amd64 manifest: `sha256:0b0892f2fadbf5602f8fad8f8e507a81b6995863c7b021886a58ddce099e7a77`;
- linux/arm64 manifest: `sha256:7ad9ee415db514ecfab39718200049fac21dad4c4385c185595c08237f44929b`.

Registry and image inspection on 2026-07-15 verified API `2606`, patch `0`,
embedded build `_481094f-20260618`, and package version `2606.0~rc2-1`. Despite
the package revision suffix, its embedded source build is the exact protected
release-tag commit. The image provides the required `simpleFoam`, `pimpleFoam`,
`potentialFoam`, `checkMesh`, `decomposePar`, `reconstructPar`,
`foamDictionary`, and `foamToVTK` executables, and its environment is sourced
from `/usr/lib/openfoam/openfoam2606/etc/bashrc`. The image is based on Ubuntu
26.04 and Open MPI 5.0, whereas the pinned 2406 default image used Ubuntu 24.04
and Open MPI 4.1; that runtime change is an explicit canary and rollback risk,
not a reason to reuse the 2406 numerical identity.

The derived worker independently downloads the official architecture-specific
`openfoam2606_2606.0~rc2-1` package during its build. It verifies the literal
package SHA-256 (`aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d`
for amd64 and
`8d395ac52c284bc74c0aed774f692004d47ad7088596fabde5efc1f71991548a`
for arm64), verifies the package and installed versions, extracts the package,
and byte-compares the installed `simpleFoam` with the packaged executable.
Only then does it record the package and executable fingerprints. These values
are not build arguments, so a build caller cannot substitute a false digest
while retaining an otherwise valid image.

The exact registry digest is discovered and reviewed with:

```sh
docker buildx imagetools inspect opencfd/openfoam-run:2606
```

After the derived XFoilFOAM worker is published, its own OCI digest,
architecture, deterministic application-source SHA-256, OpenCFD source commit,
and upstream package/image fingerprints are recorded as runtime provenance.
The upstream index digest is not substituted for the derived worker's digest.

## Compatibility findings

The official v2606 source and tutorials retain the OpenCFD case dialect used by
this application: `transportProperties`, `turbulenceProperties`,
`application simpleFoam`, and `application pimpleFoam`. Exact source comparison
between the protected 2406 and 2606 tags found:

- the `pimpleFoam` application driver unchanged;
- `simpleFoam` extended to call dynamic-mesh updates, without changing the
  static-mesh control/dictionary contract used here;
- `potentialFoam` retaining `-writephi` and `-initialiseUBCs`, with an added
  finite-area guard unrelated to these cases;
- `forceCoeffs` retaining `coefficient.dat` and the coefficient vocabulary used
  by the parser; the v2606 reference remains
  <https://doc.openfoam.com/2606/tools/post-processing/function-objects/forces/forceCoeffs/>;
- `foamToVTK` retaining its ordinary conversion path while v2606 improves
  processor-boundary output and introduces optional VTK-HDF support:
  <https://www.openfoam.com/news/main-news/openfoam-v2606/post-processing>.

These facts justify a dedicated OpenCFD 2606 dialect derived from the existing
OpenCFD command/dictionary path, not a Foundation-style rewrite. They do not
establish numerical equivalence. Solver libraries, linear algebra, parallel
runtime, compiler/base operating system, and post-processing internals changed
across the four intervening releases. OpenCFD 2606 therefore receives its own
implementation identity and numerical compatibility namespace, and production
coefficients require real 2606 canaries and evidence.

## Local runtime verification evidence

This implementation was verified on 2026-07-15 in an isolated, subsequently
removed stack. It has not been deployed to production and did not mutate the
live campaign or its existing worker.

The successful isolated pre-storage-hardening canary receipt has SHA-256
`1ba02e2cf6af2fd3e94881e56c78aba4fe4b5f7b60a33fd4c984156e39c751a9`.
It remains historical local verification evidence, not a production-acceptable
receipt: the production gate additionally binds the current GCS bucket,
content-addressed object prefix, Zstandard policy, and every exact archive
generation, then rehydrates and rerenders those generations during recovery.
It measures derived worker image
`sha256:abb3efb6602bd920a86492fbd37aed7710dbe72c3fac9c94bbc5a5bf02ce255d`,
application-source SHA-256
`6465d92cf21cc1ce76ffc74a7791bf5b766b2a7abb01f745c5623900196d8cd3`,
and the exact source/package/base-image provenance recorded above. Its three
real application-boundary scenarios were:

- serial RANS job `4427655878364c0ab3cee80d05f5ad59`, which completed the
  requested 2° and 5° cells with one shared mesh build;
- two-rank MPI RANS job `fc7a5e730a744e96b4e038849edf7663`, which exercised
  decomposition and reconstruction; and
- forced URANS job `3ebaf92cfd194c15b4b772cd766cfcae`, which completed as a
  truthful no-shedding result with transient evidence and without fabricated
  periodic metadata.

The canary also retrieved and checksum-validated its immutable evidence and
media artifacts. Its isolated containers, networks, volumes, and leased port
were removed after verification; it is evidence for the deploy gate, not a
claim that production has already crossed it.

## Cutover sequence

1. Deploy the control-plane schema and register the checksum-pinned 2606
   implementation, runtime capabilities, dedicated execution pool, and exact
   route while that pool remains disabled. New setup creation defaults to
   2606; omission in genuinely historical payloads continues to mean legacy
   2406 and is never retroactively reinterpreted.
2. Fence new 2406 admission without terminating active solver work, record and
   pause every affected campaign while preserving its prior state, and cancel
   only work that has not entered execution. Wait for
   every live `simpleFoam`, `pimpleFoam`, meshing, decomposition, and
   reconstruction process to finish or reach a truthful terminal state. Use
   the solver-maintenance idle guard; never force-recreate the worker around an
   active solve.
3. With the drain and process-idle guards satisfied, rebuild and recreate the
   existing gateway/worker services from the pinned 2606 image. Reusing the
   service name removes the drained 2406 container; no parallel 2406 worker is
   retained. Recover stale controller shells only through the supported
   recovery endpoint.
4. Verify the live worker's exact identity and queue handshake, then activate
   only the 2606 execution pool. A request naming 2406 must fail closed as
   unavailable rather than run on the 2606 worker.
5. Run real serial RANS, two-rank MPI RANS, and forced full URANS canaries
   through the live application boundary. They must prove mesh reuse,
   potential initialization, steady and transient restart, force/y+ parsing,
   decomposition/reconstruction, VTK, stored media, streamed artifact
   checksums, and provenance. If any canary fails, disable the 2606 pool and
   leave affected campaigns paused; do not materialize successor work.
6. Only after every canary passes, snapshot each affected campaign's exact
   eligible source cells and create one idempotent successor generation linked
   to the predecessor and new 2606 setup revisions. Supersede old obligations
   as scheduling history, then materialize the same current-generation
   `active`/`kept` conditions and non-released points as fresh 2606 obligations.
   Do not mutate or delete completed or failed 2406 evidence.
7. Complete the cutover transaction, restore the sweeper's recorded prior
   state, and resume only campaigns that were runnable before maintenance;
   campaigns already paused remain paused. Prove that each successor generation
   progresses on 2606 and that every eligible source-snapshot cell is
   represented in its coverage ledger, and that formerly accepted eligible
   2406 cells are being recomputed rather than silently counted. Publish final
   2606 curves only when the ordinary accepted-evidence and fit-cache gates are
   satisfied.

## Alternatives

- **Change the Docker base and keep the 2406 identity.** Rejected because it
  would make new 2606 executions indistinguishable from historical 2406
  evidence and allow invalid cache/polar reuse.
- **Rewrite existing 2406 setup, job, and result rows to 2606.** Rejected
  because those rows describe real past executions; changing their label would
  fabricate provenance and destroy rollback/audit evidence.
- **Move only queued or unsolved campaign cells to 2606.** Rejected because the
  resulting campaign would have a partial 2406 series and a partial 2606
  series. Combining them would violate method compatibility, while keeping them
  separate would leave neither engine with the complete eligible polar grid.
- **Keep 2406 and 2606 execution pools enabled together.** Rejected because the
  owner requested removal of the 2406 container, default routing would remain
  ambiguous, and maintaining two OpenCFD workers adds operational surface
  without making mixed numerical evidence valid.
- **Build 2606 directly from source or an Ubuntu package.** Reserved as a
  fallback if the official runtime image fails a required canary. It offers
  compiler/base-image control but adds a large build and dependency-verification
  surface. The checksum-pinned official runtime image is the simpler
  authoritative distribution for a worker that needs no OpenFOAM build tools.
- **Use a third-party 2606 image or mutable `latest` tag.** Rejected because an
  official checksum-pinned OpenCFD runtime exists and provides a stronger,
  reversible provenance boundary.

## Evidence, licensing, and rollback boundaries

OpenFOAM v2606 source is GPL-3.0-or-later under the official license:
<https://gitlab.com/openfoam/core/openfoam/-/blob/OpenFOAM-v2606/LICENSE.md>.
The official container packaging assets are also GPL-3.0-or-later:
<https://gitlab.com/openfoam/packaging/containers>. Distribution of the derived
worker must preserve the upstream notices and satisfy the applicable GPL source
obligations. XFoilFOAM must describe itself as a worker *for* OpenFOAM/OpenCFD
rather than imply that the derived application image is an official OpenCFD
distribution; OpenCFD's trademark guidance is
<https://www.openfoam.com/openfoam-trade-mark-guidelines>.

Removing the deployed 2406 container does not authorize deletion of its
evidence or provenance. Its pinned former index digest
`sha256:dd5aa20630a55722663bf83ba0cb74870cba130081303e32e3865007fa2aa35a`
and exact pre-cutover application source commit
`313ad394d8364ae67c62b0929238e23355073f15` (tree
`f4ee8cc78a21d512b6b1aaf2a568d0dbd3b3da9f`) remain recorded for an explicit
maintenance rollback. `scripts/deploy/reconstruct-opencfd-2406-image.sh`
exports only that commit into an isolated build context, builds it with
`docker/Dockerfile.worker-opencfd2406-rollback`, verifies the OpenFOAM 2406
environment and packaged `simpleFoam`, and writes a validated, mode-0600
receipt with the resulting image ID and measured binary checksum. Receipt
publication requires a pre-existing non-symlink audit directory, is atomic and
no-clobber, and fsyncs both the receipt and its parent. Neither file is part of
a Compose graph and the command changes no pool, campaign, database, or running
service. If 2606 fails before activation, the cutover stops and this image can
be reconstructed for a separately approved idle-guarded rollback transition.
If 2606 fails after it has produced evidence, that evidence also remains
immutable; recovery creates another explicit generation/runtime transition
rather than relabelling either release.

The emergency reconstruction path was executed in isolation on 2026-07-15.
It produced image
`sha256:4b9429ebea69d5ec59339b81931bfb3367e80393a1ab490e8976bb61089d8a23`
and a mode-0600 receipt whose SHA-256 is
`36c7e1049bfbc35324d19c7f31fb162dbdedb8c0b25b53f4442d8678eff00b9f`.
The exported build-context SHA-256 was
`37448cc1139d3a4ea9b965f2233877eaef412ee688a3832bdf07468f3da8421a`;
the runtime measured package `2406.0-1` and `simpleFoam` SHA-256
`192083fbf1619ca9947a29139c980806d098b2397df003bcf564419673d2b704`.
The receipt records `deployed: false`, and no reconstruction container was
left running.

## Acceptance criteria

The cutover is complete only when all of the following are proven:

- the derived worker reports the exact OpenCFD 2606 logical identity, source
  revision, application-source fingerprint, architecture, and image/package
  provenance through health, queue, job, result, and evidence manifests;
- real serial and MPI RANS/URANS paths and their stored evidence succeed under
  the same container used for the campaign;
- the 2406 execution pool is disabled, no OpenCFD 2406 worker container or
  active process remains, and a 2406-routed request cannot be consumed by the
  2606 worker;
- every pre-cutover 2406 attempt/result/artifact retains its original identity
  and checksum, and none settles a 2606 obligation or enters a 2606 fit/cache;
- the active campaign has exactly one linked 2606 successor generation whose
  coverage is the exact eligible source snapshot, including recomputation of
  formerly accepted eligible 2406 cells;
- scheduler restart, stale-job recovery, sync import/export, admin controls,
  and public polar reads preserve the same release boundary; and
- rollback can reconstruct the recorded 2406 image deliberately without a
  normally running 2406 container or any provenance rewrite.
