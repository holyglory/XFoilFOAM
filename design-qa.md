# Responsive Navigation Design QA

## Evidence

- Source visual truth:
  - `/tmp/airfoils-nav-public-before.png`
  - `/tmp/airfoils-nav-admin-before.png`
  - User annotations on the 653 × 921 production viewport identifying horizontal scroll in the public top bar and admin section navigation.
- Rendered implementation:
  - `/tmp/airfoils-nav-public-final-653.png`
  - `/tmp/airfoils-nav-public-final-390.png`
  - `/tmp/airfoils-nav-admin-final-653.png`
  - `/tmp/airfoils-nav-admin-final-1280.png`
- Same-input comparisons:
  - `/tmp/airfoils-nav-public-comparison.png`
  - `/tmp/airfoils-nav-admin-comparison.png`
- Formal geometry report:
  - `/tmp/airfoils-nav-formal.md`
  - Run `formal-web-ui-mrywq6oa`: 6 production pages checked, coverage gate passed, 0 critical findings.
- Viewports and density:
  - Source and implementation narrow comparison: 653 × 921 CSS px, 653 × 921 image px, device scale factor 1.
  - Supporting phone capture: 390 × 844 CSS px, 390 × 844 image px, device scale factor 1.
  - Supporting desktop capture: 1280 × 900 CSS px, 1280 × 900 image px, device scale factor 1.
- State:
  - Production dark theme.
  - Public and authenticated admin routes.
  - Narrow burger menus open; desktop admin navigation visible.

## Full-view comparison

The source public header kept the desktop navigation row at narrow widths, leaving clipped items and a horizontal scroll affordance. The implementation replaces that row with a contained, right-aligned burger menu while preserving the public page content and existing visual system.

The source admin route combined public navigation with a second horizontally scrolling admin navigation row. The implementation makes the route identity explicit in the top bar (`ADMIN`), removes all public navigation from admin, and exposes the six admin destinations through one contained burger menu at narrow widths. Desktop retains the established admin sidebar.

Measured at 653 px before the change, the public navigation had 44 px of internal horizontal overflow and the admin navigation had 60 px. Final production captures measured document and owning navigation widths equally at 390, 653, and 1280 px, with no horizontal overflow.

## Focused region comparison

The focused comparison is the complete header/navigation region because that is the full changed surface. The public menu stays inside the viewport at both 390 px and 653 px. The admin menu stays inside the viewport at 653 px, contains all six destinations, highlights the current destination, and closes after navigation. No additional focused crop was needed because labels, icons, containment, and active states are legible in the full-height same-input comparisons.

## Required fidelity surfaces

- Fonts and typography: Existing IBM Plex families, weights, sizes, line heights, and letter spacing are preserved. Menu labels use the existing shell typography and remain fully readable without truncation.
- Spacing and layout rhythm: Existing shell height, outer padding, radii, and control spacing are preserved. Popovers align to their trigger context and remain within the viewport.
- Colors and visual tokens: Existing dark surfaces, teal active/focus treatment, muted inactive text, borders, and elevation tokens are reused without introducing a second visual language.
- Image quality and asset fidelity: No raster imagery changed. Existing logo treatment is preserved. Menu and close controls use the installed Lucide icon library rather than custom-drawn assets.
- Copy and content: Public navigation retains Browse, Search, Detail, and Compare. Admin navigation retains Simulations, Solver, Health, Setup library, Catalog, and Sync API. Admin routes no longer expose public navigation labels.

## Findings

No actionable P0, P1, or P2 mismatch remains on the requested navigation surfaces.

The formal report contains warning-only contrast coverage gaps caused by translucent/gradient backgrounds elsewhere on the inspected pages. Existing polar content was excluded from the navigation-only gate after the first formal run found unrelated pre-existing chart occlusion; the exclusion and reason are recorded in the command evidence.

## Comparison history

1. Baseline:
   - P1: Public navigation clipped and scrolled horizontally at the annotated width.
   - P1: Admin displayed public navigation plus a second horizontally scrolling admin navigation row.
   - Fix: Added route-owned public/admin shells and narrow burger menus.
2. First implementation capture:
   - P2: The public burger appeared, but desktop public tabs were still rendered beside it because an inline `display: flex` overrode the responsive stylesheet.
   - Fix: Moved the tabs' display declaration into responsive CSS so the narrow breakpoint can hide it deterministically.
3. Final production capture:
   - Public and admin menus are separated, contained, keyboard-operable, and free of horizontal overflow at 390 px and 653 px.
   - Desktop admin keeps the full sidebar without the public menu.
   - Formal verification passed with 0 critical findings across all six route/viewport combinations.

## Implementation checklist

