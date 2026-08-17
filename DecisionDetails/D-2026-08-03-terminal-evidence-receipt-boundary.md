# Terminal-evidence receipt boundary

> Superseded on 2026-08-05 by
> [D-2026-08-05-disposable-failed-generations](D-2026-08-05-disposable-failed-generations.md).
> This file records the rejected historical design; it is not the current
> failed-job lifecycle.

## Decision

Result-less failed or cancelled remote solver jobs are preserved through a
distinct production-brokered forensic path. The credentialless remote solver
creates a deterministic lossless tar.zst and keeps the original job directory.
Because the results volume may already be full, it stages at most one archive
at a time on an explicitly configured, separately mounted persistent filesystem
with a conservative residual-space floor. A complete package already staged
for one job owns that staging lane until its receipt/reclaim transaction settles;
another job cannot accumulate a second archive beside it.
Production owns the private GCS upload session, verifies the exact object
generation and every declared archive member, records an immutable quarantine
without creating aerodynamic evidence, and returns an HMAC-signed receipt.
Only the exact remote job named by that receipt may be reclaimed, after a local
archive re-hash. Reclaim deletes the named source first and its duplicate stage
only afterward, so a crash retains at least one exact copy and retries remain
idempotent.

On 2026-08-05, this boundary was extended with a separately discriminated
`evidence_only_forensic` receipt for one explicitly named result-bearing
terminal job. It may run only through the one-job pilot command and only when
the job's direct result or result-attempt owns the exact airfoil, immutable
setup revision, and AoA of a still-unfulfilled promise point. The evidence row
may be `done` or `failed`; a fully fulfilled history never qualifies, and a
cancelled point need not carry a result id. The normal terminal queue cannot
discover it. A trusted, authenticated remote operator names the one exact
pilot target; this is deliberately not a new token/authorization subsystem and
is never exposed through browser or tick-based selection. Production still
verifies and signs the exact GCS generation; remote reclaim rechecks the
eligibility gate after signing and leaves results, result attempts,
classifications, promise points, artifacts, and canonical selection untouched.
Fully fulfilled jobs, active descendants, and jobs with a pending canonical
reclaim receipt remain ineligible.

The boundary follows the project-specific assumptions in
[`security-assumptions.md`](../security-assumptions.md): one owner and trusted
`vr.ae` administrators, production as canonical authority, user-owned private
infrastructure, no GCS credentials on the remote solver, and service-only HMAC
authentication. Missing or competing proof fails closed.

## Why

Keeping every terminal job indefinitely filled the 3.3 TiB remote volume and
idled configured compute. Deleting result-less jobs directly was rejected
because no accepted-result receipt protected their forensic bytes. Granting
the remote node GCS credentials was rejected because it widens canonical
storage authority. Reusing accepted-result tables was rejected because it
would invent result ownership. Building the archive beside the source was also
rejected: once that filesystem reached capacity it could not produce the first
receipt needed to free itself. A separate single-flight stage on the existing
host root filesystem is reversible deployment plumbing, not canonical storage;
it conserves the exact incident, preserves production authority, and gives the
remote solver a bounded deletion proof without weakening canonical evidence
semantics or creating a second unbounded retained corpus.

The later result-bearing pressure could not use the original result-less path
because its reciprocal ownership fences correctly reject it. Broadening the
normal retention queue would risk reclaiming successful or live solver work,
while manual filesystem cleanup would lack production proof. The explicit
one-job protocol, gated by a direct exact still-unfulfilled physical cell,
retains the generation-pinned guarantee and is reversible: disabling its pilot
leaves all other terminal behavior unchanged.

## Verification and operation

The implementation must prove deterministic packaging, unsafe-path and
truncation rejection, full manifest/member verification, exact GCS generation
and checksum binding, immutable receipt identity, result/result-attempt race
fences, retry-safe outboxes, and idempotent reclaim. Production and remote
control planes use one sealed source identity. Engine endpoints are installed
only through source-pinned guarded idle-window rebuilds. A smallest-job canary
must pass upload, full restore verification, receipt validation, local re-hash,
source-filesystem byte recovery, and exact source/stage deletion before backlog
reclaim is widened. Capacity tests must prove a foreign staged job prevents a
second package, insufficient stage space and ENOSPC retain the complete source,
and a response loss after either deletion step converges safely.
