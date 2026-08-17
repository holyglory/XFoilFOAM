# D-2026-08-05 — Role-aware remote disk admission

## Evidence

After the first verified terminal-evidence receipt/reclaim canary, the
`hz-solver2` results filesystem reported 95.9% used with 137.3 GiB available.
The universal 95% percentage gate denied new work before the established
absolute reserve calculation could decide whether the active workload and next
job were safe. The remote results filesystem is about 3.3 TiB and deliberately
retains immutable evidence until the production/GCS acknowledgement arrives.

The original 95% limit remains appropriate for the much smaller production hub,
where percentage headroom materially protects PostgreSQL and Docker from the
2026-07-15 full-disk incident. On the remote node it withholds about 165 GiB at
the same threshold, even though the existing 20 GiB system floor and
fidelity-specific reserve already account for actual future CFD growth.

## Decision

Use the deployment-owned `AIRFOILFOAM_DEPLOYMENT_ROLE` in the sweeper process.
An exact `remote-solver` role receives a 99% emergency ceiling; the default,
unset, or malformed role remains the production hub at 95%. Every role still
requires:

- a valid direct filesystem measurement;
- a 20 GiB system floor;
- conservative remaining-work reserve by RANS/FAST/FINAL fidelity; and
- a 24 GiB next-job reserve (or the existing malformed-job fallback).

The remote setting is deliberately an emergency percentage backstop, not a
substitute for the absolute reserve. It does not modify evidence retention,
broker verification, HMAC receipts, or reclaim authority.

## Alternatives considered

1. Keep one 95% ceiling everywhere. Rejected: it is the direct cause of
   stranded remote capacity and prevents its configured solver slots from
   refilling despite safe absolute headroom.
2. Remove the percentage gate. Rejected: an unforeseen disk-growth path or
   bad exposure classification could again permit a full filesystem.
3. Lower the remote system or per-job reserve. Rejected: this weakens the
   safety model and does not address why a large-volume role was treated as a
   small hub volume.
4. Use a dedicated remote 99% emergency ceiling plus the unchanged absolute
   reserve. Selected: it is role-specific, opt-in, reversible, and preserves
   the existing evidence contract.

## Verification

The focused regression proves that an explicit remote node at 95.9% use with
137.3 GiB free admits only when its 44 GiB no-active-work floor is met; 43.9
GiB free remains blocked and 99% use remains blocked. It also proves hub and
malformed role inputs retain the 95% limit, and that Compose passes the
deployment-owned role only to the sweeper that makes the admission decision.
