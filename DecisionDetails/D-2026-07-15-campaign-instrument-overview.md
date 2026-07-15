# D-2026-07-15-campaign-instrument-overview

## Decision

The campaign-detail first viewport uses the owner-selected instrument-cluster
layout. Campaign identity and lifecycle actions occupy one row. Scheduler and
engine truth fold into one operational ribbon with exactly one title/detail
pair and an action only when the user can actually change the state. A large
completion instrument uses the real settled-point total and requested total;
the native progress element owns its accessible value. The solver ladder is a
three-step RANS → preliminary URANS → verify rail. The only always-visible
operational readouts are processing, automatic mesh repair, and measured
trailing-24-hour throughput with a stage-scoped ETA when stable.

Secondary plan metadata, exceptional evidence, and recovery detail remain in a
small disclosure. The existing condition strip and coverage matrix follow the
instrument instead of competing with it. New symbols come from the installed
Lucide library, and all colors remain existing Airfoils.Pro tokens.

## Why

The former layout rendered the same campaign state as a gate badge, lifecycle
badge, phase badge, sentence, three bordered pipeline cards, a segmented count
bar, and a second count line. It exposed implementation vocabulary and made the
owner ask which status was authoritative.

Three materially distinct redesigns were explored. The compact command-summary
direction reduced height but still made text the primary artifact. The flow
direction explained scheduling well but centered internal pipeline mechanics.
The instrument-cluster direction centered user progress, kept recovery and
throughput visible, and used the strongest visual hierarchy with the least
badge/card noise. The owner explicitly selected the third direction.

The implementation preserves truthful exceptions: storage pressure is an
automatic capacity safeguard, a disabled sweeper exposes the real Enable
scheduling action, process/engine failure stays a red unavailable state, and
machine-blocked evidence remains reachable without being framed as a required
user setup change. Throughput is derived as a 24-hour hourly average rather
than relabeling the raw 24-hour count.

Verification compares the selected 1296×1180 source and rendered implementation
in one visual input and records the iteration in `design-qa.md`. Responsive
594×998 rendering has no horizontal document overflow; deterministic geometry
verification reports zero critical findings.
