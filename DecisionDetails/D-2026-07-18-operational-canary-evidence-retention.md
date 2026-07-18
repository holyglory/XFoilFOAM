# Preserve OpenCFD 2606 cutover canaries as operational evidence

## Production identity

The protected 2026-07-18 reconciliation inventories agree on 16 exact
content-addressed `tar.zst` generations totaling 216,240,757 bytes across 11
completed OpenCFD 2606 engine-job directories. Every local remote pointer
matches the archive SHA-256 and size, and each job's `status.json` independently
pins the OpenCFD distribution/version, runtime build, source revision, image,
application, package, binary, and architecture identities. Database
reconciliation finds zero `sim_jobs` and zero result/attempt ownership for all
11 jobs.

Four r5 generations across three jobs are exact members of durable canary
attestation `112f52cd-eb8b-4908-bc79-6353daea6e12`. The exact retained raw
production receipt is pinned to SHA-256
`505819f2c745425071cc7900967abaead0911f30ab6af1636a8af92baf7276e8`
and 2,313,736 bytes. Its independently normalized database-semantic canonical
JSON is pinned to SHA-256
`f6d17988ea40e96c885df709357806a097daa19948d8b02efc6df25e035f6149`
and a measured size of 2,211,018 bytes. The exact 16-member repository
allowlist has canonical content seal
`1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b`;
both the Python generator and database registration reject any wider or
altered set. The other twelve are cutover canaries created by three failed
pre-attestation rollout passes:

- r2 `prod-20260717-63385777be73-r2`: queue-probe/same-build replay, exit 14;
- r3 `prod-20260717-cd0967a1ba4e-r3`: retention retry, exit 14; and
- r4 `prod-20260717-2ab861cb4ce6-r4`: transient retention, exit 137.

Their source-build, source-journal, and operator-receipt bytes are retained in
the protected audit set and addressed by exact SHA-256 and size. An unattested
claim is invalid if any protected proof is missing or if the build/failure pair
is outside this closed allowlist.

## Ownership and retention contract

Migration 0081 adds an append-only operational ownership ledger with two
explicit provenance classes: `attested_canary` and
`unattested_cutover_canary`. Registration independently recomputes the
canonical claim digest, matches one exact OpenCFD 2606 runtime and, for the
attested class, one exact attestation artifact. It rejects any existing or
concurrent owner through `sim_jobs`, results, result attempts, evidence blobs,
artifacts, brokered uploads, quarantine/cleanup reservations, or a conflicting
operational claim. Exact GCS and engine-job advisory locks are reciprocal with
the 0079 cleanup and 0080 broker paths, so a delayed ingest cannot race the
zero-owner check.

The ledger has no result, attempt, AoA, coefficient, campaign, or polar fields
and is not read by aerodynamic result surfaces. The 16 generations therefore
remain operational proof, not solver results.

Local reclamation is a separate idempotent phase. It requires the exact
database ownership acknowledgement and then freshly downloads the pinned GCS
generation, authenticates its stored and uncompressed-tar identities, checks
the embedded manifest, and restores every declared member. Only then may it
remove the closed allowlist of local archive/raw paths. A create-only, fsynced
intent makes a crash before or between removals resumable; a create-only local
receipt and append-only database receipt conserve the exact outcome. The tool
has no GCS delete or prefix operation, and dry-run is the default.

## Verification

The focused fifteen-test Python suite authenticates the exact retained r5
receipt bytes before generation, rejects missing, changed, truncated,
whitespace-altered, non-finite, semantically mismatched, hash-swapped, and
different receipts, and positively exercises the complete generator with a
realistically formatted synthetic raw receipt containing integral floats. The
test proves that raw and database-semantic identities remain independent and
cannot masquerade as production. It also covers exact-membership claim validation,
attested and unattested claims, missing audit proof, contradictory/widened
object identity, corrupt archives and members, wrong database
acknowledgement, repeated execution, interrupted local reclamation, and the
requirement that a fresh generation-pinned all-member restore precede every
deletion and replay.

The isolated 34-test PostgreSQL suite applies the complete migration chain and
proves exact 16/11/216,240,757 conservation, idempotent registration,
recomputed row-seal and honest attestation-receipt enforcement, retention
receipt validation/immutability/idempotent replay, direct reciprocal exclusion
for blob, artifact, cleanup-reservation, broker, `sim_jobs`, results, result
attempts, and artifact engine-job owners, and both concurrent transaction
orders for every GCS and engine-job owner class. Database and sweeper type
checks cover the schema and service/CLI.
