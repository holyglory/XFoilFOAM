# Solver engine contract

Status: contract version 1, implemented for executable OpenFOAM OpenCFD 2606
and opt-in OpenFOAM Foundation 14. OpenCFD 2406 is retained as historical
identity/evidence only.

This document defines the boundary between reusable aerodynamic setup, a
numerical solver implementation, mutable execution capacity, and immutable
result evidence. It is the integration contract for adding another engine; it
is not an assertion that two engines with similar inputs are numerically
interchangeable.

## Current implementation inventory

| Engine                                       | Logical identity                                      | Method keys                       | Route                    | Default state                                                                |
| -------------------------------------------- | ----------------------------------------------------- | --------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| OpenFOAM, OpenCFD distribution, release 2606 | `openfoam / opencfd / 2606 / numerics 1 / adapter 1`  | `openfoam.rans`, `openfoam.urans` | `openfoam-opencfd-2606`  | gateway/default worker enabled after guarded activation                      |
| OpenFOAM Foundation, release 14              | `openfoam / foundation / 14 / numerics 1 / adapter 1` | `openfoam.rans`, `openfoam.urans` | `openfoam-foundation-14` | adapter registered; Compose profile, gateway route, and database pool opt-in |
| Historical OpenCFD release 2406              | `openfoam / opencfd / 2406 / numerics 1 / adapter 1`  | stored evidence only              | `celery`                 | implementation/evidence retained; pool disabled; no executable worker        |

OpenCFD 2606 is the default for a new request that omits `expected_engine`.
New control-plane callers still send an exact identity and pool. Historical
2406 setup/job/evidence rows are never reinterpreted as 2606. Foundation 14 is
a second implementation, not an in-place upgrade of the OpenCFD worker.

No XFoil adapter, queue, solver profile, or runtime is included in this
implementation. The owner's future open-source solver based on Drela's thesis
is not MSES and must not use `mses` as its family, distribution, method, or
provenance label. It receives a canonical project name and release lineage when
the owner chooses them.

## Logical identity

Every executable implementation has the following immutable logical identity:

| Field                      | Meaning                                                                                                  | Change rule                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `family`                   | Extensible engine family slug, for example `openfoam`                                                    | New numerical engine family                              |
| `distribution`             | Concrete implementation/distribution, for example `opencfd` or `foundation`                              | Different upstream implementation or lineage             |
| `version`                  | Exact upstream release, for example `2606` or `14`                                                       | Upstream release changes                                 |
| `numerics_revision`        | Revision of generated inputs, defaults, algorithms, or adapter behavior that can change numerical output | Increment for any numerically significant wrapper change |
| `adapter_contract_version` | Request/status/result wire contract understood by the gateway and worker                                 | Increment for an incompatible protocol change            |

The exact handshake key is:

```text
<family>:<distribution>:<version>:numerics-<numerics_revision>:adapter-<adapter_contract_version>
```

The numerical compatibility/cache key omits the adapter contract:

```text
<family>:<distribution>:<version>:numerics-<numerics_revision>
```

`adapter_contract_version` is needed to prevent a client from silently talking
to an incompatible worker. It does not split a public polar when only transport
or schema packaging changed. Conversely, `family`, `distribution`, `version`,
and `numerics_revision` always participate in method compatibility: evidence
from OpenCFD 2606, historical OpenCFD 2406, and Foundation 14 cannot be merged merely because Reynolds,
Mach, geometry, and turbulence settings display the same values.

The database stores these values in an immutable `solver_implementations` row,
along with the implementation's `method_family`, declared capabilities,
upstream URL, and SPDX licence. Changing identity or capabilities creates a new
row; retirement only prevents future selection and never relabels evidence.
Historical snapshots whose actual solver cannot be proven remain attached to a
retired `legacy/unknown` implementation rather than being guessed as OpenCFD.

## Method and setup ownership

Reusable common setup contains only geometry, physical operating state,
reference geometry, and the requested sweep. Numerical settings remain typed
and owned by the selected solver family:

- OpenFOAM mesh and solver profiles remain OpenFOAM-specific.
- The implementation identity is part of every solver profile and immutable
  preset revision.
- `method_family` identifies the broad numerical method offered by an
  implementation; a result-level `method_key` identifies what actually ran.
  Current keys are `openfoam.rans` and `openfoam.urans`.
- A future thesis-derived engine adds its own typed discretisation/method
  profile and result method keys. It must not accumulate irrelevant nullable
  OpenFOAM settings in a universal solver table.
- Scheduling, credentials or licence seats, output/media policy, and execution
  capacity do not participate in physical/numerical compatibility.

