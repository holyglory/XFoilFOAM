# D-2026-07-26-fleet-health-telemetry

## Context

Admin Sync displayed `40/40 CPU` for `hz-solver2` even while the worker used
roughly eleven cores and ran eleven CFD jobs. That value was the configured
admission cap, not measured utilization. The same screen showed four zero
`REMOTE ASSETS` counters because it read the legacy
`remote_asset_references` table, while the active architecture sends complete
Zstandard evidence through hub-brokered GCS uploads.

The remote node was online and solving, but its persisted storage-admission
safeguard was active. Existing OpenFOAM jobs continued while new admissions
stopped. The UI could not distinguish that safe throttling from an idle or
broken solver, and Health reported only the production host.

## Decision

Remote solver heartbeats carry a schema-versioned telemetry payload containing:

- sample time and 1/5/15-minute host load normalized by available CPU;
- total/free/used memory;
- persisted storage use, free and required bytes, admission state, reason, and
  check time;
- actual active CFD jobs, reserved CPU slots, configured slot capacity, and
  active AoAs.

The hub validates the payload, merges it into the registered solver's existing
metadata so engine identity is retained, and never exposes the solver
credential. Admin Health combines the latest authenticated report with the
local health sample. Connectivity is derived from heartbeat age; missing or
old reports remain visibly unavailable instead of being filled with zeros.
The hub does not synchronously probe a remote node during a polled Health
request.

Performance is derived from accepted immutable result classifications and
exact fulfilled remote-promise result ownership. The read model returns seven
complete UTC days plus a rolling 24-hour total, split into RANS, preliminary
URANS, and final URANS for the fleet overall and for every producing node.

Admin Sync retains promise and connection controls, but its node card separates
actual reserved slots and jobs from the configured cap. The irrelevant legacy
remote-reference summary is replaced with brokered GCS evidence-transfer counts
and stored bytes by state.

## Alternatives considered

- **Treat the configured cap as utilization:** rejected because it made an
  underutilized or admission-blocked node look saturated.
- **Probe each remote host from Admin Health:** rejected because a frequently
  polled page would wait on network and remote engine availability, violate the
  bounded-observability contract, and require additional secret handling.
- **Keep the legacy remote-assets card and add explanatory text:** rejected
  because zeros were technically correct for an unused storage mechanism but
  conveyed no information about the real GCS delivery path.
- **Show only fleet-wide throughput:** rejected because it cannot identify
  whether production or one remote node is slow.
- **Count every completed solver row as output:** rejected because completed
  evidence can be rejected or superseded; operational output charts use only
  accepted classifications while rejected evidence remains available in its
  forensic surfaces.

## Verification

- API typecheck covers the health schema, heartbeat metadata merge, fleet read
  model, and brokered evidence summary.
- Sweeper typecheck covers node-side telemetry collection and heartbeat
  transmission.
- DB-backed API tests verify authenticated heartbeat storage, preservation of
  engine metadata, structured fleet output, evidence-transfer output, and
  admin authentication.
- Web source regressions assert fleet/throughput content and narrow responsive
  grids; formal browser verification compares Health and Sync at desktop,
  reported, and mobile widths after deployment.