- [x] Separate public and admin navigation by route.
- [x] Replace narrow public navigation overflow with a burger menu.
- [x] Replace narrow admin navigation overflow with a burger menu.
- [x] Preserve desktop public navigation and desktop admin sidebar.
- [x] Verify menu labels, active states, Escape/outside-click close, and navigation close.
- [x] Verify no document or navigation-shell horizontal overflow at 390, 653, and 1280 px.
- [x] Verify production console and browser errors are empty.

## Follow-up polish

No request-related P3 follow-up is required.

final result: passed

---

# Design QA — compact solver incident log

## Source visual target

- User-visible source:
  `/home/holyglory/.codex/attachments/19511c2c-dac9-4863-9ca4-cf958bb68868/codex-clipboard-61aa7ddb-064c-47e3-b32c-9945f1d2f2a2.png`
- Source viewport: 1260 × 1280 CSS pixels, desktop density.
- Targeted problem: the permanently expanded `SOLVER RELIABILITY` block used
  the first Health viewport for grouped system diagnostics, told the user that
  investigation was required despite providing no user action, and hid event
  chronology and exact evidence.

## Implementation screenshots

- Collapsed desktop, 1260 × 1280:
  `/tmp/solver-log-formal-screens/file_tmp_solver-log.html-desktop.png`
- Collapsed mobile, 390 × 844:
  `/tmp/solver-log-formal-screens/file_tmp_solver-log.html-mobile.png`
- Expanded desktop with one event open, 1260 × 1280:
  `/tmp/solver-log-formal-expanded-screens/file_tmp_solver-log-expanded.html-desktop.png`
- Expanded mobile with one event open, 390 × 844:
  `/tmp/solver-log-formal-expanded-screens/file_tmp_solver-log-expanded.html-mobile.png`
- Same-canvas source/implementation comparison:
  `/tmp/solver-log-design-comparison.png`

## Comparison history

1. The source kept four grouped rows plus a headline visible at all times.
   The first implementation pass replaced them with a 46 px status bar that
   reports only solver-owned/retrying counts and the latest event time.
2. The first broader test pass found an obsolete source-contract test that
   required the old expanded implementation. The contract was corrected to
   require progressive disclosure, explicit system ownership, authenticated
   agent JSON, and absence of the misleading investigation copy.
3. Collapsed and expanded states were rendered from the real component at
   desktop and narrow constraints. The expanded state keeps events newest
   first; every row has an independent disclosure for owner, job/attempt,
   recovery version, occurrence key, resolution state, and raw metadata.
4. The formal geometry verifier checked all four component/state combinations:
   no critical findings, no warnings, no active horizontal scrollbar, and full
   target coverage.
5. Production control-plane deployment preserved all live OpenFOAM workers.
   The authenticated production endpoint returned 46 chronological events,
   28 open events, `userActionRequired=false`, and raw metadata; the deployed
   web bundle contains `Solver recovery` and contains no
   `System investigation required`.

## Final result

Passed. The routine Health state is compact; chronology and debug evidence are
available on demand; wide and narrow layouts remain inside their component;
and the same authenticated read model is available to operators and AI agents.

---

# Design QA — registered remote solver card

## Source visual target

- User-visible source: the browser annotation attached to this task for
  `https://airfoils.pro/admin?section=sync`; the app did not expose a local
  filesystem path for that attachment.
- Source viewport: 517 × 917 CSS pixels.
- Targeted problem: the solver name, CPU capacity, promise counts, heartbeat,
  endpoint, cap control, and save action competed for the same narrow row and
  overlapped.

## Implementation screenshots

- Reported width, 517 × 917:
  `/tmp/remote-solver-layout-screens-final/https_airfoils.pro_admin_section_sync-reported.png`
- Narrow mobile, 390 × 844:
  `/tmp/remote-solver-layout-screens-final/https_airfoils.pro_admin_section_sync-mobile.png`
- Desktop, 1260 × 1280:
  `/tmp/remote-solver-layout-screens-final/https_airfoils.pro_admin_section_sync-desktop.png`
- Formal verification report:
  `/tmp/remote-solver-layout-formal-final.md`

## Comparison history

1. The source compressed identity and metrics into a two-column row whose
   fixed-width content could not fit at 517 px.
2. A regression test was written first and failed against that structure.
3. The card was reorganized into stable identity, heartbeat, capacity, endpoint,
   metric, and control regions. Metric tiles use two columns below 460 px.
4. The first production pass exposed the same fixed-column cause in adjacent
   connection, permissions, and asset card pairs. Those pairs now stack below
   760 px as part of the same prevention scope.
5. Production was rechecked at 517, 390, and 1260 px. The formal verifier found
   zero critical geometry findings and no horizontal overflow.

## Final result

The selected card and adjacent Sync API panels now remain readable without
overlap or clipped text at the reported and narrower widths.

final result: passed