Public polar compatibility is a value-level hash of physical setup plus
implementation family, distribution, release, method family, and numerics
revision. It excludes display names, profile IDs, revision numbers, jobs,
execution pools, adapter contract version, build provenance, sweep definition,
scheduling, and output policy.

## Request and worker handshake

A new `POST /polars` caller supplies both:

```json
{
  "expected_engine": {
    "family": "openfoam",
    "distribution": "foundation",
    "version": "14",
    "numerics_revision": "1",
    "adapter_contract_version": 1
  },
  "expected_execution_pool": "openfoam-foundation-14"
}
```

Those fields are added to the normal polar request; the abbreviated object is
not a complete simulation request.

The gateway performs these checks before enqueueing solver work:

1. The exact implementation is registered.
2. Its handshake key is in `AIRFOILFOAM_ENABLED_ENGINE_KEYS`.
3. The requested execution-pool route equals the adapter route.
4. The job is sent only to that route.

The worker repeats the engine and route checks before starting mesh or solver
work. Unsupported identities return a typed validation failure; registered but
disabled adapters and pool mismatches return conflicts. A worker identity or
route mismatch is infrastructure failure evidence and must not consume a
numerical solver attempt.

Pending status/result objects preserve `requested_engine` and
`requested_execution_pool` without claiming that a worker executed them. Once
execution starts, `engine` and `execution_pool` contain the actual worker
acknowledgement. Cancellation and orphan recovery use the persisted requested
route, so a Foundation job is never reaped through the OpenCFD queue.

`GET /health` and `GET /capabilities` expose the gateway's default, enabled,
and registered-but-disabled logical inventories. Exact runtime provenance is
not fabricated by the lightweight gateway; it appears only after the executing
worker acknowledges a job.

## Execution pools and capacity

`solver_execution_pools` is an operational routing domain. A pool binds exactly
one immutable implementation to one immutable routing key, while `enabled`,
capacity, display name, and operational metadata are mutable. A solver profile
does not become schedulable until exactly one matching pool is enabled.

The registered pools after the cutover are:

- `openfoam-opencfd-2606` → `openfoam-opencfd-2606`, enabled only after a live
  2606 worker handshake;
- historical `openfoam-opencfd-2406` → `celery`, disabled;
- `openfoam-foundation-14` → `openfoam-foundation-14`, disabled.

Enabling a pool is rejected unless a fresh gateway capability probe acknowledges
the exact implementation/route and a fresh Celery inspector snapshot proves a
live worker consumes that route. The inspector proof includes the worker's
deliberately exposed routing key and exact runtime identity; a worker on the
right queue with the wrong logical engine, or with no content fingerprint,
does not authorize activation. Disable a pool before draining or retiring its
worker. Pool changes affect future scheduling only and never change stored
results.

Queue observability reports every registered adapter route with a separate
enabled flag. Its top-level depth is the sum across enabled and disabled routes.
The guarded rebuild validates that sum and refuses while any registered queue,
reserved task, scheduled task, active task, or live solver process remains.
Disabling a pool therefore stops new admission but does not make its existing
queued work invisible.

### OpenCFD 2406 to 2606 campaign cutover

The release transition is a staged solver-maintenance operation, not a label
edit. `scripts/deploy/vps-redeploy.sh` first deploys migration 0066 and the
authenticated cutover endpoints while the 2406 worker continues running.
`scripts/deploy/rebuild-engine.sh` then:

1. probes that control-plane/schema contract before mutation;
2. disables new 2406 admission, records each affected campaign's prior state,
   pauses it, and lets already accepted 2406 work finish and ingest;
3. proves the database, Celery queues, and live OpenFOAM processes are drained;
4. replaces the Compose `worker` service with the 2606 image and new route;
5. activates the 2606 pool only after a fresh gateway and worker handshake,
   then runs real serial RANS, two-rank MPI RANS, and forced-URANS canaries that
   verify exact runtime provenance and retrievable checksummed evidence;
6. only after those canaries pass, creates a linked current condition
   generation for the same campaign and copies the exact eligible source
   snapshot (current-generation `active`/`kept` conditions and non-released
   points) to fresh 2606 revisions; and
7. completes the cutover and restores only campaigns that were runnable before
   preparation. A canary failure disables the target pool and leaves the
   recorded campaigns paused for a safe replay.

The four-field maintenance marker and original sweeper state are fsynced and
atomically replaced in `.env.deploy` before the first mutating prepare call.
Preparation re-closes both source and target pools. Once the fail-safe is
armed, any nonzero exit stops the sweeper and disables 2606 admission. An
unacknowledged attestation leaves its exact mode-0600 receipt intact; the
certification-only path replays that receipt against the unchanged live
runtime, atomically stores the attestation ID, and removes the receipt only
afterward. Any nonempty, malformed, or inconsistent recovery state blocks a
normal rebuild. Finalize and complete are idempotently replayed with the stored
attestation, and the marker clears only after exact continuation evidence or a
truthful aggregate `not_required` result. The recorded pre-maintenance sweeper
state, not incidental state at recovery entry, controls restoration.

