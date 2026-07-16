# Campaign Instrument Overview — Design QA

- Approved visual truth:
  `/home/holyglory/.codex/generated_images/019f4e05-4836-7353-8c27-788fc23f86be/exec-6b5878c5-528d-4ef5-9595-f88e9af540dd.png`
  (1297×1212, SHA-256
  `17e461565fe2cf4f28b49c046c25cc6320f718a711b9b97ddbd9ef075d5cb4a7`).
- Desktop implementation:
  `/home/holyglory/XFoilFOAM/.codex-artifacts/design-qa/campaign-detail-desktop-full-v2.png`.
- Focused desktop instrument:
  `/home/holyglory/XFoilFOAM/.codex-artifacts/design-qa/campaign-instrument-desktop-v2.png`.
- Narrow implementation:
  `/home/holyglory/XFoilFOAM/.codex-artifacts/design-qa/campaign-detail-narrow-full.png`.
- Compared route:
  `http://127.0.0.1:3005/admin?campaign=2a285ca0-da43-4e13-bc6f-f637ac2a1f3b`.
- Compared states: 1297×1212 and 390×844, dark theme; light-theme
  redraw and the Campaign details interaction were also exercised.
- The full-page PNGs are taller than those viewport dimensions because they
  include content below the fold; the focused instrument PNG is the parity
  crop used for component comparison.

## Correction and prevention

The 2026-07-16 production annotation correctly reopened the previous pass. The
first implementation had enlarged Lucide's speedometer glyph, including its
needle, added a separate linear progress bar, used disconnected icon stages
with arrows, and placed the operational metrics outside the instrument. The
previous QA checked only page-level hierarchy and therefore missed the primary
artifact's defining geometry.

The prevention layer is now the exact decision contract, focused source-versus-
implementation comparison, pure dial-geometry tests, and a browser regression
that checks desktop and narrow layout. The browser test explicitly requires one
accessible dial, no speedometer needle or second completion bar, one aligned
numbered connector, exactly three primary readouts, and no narrow-page overflow.

## Same-input comparison result

The approved 1297×1212 source and the 1297-wide implementation were opened
together in one visual comparison input. The corrected implementation preserves
the source's open composition and defining dimensions:

- The dial is a 535×277 live canvas whose visible track spans approximately
  533 px, matching the source's measured 533×276 semicircle. It has a heavy
  square-ended slate track, 60 short calibration intervals, five longer
  cardinal ticks, a local cyan progress bloom, and no needle.
- The centered IBM Plex Mono stack retains the source order and hierarchy:
  complete count, state label, hairline, requested total, and percentage.
- A roughly 1010 px rail places three 56 px numbered nodes on one continuous
  two-pixel connector. The active node has a local cyan ring/bloom; inactive
  nodes have nested slate rings. Stage names and real details stay centered.
- Processing, automatic repair, and measured throughput form the source-like
  three-column unboxed row inside the instrument. Amber, violet, and cyan
  Lucide outline icons precede the live values, with hairline separators and
  stage-scoped ETA only when measured data exists.
- One subdued horizontal rule closes the instrument. Exceptional counts and
  their real actions live behind Campaign details rather than creating a
  second metric row.

The generated source visually exaggerates its cyan arc: the pictured arc is
far larger than the printed 0.16%. Production deliberately renders the exact
stored fraction instead of copying that false extent. This is a truthfulness
correction, not a fidelity regression.

## Mandatory fidelity passes

- Typography: IBM Plex Sans/Mono are retained. Count, stage, metric, and caption
  hierarchy now match the source; text stays readable and contained at 390 px.
- Spacing and layout: status-to-dial, dial-to-rail, rail-to-metrics, and final
  rule rhythm match the source. The hero has no enclosing card, tint, bright
  border, broad glow, or duplicate progress line.
- Colors and tokens: existing Airfoils.Pro slate, teal, amber, violet, text,
  and rule tokens map to the source. Glow is local to active cyan geometry.
- Icons: status and metrics use the installed Lucide family. The dial itself is
  live data visualization rather than a generic icon or sample-value bitmap.
- Copy and content: every number and state comes from the campaign payload.
  Throughput remains a trailing-24-hour average and unavailable throughput is
  an honest dash.
- Responsiveness: the 390 px view retains the horizontal dial, three-node rail,
  and three-column metrics. Browser measurement found zero document and hero
  horizontal overflow; no text, nodes, or readouts overlap.
- Accessibility and interactions: the dial exposes one progressbar with min,
  max, current value, and descriptive value text. Stages are an ordered list
  with exactly one current step. Campaign details owns `aria-controls`, expands
  to the real panel, and has a visible keyboard-focus rule. Canvas theme redraw
  was measured from dark track pixel `[36,49,64]` to light `[205,215,227]`.

## Findings

- No open P0, P1, or P2 findings in the corrected instrument.
- Accepted P3: the real product's admin navigation column is narrower than the
  concept image. The established global shell remains out of scope and does not
  change instrument hierarchy.
- Accepted state difference: the isolated fixture truthfully shows Solver
  unavailable and zero solved work, while the source depicts a capacity
  safeguard and populated work. Styling and geometry were compared independently
  of those real state/data differences.

## Verification evidence

- Focused gauge geometry: 6 tests passed, covering 0%, production-scale 0.16%,
  50%, 100%, lower/upper clamping, and zero-total behavior.
- Campaign pipeline + dial unit scope: 23 tests passed.
- Browser geometry contract: passed at 1297×1212 and 390×844 against an isolated,
  fully migrated database. Its test-only response override renders the source-
  scale 1,010-of-631,410 state and confirms that a small, nonblank cyan core is
  painted without expanding beyond the guarded pixel budget; no synthetic
  value enters runtime behavior.
- Formal browser-side geometry report:
  `/tmp/campaign-instrument-formal-ui-final.{json,md}` — 2 pages checked, 0 skipped,
  0 critical findings, coverage gate passed. Warnings are translucent-background
  contrast coverage gaps plus pre-existing low-contrast coverage-table labels;
  none reports instrument clipping, overlap, off-canvas content, broken media,
  or document overflow.
- Theme redraw, details disclosure, page errors, and exact-route rendering were
  exercised through browser automation. No application page error was reported.

final result: passed
