# D-2026-07-15-multi-engine-identity

## Context

The existing engine, request schema, case builder, cache, evidence bundle,
control-plane setup snapshot, and public-polar compatibility model assume the
OpenCFD `openfoam-default:2406` distribution. The owner wants multiple solver
engines, approved engine family and version as first-class identity, requested
OpenFOAM Foundation 14 now, and explicitly excluded XFoil from this delivery.
The owner is separately implementing an open-source solver from Drela's thesis;
it is not the proprietary MSES implementation and will receive its own name,
release lineage, numerical-method identity, and validation record.

## Decision

An immutable numerical implementation identity contains:

- engine family;
- implementation/distribution;
- upstream release;
- explicit numerics revision.

The request/runtime handshake additionally carries an adapter contract version.
A resolved execution provenance records that contract version, the source
revision, application build id, deterministic adapter/application source
SHA-256, binary or package checksum when available, OCI image digest when
available, and architecture. At least one content digest is mandatory for new
runtime acknowledgements; build labels alone are not provenance, while legacy
evidence without a trustworthy acknowledgement keeps null provenance. Only the numerical identity
participates in setup compatibility and numerical cache namespaces. Runtime
provenance is attached to the job, attempt, result payload, and evidence
manifest; a wire-schema or packaging-only rebuild does not split a public polar
unless its numerics revision changes.

The current OpenCFD 2406 behavior is first extracted behind an OpenFOAM dialect
without numerical changes. Foundation 14 is implemented as a second dialect
and isolated worker queue/image. Requests carry the expected numerical identity
and workers reject mismatches before starting solver work. Existing records are
not rewritten with provenance that cannot be proven; unknown historical runtime
details remain unknown.

Common setup is limited to geometry, physical state, reference geometry, and
requested sweep. OpenFOAM-specific mesh and solver profiles remain typed.
Future engines add typed method/discretization profiles and capability-gated
evidence rather than nullable fields in one universal table. Execution pools,
CPU/license capacity, secrets, and output policy remain operational domains and
do not become part of physical compatibility.

## Alternatives

- Replacing `opencfd/openfoam-default:2406` with Foundation 14 was rejected:
  Foundation and OpenCFD use different dictionaries, commands, force output,
  and field export, and an in-place replacement would risk active solves and
  remove the proven rollback path.
- A single `openfoamVersion` field was rejected because `2406` and `14` belong
  to divergent distributions and do not identify the implementation or wrapper
  numerics.
- A generic JSON settings blob was rejected as the live source of truth because
  it weakens validation, hashing, migrations, and ownership boundaries. A
  discriminated wire snapshot may contain typed family payloads, while canonical
  reusable profiles remain typed.
- Naming the owner's thesis-derived solver `MSES` was rejected because shared
  published foundations do not establish binary, numerical, validation, or
  licensing equivalence with Drela's implementation.

## OpenFOAM 14 evidence

The authoritative source is the Foundation repository and fixed `version-14`
release line: <https://github.com/OpenFOAM/OpenFOAM-14>. Version 14 was released
on 2026-07-14: <https://openfoam.org/version/14/>. The official Ubuntu package
is documented at <https://openfoam.org/download/14-ubuntu/>. Foundation 14 uses
the modular `foamRun -solver incompressibleFluid` execution path, Foundation
dictionary layout, case-sensitive `potentialFoam -writePhi`, `forceCoeffs.dat`,
and legacy VTK output. These differences are implemented in a dedicated
dialect and verified with real serial and MPI canaries before enablement.

On 2026-07-15, the checksum-pinned amd64 Foundation 14 image built from the
official `openfoam14_20260714` package passed both a serial NACA0012 RANS run
and a two-rank MPI run. The MPI run exercised `decomposePar`, Pstream with two
processes, and `reconstructPar`; it produced `forceCoeffs.dat`, preserved the
resolved engine/runtime metadata and generic evidence bundle, and exported a
1,197,953-byte legacy VTK field file discovered through the application path.
The non-integration Python suite passed 530 tests (one skipped), including the
adapter, routing, cache isolation, shared CPU-token, cancellation, and orphan
recovery contracts. A real Foundation URANS canary and arm64 execution remain
open rollout evidence and are tracked in `CompletionLedger.md`.

## Rollout and rollback

Schema changes are additive. Legacy reads and the OpenCFD default queue remain
available while exact identity is dual-written. Foundation 14 is opt-in until
real RANS/URANS, mesh reuse, force parsing, y+, field export, media, partial
publication, cancellation, and recovery tests pass. Production engine services
are rebuilt only through the guarded maintenance script after the active worker
is idle. Rollback selects the OpenCFD implementation; immutable evidence is
never reclassified as having run on a different engine.