Before a receipt or attestation exists, the guarded build command can resume
the recorded pre-attestation stage. After either exists, recovery must use
`scripts/deploy/rebuild-engine.sh --certify-opencfd-2606-continuation`; it
deliberately performs no rebuild or runtime substitution. Old condition points
are released from scheduling but retain their 2406 result/evidence links; old
results, attempts, artifacts, caches, and runtime provenance are neither
deleted nor relabelled. The new generation recomputes even previously accepted
eligible cells, preventing a mixed-release polar.

All Compose engine workers mount one `engine_runtime` volume at
`/data/airfoilfoam-runtime` and use the same CPU-token ledger. Token leases are
owner-scoped and heartbeat/TTL protected so adding a worker container does not
double the global solver budget and one container cannot purge another live
container's leases. Distribution-specific Celery concurrency is still a worker
process limit, not an independent physical CPU allocation.

## Runtime provenance

Logical identity says what numerical implementation was requested. Runtime
provenance says which concrete build executed it. The worker acknowledgement
extends logical identity with:

- application `build_id`;
- upstream/source revision, when known;
- final worker OCI image digest, when known;
- deterministic SHA-256 of the adapter/application source manifest copied into
  the worker image;
- installed package checksum or executable checksum, when available; and
- runtime architecture.

The control plane canonicalises that payload into an immutable
`solver_runtime_builds` row keyed by SHA-256 of the exact provenance fields.
Jobs, attempts, accepted/rejected results, and evidence artifacts reference the
same implementation and runtime row. Unknown values stay null; an upstream
base-image digest must not be reported as if it were the final executing image.
Every new non-legacy acknowledgement must contain at least one real content
fingerprint: final OCI SHA-256, application-source SHA-256, installed-package
SHA-256, or solver-binary SHA-256. A build id or mutable source label alone is
not sufficient. Both worker Dockerfiles generate the application-source digest
from canonical relative paths and bytes in `pyproject.toml` and `src/`, so a
registry-supplied final OCI digest is optional without making provenance
label-addressed. `binary_sha256` remains reserved for an actual solver
executable and is never populated with the application digest. Historical
evidence with no trustworthy runtime acknowledgement keeps a null runtime FK.

The OpenCFD 2606 image does not trust a caller-supplied digest label. Its build
downloads the exact architecture-specific `openfoam2606` Debian artifact from
the official repository, verifies a hard-coded SHA-256 and package version,
extracts it, and byte-compares the installed `simpleFoam` executable with the
package copy before recording `package_sha256` and `binary_sha256`. The
production canary then requires the package digest for the worker's reported
architecture. The Foundation 14 package is likewise downloaded and verified
against a hard-coded release digest before installation. These release
fingerprints are literals rather than overridable build arguments.

Runtime-only rebuilds do not change numerical compatibility. If a changed
binary, package, dictionary template, default, or wrapper algorithm could
change values, ship a new `numerics_revision` even when the upstream release
number is unchanged.

## Evidence and cache contract

Every completed case archives immutable evidence before it is accepted:

- resolved logical engine identity and runtime provenance;
- the actual `method_key`;
- mesh/polyMesh, case dictionaries, logs/stdout/stderr, force coefficients,
  y+ when present, and required field exports;
- selected steady time or exact URANS averaging window; and
- checksummed evidence/media manifests, including unavailable-field reasons.

The generic artifact kind is `engine_bundle`. The legacy `openfoam_bundle`
label remains readable for older evidence but is not the
cross-engine contract. Opening a result must not generate missing default media
or synthesize fields.

Mesh and steady-seed cache namespaces include the numerical compatibility key.
Cache statistics and size eviction cover all namespaces as one global storage
budget. Runtime build id and adapter contract version are excluded unless a
runtime change also increments `numerics_revision`.

## OpenFOAM dialect boundary

OpenCFD and Foundation are related OpenFOAM distributions but expose materially
different case and command contracts. The adapters currently resolve these
differences explicitly:

| Concern                           | OpenCFD 2606                       | Foundation 14                                                |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| Steady solver                     | `simpleFoam`                       | `foamRun -solver incompressibleFluid`                        |
| Transient solver                  | `pimpleFoam`                       | `foamRun -solver incompressibleFluid` with transient control |
| Potential initialization          | `potentialFoam -writephi`          | `potentialFoam -writePhi`                                    |
| Transport/turbulence dictionaries | OpenCFD layout                     | `physicalProperties` + `momentumTransport`                   |
| Force output                      | `coefficient.dat`                  | `forceCoeffs.dat`                                            |
| Field export                      | OpenCFD `foamToVTK` options/output | Foundation legacy VTK with `-useTimeName`                    |

