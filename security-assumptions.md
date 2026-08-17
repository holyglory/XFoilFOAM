# Security assumptions

Confirmed by the owner on 2026-08-03 and superseded in part on 2026-08-05.
The owner explicitly withdrew forensic retention for failed or incomplete
solver generations: those bytes are disposable and a clean recomputation is
preferred to quarantine, repair, or forensic restoration. The canonical
accepted-result boundary remains unchanged.

## Users and operators

- The system has one owner and a small set of trusted administrators in the
  configured `vr.ae` Google OAuth domain.
- Confirmed by the owner on 2026-08-17: the interactive host accounts
  `holyglory`, `holygloryTT`, `axel`, and `slawa` are identities of the same
  trusted owner. They may share read/write/traverse access to the XFoilFOAM
  repository and read/traverse access to that owner's SSH key material. This
  confirmation does not extend access to pseudo-users, service accounts, or
  browser users.
- Administrators are trusted to operate production, the dedicated remote
  solver, and the private evidence bucket. Browser users and public catalog
  readers are not trusted with service credentials or deletion authority.

## Deployment, ownership, and data

- The production VPS, the dedicated `hz-solver2` VPS, and the private Google
  Cloud Storage bucket are owned and controlled by the same owner.
- Production is authoritative for catalog, promise, canonical result, and
  evidence-registration identity. The remote solver is compute-only.
- Solver evidence contains no intended personal data. The integrity,
  provenance, and availability of accepted canonical results remain important.
  Failed, rejected, cancelled, incomplete, or otherwise unpublished
  generations are disposable working data; they must not be relabelled as a
  valid result and must not consume durable solver capacity.

## Credible threats and trust boundaries

- Credible failures are accidental deletion of accepted canonical evidence,
  replayed or stale messages, competing job generations, identity mix-ups,
  and unauthorized Internet callers reaching a service route.
- The production control plane and its attached Google workload identity form
  the GCS write/verification boundary. The remote solver must remain without
  GCS credentials.
- Remote-to-production preservation calls cross a service boundary and require
  the existing server-side shared-secret/HMAC authentication. Secrets remain
  server-side and are never returned to a browser.

## Required gates

- Accepted canonical evidence remains locally retained until production
  verifies its exact generation-pinned GCS object and returns the existing
  canonical acknowledgement. This requirement does not extend to an
  unpublished failed generation.
- Automatic failed-generation cleanup must use exact job ownership and must
  refuse any generation selected by, or supplying, an accepted canonical
  result. It removes the failed generation's result/attempt/artifact/media and
  raw working files, then returns the exact physical point to normal clean
  scheduling.
- A stale or competing identity cannot create a result, polar point, or
  deletion authority for accepted evidence. Minimal operational failure state
  may remain for retry visibility, but raw forensic bytes do not.
- Admin API pre-handlers, Google OAuth domain enforcement, server-side secret
  storage, immutable evidence rows, and existing deployment/maintenance guards
  remain in force.

## Explicitly unnecessary gates

- The remote solver does not receive a service-account key, bucket credential,
  or direct canonical GCS authority.
- Failed/incomplete generations do not need a forensic package, quarantine
  upload, full-member restore, terminal HMAC receipt, or permanent raw-byte
  retention. The terminal-forensic broker is removed rather than exposed.
- No new third-party operator, multi-tenant trust model, or public deletion
  control is required for this single-owner deployment.

## Accepted operational risk

- The owner accepts that deleting an unpublished failed generation removes its
  detailed post-mortem bytes and that a replacement solve may consume more CPU.
  Keeping both solver pools available for useful recomputation takes priority
  over forensic retention.
- A failed point may be recomputed repeatedly as a new generation; an accepted
  canonical result must never be deleted by that cleanup.

## Review triggers

Reconfirm these assumptions before changing authentication, secret ownership,
GCS authority, accepted-result acknowledgement, accepted-evidence deletion
gates, public exposure, or trust boundaries; when adding operators, tenants,
cloud accounts, or remote solver owners; or after a credential compromise or
accepted-evidence integrity incident.
