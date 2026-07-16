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

---

# Campaign Cell Evidence Dialog — Historical deployed baseline

This section records the previously deployed evidence-dialog correction. Its
`results unavailable` presentation is superseded by the three-stage solver-flow
contract below; the modal, pinned-geometry, scroll-lock, and evidence-disclosure
findings remain applicable.

- Live route:
  `https://airfoils.pro/admin?campaign=c24047fa-743f-4ae5-bcd6-f3071ff79fb4`.
- Same-state production source:
  `/home/holyglory/XFoilFOAM-cell-modal/.codex-artifacts/design-qa/campaign-cell-modal/before-1100x900.png`
  (1100×900, SHA-256
  `95d8abbd4b79f22f0f720c173bb476749f29cc08dc975b73c2eae175b50dc7e5`).
- Deployed production result:
  `/home/holyglory/XFoilFOAM-cell-modal/.codex-artifacts/design-qa/campaign-cell-modal/after-1100x900.png`
  (1100×900, SHA-256
  `4bf94980188c1ecff841981cab884af683609dcde311d81982dcbf0375fb0269`).
- Combined same-input comparison:
  `/home/holyglory/XFoilFOAM-cell-modal/.codex-artifacts/design-qa/campaign-cell-modal/before-after-2200x940.png`
  (2200×940, SHA-256
  `1ea587a99add000bc0d392ce0a91942b69f0efde56c2f727009e8f13d87862cf`).
- Deployed Airfoil view:
  `/home/holyglory/XFoilFOAM-cell-modal/.codex-artifacts/design-qa/campaign-cell-modal/airfoil-tab-1100x900.png`.
- Deployed narrow Airfoil view:
  `/home/holyglory/XFoilFOAM-cell-modal/.codex-artifacts/design-qa/campaign-cell-modal/airfoil-tab-390x844.png`.

## Correction and prevention

The annotated production panel looked and behaved like a modal but let wheel
input move the hidden campaign page. Its `FAILED POINTS` panel also combined
steady-RANS evidence, preliminary-URANS evidence, infrastructure/setup
submissions, and physical CFD attempts into one unlabeled `attempts` count.
Raw `solver evidence rejected` diagnostics required users to infer whether
RANS had handed off normally, URANS had run, or the automatic path had ended.
The airfoil identity contained only text and offered no profile view.

The prevention layer is a separate preliminary-outcome read model, sequence-
scoped continuation classification, physical-budget versus evidence-record
tests, and a browser regression that exercises the modal through the exact
user journey. It proves document scroll/focus ownership, nested modal reference
counting, real pinned geometry, wide/narrow containment, and the absence of the
misleading copy.

## Same-input comparison result

The 1100×900 production source and deployed result were opened together in one
comparison input at the same route, cell, chart, theme, and scroll state.

- The selected cell remains the dominant right-side surface and preserves the
  existing chart scale, toolbar, fidelity controls, and provenance access.
- A compact real airfoil contour now precedes the airfoil name without
  increasing header height or displacing the primary chart.
- The new Airfoil tab sits before the four established polar tabs. It renders
  the pinned stored profile, camber and chord references, and real maximum
  thickness, maximum camber, trailing-edge, and profile-area values.
- `7 blocked` is replaced by `7 results unavailable`. The former dense
  `FAILED POINTS` table is replaced by one `PRELIMINARY URANS` explanation and
  per-angle outcome rows with a consistent three-part hierarchy: outcome,
  physical-run budget, then evidence history/diagnosis.
- The exact production rows show α2°/3° as two of two physical runs with two
  preliminary evidence records, and α10°/15°/16°/19°/20° as two of two with
  one preliminary record plus one evidence-less interrupted continuation.
  Every row reports zero full-URANS evidence. No raw `solver evidence rejected`
  or bare mixed `3 attempts`/`4 attempts` copy remains.
- The narrow 390×844 result keeps the thumbnail, identity, all five tabs,
  profile, metrics, status controls, and preliminary explanation contained.
  Measured document and panel horizontal overflow are both zero.

## Production interaction verification

- The exact preliminary-outcomes request returned HTTP 200 and seven rows for
  20-32C/Re≈102k.
- While open, the body was fixed with hidden overflow. A real wheel event
  inside the panel advanced its scroll position by 700 px while page scroll
  stayed zero; the same event over the backdrop moved neither layer. At the
  panel's lower bound, further wheel input remained contained.
- Closing at an unchanged viewport restored the exact 410 px campaign scroll
  position, cleared all body lock styles, and restored focus to
  `Re 102k · #0 · 26/26 · 7 blocked`.
- The 1100×900 profile and 390×844 profile both used non-empty stored surface
  and camber paths. The browser regression additionally compares the thumbnail
  and profile paths against the pinned detail API geometry exactly.
