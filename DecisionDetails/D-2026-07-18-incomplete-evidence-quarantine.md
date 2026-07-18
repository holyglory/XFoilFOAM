# D-2026-07-18-incomplete-evidence-quarantine

## Context

The protected production corpus scan found one terminal AG26 `a19` evidence
directory whose manifest and database map it to AoA 14°, not 19°. Its local
gzip packaging is incomplete/corrupt. Its existence is not proof of a
restorable solver archive: a present filename and sidecar manifest cannot
establish that the compressed stream reaches its end or that every bundled
member matches the manifest. A full retention pass must not delete the live
mesh and case state first and discover afterward that the only purported
archive was truncated.

This case is materially different from complete terminal evidence that lacks a
canonical result owner. The existing orphan-evidence quarantine preserves a
complete, authenticated solver archive without inventing result ownership.
Partial packaging cannot satisfy that contract and cannot be made complete by
changing its historical description.

## Decision

Full retention preflights the entire job before its first deletion. For every
evidence directory that has a sidecar manifest and one or more local gzip or
Zstandard archive candidates, at least one exact candidate must stream to
end-of-file and authenticate every non-excluded manifest member. Every archive
counted as protective proof must pass that check. If any applicable directory
has no valid candidate, retention refuses the full strip and preserves the
shared mesh, live solver state, compressed sources, and unpacked raw evidence.
Case-state-preserving retention remains a distinct weaker operation.

An incomplete or corrupt terminal package enters a separate immutable,
blob-only forensic quarantine. Its tar.zst is a lossless outer envelope around
the exact blobs, not a replacement canonical evidence bundle: the original
gzip and raw bytes remain unchanged rather than being transcoded, normalized,
or repacked. The quarantine stores an immutable conservation record containing:

- the exact source job/case/evidence path and terminal observation;
- hashes and byte sizes for the original manifest, compressed archive, and
  each retained raw blob;
- the manifest-declared member set partitioned into exact original-retained,
  exact sibling-derived, and missing members, plus any retained bytes not
  declared by the manifest; a sibling-derived member is allowed only when its
  byte size and digest exactly match the declaration, with its sibling source
  and derivation provenance retained;
- the immutable GCS object key, generation, stored size, checksum, and content
  digest for the lossless outer envelope, plus size/digest identity for every
  contained forensic blob; and
- the database acknowledgement that binds that exact object generation and
  conservation record to the forensic quarantine without creating a result,
  result attempt, artifact, fitted polar, or renderable evidence association.

Reciprocal database guards make that separation durable after registration:
future artifact rows cannot claim the quarantined job/evidence path, and
canonical archives or complete-evidence orphan quarantines cannot claim its
physical blob. Sibling-angle evidence under the same outer engine case remains
independent and valid.

Local incident bytes may be removed only after that acknowledgement exists and
a fresh generation-pinned restore has streamed the outer envelope and
authenticated every contained blob against its recorded size and digest.
Missing members remain explicitly missing; no placeholder, estimate, or
invented bytes are allowed.
An exact sibling-derived byte-identical member remains labeled with that
provenance and is never misrepresented as an original retained byte. A future
corrective rerun creates an independent canonical solver generation and does
not mutate, supersede, or retroactively complete the forensic quarantine.

This decision extends D-2026-07-15-gcs-zstd-evidence. Its complete-evidence
orphan quarantine remains unchanged and must not accept partial packaging.

## Why

Shrinking the manifest to the files that happened to survive, or repacking
those files into a fresh archive, was rejected because it rewrites the incident
and makes an incomplete result appear complete. It also destroys the exact
bytes needed to reproduce the packaging failure. The selected outer tar.zst
does not violate this rule because it merely transports the byte-identical
original blobs and conservation metadata; it is never accepted as canonical
solver evidence.

Widening the complete orphan-evidence table was rejected because that table's
meaning is a complete authenticated solver archive with unknown canonical
result ownership. Allowing partial material into it would weaken every consumer
and make an “orphan” ambiguous between valid evidence and forensic debris.

Rerunning the point without preserving the incident was rejected because a
rerun can produce new aerodynamic evidence but cannot reproduce the exact
truncated stream or explain which historical bytes were retained or lost. The
selected separation permits recovery through a new result while conserving the
failure evidence needed to diagnose and prevent recurrence.
