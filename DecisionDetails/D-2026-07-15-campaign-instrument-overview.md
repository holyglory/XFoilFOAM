# D-2026-07-15-campaign-instrument-overview

## Decision

The campaign-detail first viewport uses the owner-selected instrument-cluster
layout. The exact approved source is the 1297×1212 ImageGen result
`exec-6b5878c5-528d-4ef5-9595-f88e9af540dd.png` (SHA-256
`17e461565fe2cf4f28b49c046c25cc6320f718a711b9b97ddbd9ef075d5cb4a7`).
Campaign identity and lifecycle actions occupy one row. Scheduler and engine
truth fold into one operational ribbon with exactly one title/detail pair and
an action only when the user can actually change the state. A large completion
instrument uses the real settled-point total and requested total; the gauge
itself owns the accessible progress value. The solver ladder is a three-step
RANS → preliminary URANS → verify rail. The only always-visible operational
readouts are processing, automatic mesh repair, and measured trailing-24-hour
throughput with a stage-scoped ETA when stable.

Secondary plan metadata, exceptional evidence, and recovery detail remain in a
small disclosure. The existing condition strip and coverage matrix follow the
instrument instead of competing with it. Ordinary symbols come from the
installed product icon library; the gauge is a real, live data visualization,
not a generic speedometer icon or a bitmap containing sample values. All colors
remain existing Airfoils.Pro tokens.

## Exact visual contract

- The instrument is open on the page background. It has no enclosing card,
  tinted panel, bright selection-like border, or second linear completion bar.
- The dial is an upper semicircle about 1.85 times wider than it is tall. Its
  outer track is a heavy, low-contrast slate stroke with square ends. Inside it
  sits a dense ring of short radial ticks plus longer cardinal ticks. The real
  completed fraction is a cyan arc on that same track with a restrained glow;
  the visual must never exaggerate a small percentage and must have no needle.
- The centered value stack is, in order: large light-cyan tabular count,
  smaller cyan state label, short slate hairline, muted requested total, and
  compact cyan percentage. The stack has generous vertical air and remains
  inside the arc at every supported width.
- One continuous two-pixel rail joins three numbered circular nodes. The
  active node uses a cyan ring and bloom; inactive nodes use nested slate
  rings. Stage names and their real detail counts are centered beneath each
  node. Arrow icons between disconnected stage glyphs are not equivalent.
- Processing, automatic repair, and measured throughput form one unboxed
  three-column row below the rail. Their amber, violet, and cyan outline icons
  precede large white values and muted mono captions. Hairline vertical rules
  separate the columns; ETA sits under throughput. Exceptional counters live
  in the details disclosure rather than growing a second metrics row.
- One faint horizontal rule closes the instrument before the condition
  collection. Desktop proportions preserve the source's large negative space;
  narrow layouts keep the dial, three-node rail, and three readouts legible
  without changing them into a vertical status list.
- The palette is near-black blue (`#061017`–`#09151d`), low-contrast slate
  (`#263441` / `#516170`), mint-cyan (`#55d8c8`), amber (`#ffad16`), violet
  (`#9c6cff`), blue-white primary text, and desaturated blue-gray secondary
  text. Glow is local to active cyan geometry; there is no broad panel glow or
  decorative gradient.

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

## 2026-07-16 correction

The first implementation enlarged Lucide's generic `Gauge` icon (including its
needle), added a separate native progress bar, and replaced the continuous
numbered rail with three icon circles and arrows. The earlier QA compared only
the overall page hierarchy, explicitly skipped a focused instrument crop, and
misclassified those defining substitutions as acceptable. The owner correctly
reported that the result remained far from the approved artifact.

The durable prevention is this exact contract plus a browser regression that
requires one accessible semicircular progress visualization, no separate
visible completion bar or speedometer SVG, a continuous numbered stage rail,
the three operational readouts inside the instrument, and source-like desktop
geometry. Design QA must compare focused source and implementation crops in
addition to the full page; it cannot pass from scale and first-viewport order
alone.
