# D-2026-07-25 — Rejected PRECALC checkpoint broker

## Context

OpenCFD 2606 recovery v8 produced one accepted correction and five rejected
preliminary-URANS attempts with complete restartable local evidence. The
controller correctly refused same-case continuation because its trust gate
requires an exact, complete, generation-pinned GCS archive. The remote transfer
path, however, brokered only accepted results, so those valid checkpoints could
not reach the gate.

## Decision

- Scan only active remote-promise preliminary obligations and select the same
  exact newest rejected checkpoint used by the continuation controller.
- Upload its existing Zstandard bundle through the hub-issued opaque GCS
  resumable capability. The remote node receives no Google credential.
- Require hub verification of the exact generation, compressed and tar
  identities, manifest identity, member count, and every manifest-declared
  member before registering the archive locally.
- Keep the remote promise point active. Checkpoint transfer is evidence
  preservation, not an accepted result or promise fulfillment.
- Permit the mutable result projection to be `failed` when the immutable
  attempt is rejected PRECALC evidence with the continuation marker, exact
  manifest, and verified complete restart archive. A campaign-ingested
  `source=queued` attempt is eligible only when it also carries the exact
  OpenCFD 2606 identity, hard-solver disposition, retained transient
  directory, measured physical progress, and typed budget-stop marker;
  ordinary queued failures and pre-typed continuation wording remain
  ineligible.
- Submit continuation against the same engine job/case. It does not consume a
  new physical solver attempt; its progress and outcome remain separate
  immutable continuation evidence.

## Alternatives excluded

- **Broker only accepted points:** this is the defect; it leaves rejected
  restartable trajectories permanently stranded.
- **Give the remote node GCS credentials:** unnecessary privilege and contrary
  to the credentialless transfer boundary.
- **Relax the verified-archive gate:** a local case path is mutable and is not
  durable proof that every restart member exists.
- **Start a fresh corrective run:** discards useful simulated time, repeats the
  same physical work, and consumes the wrong audit/budget category.
- **Mark the checkpoint fulfilled:** falsely advertises rejected evidence as an
  accepted polar result and closes the work lease before coefficients exist.

## Verification

- Database regression: a `failed` result projection remains ineligible without
  the archive, becomes eligible after exact archive registration, and a
  same-case continuation submission is non-consuming. A generic queued
  projection stays ineligible, while the fully typed OpenCFD 2606
  campaign-ingest projection is covered by the remote transfer regression.
- Remote transfer regression: a rejected checkpoint is broker-uploaded and
  registered, no `/polars` publication occurs, the promise point stays active,
  and idempotent replay performs no second transfer.
- Production proof requires all five retained v8 checkpoints to receive exact
  GCS generations, schedule continuations rather than fresh solves, and produce
  accepted clean-period evidence without recomputing already accepted AoA 13.

## Production progress

The hub has verified and registered all five exact restart archives:

- AoA -1: generation `1784941179744806`, 171,422,501 bytes;
- AoA 0: generation `1784941381258033`, 123,135,403 bytes;
- AoA 1: generation `1784942338014018`, 72,519,548 bytes;
- AoA 7: generation `1784942356463529`, 118,910,639 bytes;
- AoA 9: generation `1784942372870034`, 104,881,113 bytes.

AoA -1 then resumed engine job `73a9a2c2530044a39c7401e091375b45`
from `t=0.154775 s`, built no mesh, retained its four-of-four physical-attempt
count, advanced to `t=0.1614419904740217 s`, and produced accepted no-shedding
evidence. Its accepted force-history window begins at
`t=0.09144199047402168 s`, after the corrupt startup prefix.

That first continuation exposed an admission-scale defect rather than an
evidence-trust defect. Broad promotion discovery embedded the complete archive
and manifest-member trust predicate in two correlated scans; with 3.9 million
remote artifact rows, a single 26-angle promotion query consumed minutes before
reaching the already bounded per-obligation verification phase. Discovery now
finds only due, correctly owned pending points. The exact bounded second phase
still requires an authenticated restart archive for an exhausted obligation or
fresh-attempt budget for an ordinary obligation, so widening discovery cannot
authorize a solve. The complete six-case promotion regression, the
exhausted-checkpoint same-case continuation regression, and sweeper typecheck
pass against a fresh isolated database.
