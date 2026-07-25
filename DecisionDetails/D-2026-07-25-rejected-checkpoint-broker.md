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
  attempt is solved/rejected PRECALC evidence with the continuation marker,
  exact manifest, and verified complete restart archive.
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
  same-case continuation submission is non-consuming.
- Remote transfer regression: a rejected checkpoint is broker-uploaded and
  registered, no `/polars` publication occurs, the promise point stays active,
  and idempotent replay performs no second transfer.
- Production proof requires all five retained v8 checkpoints to receive exact
  GCS generations, schedule continuations rather than fresh solves, and produce
  accepted clean-period evidence without recomputing already accepted AoA 13.