Do not add release conditionals throughout the pipeline. New OpenFOAM releases
must implement a dialect selected by exact identity, declare capabilities, and
pass the same evidence and recovery contract.

## Pinned OpenFOAM runtime sources

### OpenCFD 2606

The executable worker is built from the official runtime-only image
`opencfd/openfoam-run:2606@sha256:4229997e74defb81548222d511b8e3b95b98305e5df41b8e88b031813fe47eeb`.
It contains the packaged applications and libraries needed at runtime; this
repository does not vendor or compile an OpenFOAM source checkout. The image's
embedded build corresponds to the protected official `OpenFOAM-v2606` source
tag at commit `481094fdf34f11ed6d0d603ee59a858a0124236d` in the
[canonical OpenCFD GitLab repository](https://gitlab.com/openfoam/core/openfoam/-/tree/OpenFOAM-v2606).
The former 2406 image digest remains only in decision/provenance records for an
explicit rollback; this repository keeps no 2406 Compose service or executable
dialect. A production 2406 container is removed only by the authorized guarded
cutover and is otherwise left untouched.

### Foundation 14 build and enablement

Foundation 14 was released by the OpenFOAM Foundation on 14 July 2026 and is
GPL-3.0 software. Authoritative references are the
[Foundation release](https://openfoam.org/version/14/),
[Ubuntu package instructions](https://openfoam.org/download/14-ubuntu/), and
[OpenFOAM/OpenFOAM-14 source](https://github.com/OpenFOAM/OpenFOAM-14).

`docker/Dockerfile.worker-foundation14` pins:

- Ubuntu 24.04 multi-architecture base digest
  `sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90`;
- Foundation package version `20260714`;
- amd64 package SHA-256
  `901e23926da833f0515969c563b258639ffbdee7f26270452c3384b3f689d30f`;
- arm64 package SHA-256
  `68ce8b2d20f1cf9eb971f37acdc1e771b658f5ac0cd28056f46e645ffed3a0f2`;
  and
- source release commit `b4f91ad8bbbab628441562fc419f040cc4796f11`.

Package checksums are verified during the image build and the selected checksum
is reported as package provenance by the worker. The optional final-image digest
comes from deployment as `FOUNDATION14_IMAGE_DIGEST`; leave it unknown rather
than substituting the Ubuntu base digest.

Local activation:

```bash
AIRFOILFOAM_ENABLED_ENGINE_KEYS='openfoam:opencfd:2606:numerics-1:adapter-1,openfoam:foundation:14:numerics-1:adapter-1' \
  docker compose --profile foundation14 up --build
```

After the worker is healthy and real canaries pass, enable its database pool
from Admin → Queue → Engine. Production activation uses the same gateway key
plus `COMPOSE_PROFILES=foundation14`, but engine images/services are changed
only through `scripts/deploy/rebuild-engine.sh <build-id>`.

Rollback disables the Foundation database pool first and lets its active and
queued work drain. Existing Foundation evidence remains visible under its exact
identity. Keep the Compose profile configured until guarded maintenance; the
script refuses to leave a running optional worker outside the coordinated
build-id cutover.

## Adding another engine

An engine is not integrated until every item below is complete:

1. Choose its truthful canonical family, implementation/distribution, release,
   method family, method keys, upstream source, and licence. Similar scientific
   foundations do not justify another project's product name.
2. Define typed family-specific setup and validation. Map only genuinely common
   physical inputs through the shared request layer.
3. Register immutable implementation and disabled execution-pool rows.
4. Implement gateway capability discovery, exact request/route handshake,
   worker acknowledgement, cancel/recovery routing, and failure taxonomy.
5. Record exact runtime provenance and a generic evidence bundle with stable
   result IDs, checksums, unavailable-field metadata, and stored default media.
6. Namespace numerical caches and public compatibility by the new logical
   identity and method profile.
7. Validate serial and parallel success, numerical failure, infrastructure
   failure, cancellation, restart/orphan recovery, incremental publication,
   cache reuse/isolation, and evidence ingestion end to end.
8. Keep the execution pool disabled until those canaries and licence/source
   distribution obligations are satisfied. Activation is reversible by routing;
   evidence identity is immutable.

For the planned thesis-derived open-source solver, the implementation begins at
step 1 after its canonical name and initial version are chosen. It is a new
engine integration, not an OpenFOAM dialect and not an MSES compatibility flag.