- The production document and panel each measured zero horizontal overflow.
  No browser page error was observed.

## Release evidence

- Focused production-shaped Playwright journey: 1/1 passed.
- Web unit suite: 295/295 passed.
- Campaign API/DB suite: 48/48 passed.
- Preliminary copy helpers: 4/4 passed.
- DB, API, and web typechecks passed; the production web build and deploy
  script syntax check passed.
- GitHub Actions control-plane deploy run `29497137489` succeeded. The engine
  API and worker retained their exact pre-deploy container IDs and start times
  while live `simpleFoam` work continued; only Node control-plane services were
  replaced.

## Findings

- No open P0, P1, or P2 findings.
- Accepted P3: the narrow header wraps the external detail-page action onto its
  own line. It remains visible in the first viewport, preserves the airfoil
  identity, and avoids truncation or horizontal overflow.

final result: passed

---

# Three-stage per-point solver flow — Release QA

## User-visible contract

Every angle is presented as one compact sequence:

1. RANS screening — normal handoff when not publishable;
2. Preliminary URANS — fast result;
3. Verified URANS — final result.

RANS rejection or non-convergence is a normal automatic handoff and never a
failed or blocked point. Only exhausted automatic pre-solver mesh/runtime
repair or exhausted preliminary/final URANS recovery is a red critical system
incident. It is surfaced for investigation and algorithm or runtime
correction, not as a normal retry, review, or setup-change task for the user.
Primary rows show the current stage and result; physical attempts, evidence
history, and classifier diagnostics stay behind the information disclosure.

## Prevention and deterministic verification

- The read model emits mutually exclusive current-state totals and exactly one
  current stage per angle.
- Serial polling has a bounded timeout, never overlaps, pauses in hidden tabs,
  and stops when the modal closes.
- Accepted final evidence remains the canonical teal result while a newer
  final rerun is visibly queued, running, or critical.
- Campaign summaries, condition cards, coverage cells, and point chips use
  `critical`/`result unavailable` for exhausted recovery; the word `blocked`
  remains reserved for real scheduler or infrastructure admission gates.
- Repeated preliminary/final incidents are grouped by stage, cause, solver
  implementation, and remediation version. Three occurrences promote the
  pattern to the user-visible `CRITICAL · SYSTEM OWNED` state and the internal
  investigation queue; resolved recurrence remains historical on Health and
  does not displace the campaign instrument.
- The mixed-version recovery gate keeps continuation/final recovery pending
  unless the engine advertises the exact `urans_recovery_version` pinned by the
  request. Legacy version 0 may continue ordinary RANS and first-pass
  preliminary URANS, but it cannot execute version-1 recovery semantics.
- Wide and narrow browser contracts cover the full per-point transition,
  modal scroll ownership, rail containment, polling teardown, and incident
  presentation.

Local release verification on 2026-07-16:

- the complete campaign/incident browser journey passed 7/7 tests, including
  one request at a time under React Strict Mode, exact fast/final evidence
  opening by stable result id, nested-modal focus and scroll ownership,
  collapsed diagnostics, and the 390 px layout with no rail or page overflow;
- the focused modal journey passed independently (1/1);
- formal UI verification checked the affected route at 390×844 and 1440×900,
  passed its coverage gate, and reported zero critical geometry, visibility,
  clipping, overlap, or text-fit findings. Its non-blocking warnings were
  limited to contrast that cannot be computed through translucent backgrounds
  and the intentional narrow navigation scroller;
- all JavaScript/TypeScript suites passed: web 323, API 260, and sweeper 435
  tests (1,018 total), together with all 108 database tests, workspace
  typechecks, and the production web build;
- all 930 non-integration Python tests passed. The complete Python run proved
  948 integration/unit cases and skipped one unavailable optional case; its
  only failure was the host media canary because `ffmpeg` was absent. The
  encoder dependency now fails before expensive CFD, the render path reports
  explicit per-field unavailable-media evidence instead of a silent empty
  result, and focused missing/available-encoder regressions pass. After
  installing the same encoder already present in the production worker image,
  the retained canary fields were replayed without another CFD solve into a
  1,129,980-byte H.264 MP4 (900×600, 20 fps, 89 frames, 4.45 s); `ffprobe`
  inspected it successfully and a full `ffmpeg` decode returned no errors.

The running production engine remains OpenCFD 2406. The new control-plane
release, its mixed-version gate, and version-1 recovery path have not completed
production verification. Production route capture, same-input visual
comparison, exact mixed-version behavior verification, the guarded OpenCFD
2606 canaries, recovered-result monitoring, and a repeat formal geometry pass
remain mandatory post-deploy release gates; none is inferred from these local
checks.

final result: pending production verification
