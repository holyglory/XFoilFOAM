# Disposable failed solver generations

## Decision

Accepted canonical solver evidence keeps its existing immutable,
generation-pinned GCS delivery and acknowledgement boundary. A failed,
rejected, cancelled, incomplete, or otherwise unpublished solver generation is
different: it is disposable working data, not a scientific archive.

When such a generation cannot be resumed through a clear, already-supported
continuation, the system removes its noncanonical result, result-attempt,
artifact, media, and raw engine working data and returns the exact physical
point to the normal scheduler as a clean replacement generation. Cleanup must
prove that the generation does not supply an accepted canonical selection and
must not widen from one failed job to another result or physical cell. A small
operational failure event may remain so repeated causes are visible, but no raw
forensic package, quarantine object, terminal-evidence broker upload, or
forensic deletion receipt is retained.

The dedicated remote solver remains compute-only and GCS-credentialless.
Normal accepted-result uploads continue through production. Failed-generation
cleanup is automatic and must not fence unrelated work or leave configured CPU
capacity idle behind retained debris.

This decision supersedes
`D-2026-07-18-incomplete-evidence-quarantine` and
`D-2026-08-03-terminal-evidence-receipt-boundary` for failed and incomplete
generations. It does not weaken accepted canonical evidence retention.

## Why

The forensic design retained hundreds of gigabytes of terminal directories,
filled the 3.3 TiB remote volume, stopped PostgreSQL and scheduling, and left
the compute fleet idle while increasingly complex packaging, staging,
verification, and receipt recovery was developed. Those bytes are
reproducible CFD working data; recomputing the point is simpler and more useful
than permanently diagnosing or transporting every failed generation.

Keeping all failed bytes, compacting them into forensic bundles, or granting
the remote solver GCS authority were rejected. The selected lifecycle keeps the
important boundary—accepted results remain protected—while making failure
recovery local, bounded, and operationally obvious.

## Verification and operation

Tests must prove that cleanup refuses accepted canonical evidence, deletes the
complete noncanonical failed-generation graph, creates no polar point, and
requeues exactly the same physical point as a fresh generation. Production
cleanup begins only after a verified database backup. Deployment preserves
active OpenFOAM processes, removes obsolete forensic routes/tables/queues, and
then verifies both solver pools with real child processes, progress, and CPU
use rather than configured-slot labels alone.
