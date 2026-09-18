# Condition-aware public catalog and comparison

## Selected visual truth

- Catalog: ImageGen option 1, `/home/holyglory/.codex/generated_images/01a071ac-05d2-7020-b150-b053fb2c8c67/exec-666316f8-081e-4100-ab22-4ab2a2a1eab1.png`.
- Comparison: ImageGen option 3, `/home/holyglory/.codex/generated_images/01a071ac-05d2-7020-b150-b053fb2c8c67/exec-f835058b-8197-47de-aaa3-87851d9e3ef4.png`.
- Confirmed selection: Coordinator decision `n2b7087f1adb21b37`.

The 1536×1024 concept boards include desktop/mobile frames and illustrative
numbers. Review compares the app-owned content hierarchy, not those frames,
invented coefficients or profile counts. The production design system and both
existing themes remain in use. Scientific geometry and curves come from stored
data; they are not generated bitmap assets.

## Rendered evidence

Run `t20260918T210336Z-b53597` captures initial and full-page images under
`.devcoordinator/test/logs/runs/t20260918T210336Z-b53597/checks/layout/check/evidence/screenshots/`.
The reviewed CSS viewports are 1440×1000, 688×1118 and 390×844, at device scale 1.
Initial screenshots have those pixel dimensions. Full Detail pages extend to
2404, 3219 and 3264 pixels in height; downscaled overview images were not used to
judge small text. Initial captures supply the readable chart/control evidence.
Native input values are masked by the formal verifier; separate browser
interaction assertions verify the actual values.

The catalog's first six initial/full-page pairs are byte-identical to the
already-inspected `t20260918T205431Z-d86825` captures. Changed comparison pairs
and all Detail pairs were inspected from the newer run. Inspection covers
full-view hierarchy and the focused metric, condition, chart-axis and mobile
profile-switching regions.

## Findings and iterations

- Earlier catalog headers and method labels had inadequate contrast. Updated
  theme-aware text colors pass the rendered contrast checks.
- Earlier narrow condition controls clipped option text. Compact speed/chord
  labels and category-label collapse remove the clipping without shrinking
  controls or exposing physical-identity hashes.
- The first comparison layout repeated profile chips and tabs on mobile,
  pushing part of the chart below the viewport. The repeated chips are now
  hidden only where tabs own selection; removal remains on the active card.
  The 390×844 captures show the whole primary card and its chart.
- Runtime font downloads delayed the first paint. Next now self-hosts the
  existing IBM Plex fonts. In the latest run, LCP is 48–348 ms across all 18
  cells, below the unchanged 800 ms threshold.
- A final compact Clear-label adjustment at intermediate widths still needs
  its deployment readback. The action's accessible name remains unchanged.
- The strict local first-byte benchmark remains open under Coordinator outcome
  `pa7fbd79c1ddd2559`. The latest run has 12 first-byte threshold findings;
  none are layout, contrast, clipping, hierarchy or LCP failures. This is not a
  full formal performance pass.

## Required fidelity surfaces

- Typography: existing IBM Plex Sans/Mono families, weight hierarchy and
  readable metric emphasis are preserved; fonts are served with the app.
- Spacing: results precede low-frequency category navigation. Desktop keeps a
  contextual preview; mobile shows compact results and comparison profile tabs.
- Colors: light and dark project tokens replace mockup-specific decoration;
  teal remains the primary data/action accent.
- Assets: the existing logo/icons are retained. All airfoil shapes and curves
  are actual code-rendered scientific artifacts, never approximate raster art.
- Copy: selectors name available physical conditions, sources distinguish
  predictions from combined estimates, and missing values remain unavailable.

## Interaction evidence

The governed journey passes condition changes, API-to-row metric equality,
Browse-to-Detail handoff, comparison condition persistence and opening a profile
at the same condition, at all three widths in both themes. The agent-browser
smoke passes category-menu opening, Escape dismissal and zero page errors.
Condition-link and comparison-selection unit checks also pass.

## Remaining acceptance

Publish as a preliminary usable increment, not final visual/performance
readiness. Retest the final source on the public route, confirm intermediate
width action-row behavior, and resolve the tracked local response-time budget.

final result: blocked
