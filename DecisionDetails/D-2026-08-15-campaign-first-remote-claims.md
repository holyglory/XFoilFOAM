# D-2026-08-15 — Campaign-first remote claims

## Decision

The authoritative hub leases eligible active-campaign gaps before global
enabled-preset backfill. A campaign lease keeps the exact current-generation
airfoil, immutable setup revision, requested physical AoA, and campaign
priority. Existing live-promise serialization, same-solver terminal
exclusions, and registered-solver promise caps still apply.

When no campaign cell is claimable, the existing latest-enabled-preset catalog
scan remains available as a lower-priority capacity filler.

## Why

On 2026-08-15 the hub and hz-solver2 workers were fully occupied at 8 and 64
jobs respectively, but all 1,667 active remote promise points used revision 3
of one enabled preset. The active campaign was pinned to revision 2 across its
current-generation conditions, so the promise set had zero exact campaign
matches and could not advance campaign ingestion.

Repinning an existing campaign to the latest mutable preset would break its
immutable request contract. Crediting results across revision IDs merely
because current values appear similar would weaken provenance and could merge
future numerical differences. Leaving remote backfill ahead of campaign work
would continue wasting the dedicated capacity from the campaign's perspective.

## Verification

- Claim regressions create a newer globally enabled revision beside an active
  campaign's older pin and require the returned promise to use the campaign
  revision.
- Production verification compares every newly issued promise point with the
  active campaign's current-generation cell identity before declaring remote
  campaign service restored.
- The global fallback remains covered by the existing sync claim tests and is
  exercised only when the campaign query returns no eligible row.
