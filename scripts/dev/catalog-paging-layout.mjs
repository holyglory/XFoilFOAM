// The public catalog keeps the same desktop preview and narrow ranking table
// while the server supplies rows in windows. Check actual seeded list lengths.
export function catalogPagingLayout(origin, repoRoot, reviewInputs) {
  const surface = "[data-testid='browse-surface']";
  const list = surface + " > main";
  const row = (number) =>
    list + " .airfoil-row[role='button']:nth-child(" + (number + 1) + ")";
  const firstName = row(1) + " .airfoil-name-wrap > span:first-child";
  const more = "[data-testid='browse-load-more']";
  const field = "[data-testid='airfoil-name-filter']";
  const themeSwitch = "button[aria-label='Switch to light theme']";
  const toggleLight = { action: "click", selector: themeSwitch };
  const actions = [
    {
      name: "light",
      theme: "light",
      actions: [toggleLight],
      continuation: {
        kind: "in-page",
        anchor: "select[aria-label='Metrics for']",
        focusWithin: "button[aria-label='Switch to dark theme']",
        maxScrollDelta: 8,
      },
    },
  ];
  for (const theme of ["dark", "light"]) {
    const start = theme === "light" ? [toggleLight] : [];
    actions.push(
      {
        name: "expanded-" + theme,
        theme,
        actions: [
          ...start,
          { action: "focus", selector: more },
          { action: "press", selector: more, value: "Enter" },
        ],
        waitFor: { selector: row(340) },
        continuation: {
          kind: "in-page",
          anchor: row(41) + " [data-ui-continuation-anchor]",
          focusWithin: row(41),
          maxScrollDelta: 8,
        },
      },
      {
        name: "filtered-" + theme,
        theme,
        actions: [...start, { action: "fill", selector: field, value: "AG24" }],
        waitFor: {
          selector:
            surface +
            ":has([data-testid='airfoil-row-ag24']):not(:has(" +
            more +
            "))",
        },
        continuation: {
          kind: "in-page",
          anchor: field,
          focusWithin: field,
          maxScrollDelta: 8,
        },
      },
    );
  }
  const states = ["base", ...actions.map((state) => state.name)];
  const viewports = [
    { name: "mobile", width: 390, height: 844 },
    { name: "reported", width: 688, height: 1118 },
    { name: "tablet", width: 1024, height: 768 },
    { name: "desktop", width: 1440, height: 1000 },
    { name: "wide", width: 1920, height: 1080 },
  ];
  for (const boundary of [560, 760, 920, 1180]) {
    for (const width of [boundary - 1, boundary, boundary + 1])
      viewports.push({ name: "width-" + width, width, height: 900 });
  }
  const geometryAssertions = [
    {
      id: "rankings-width",
      kind: "primary-content-width",
      selector: list,
      minWidth: 300,
    },
    { id: "catalog-heading", kind: "readable-heading", selector: "h1" },
    {
      id: "profile-name",
      kind: "readable-canonical-identifier",
      selector: firstName,
    },
    { id: "profile-wrap", kind: "no-character-wrapping", selector: firstName },
    {
      id: "viewport-width",
      kind: "document-horizontal-overflow",
      selector: "html",
    },
    {
      id: "rankings-placement",
      kind: "initial-viewport-placement",
      selector: list,
    },
    { id: "name-clipping", kind: "clipping", selector: firstName },
  ];
  const name = "catalog-paging";
  return {
    repoRoot,
    viewports,
    fixtureDataShapes: states.map((state) => ({
      id: "seed-catalog-" + state,
      revision: "selig-20261123",
      route: "/",
      state,
      target: name,
      conditionalDom: [
        row(
          state.startsWith("expanded")
            ? 340
            : state.startsWith("filtered")
              ? 1
              : 40,
        ),
        state.startsWith("filtered")
          ? "[data-testid='airfoil-row-ag24']"
          : more,
      ],
      layoutEffect:
        "The result table and its footer use the number of profiles returned for this view.",
    })),
    targets: [
      {
        name,
        url: origin + "/",
        theme: "dark",
        journeys: [
          {
            id: "rank-airfoils",
            name: "Rank and explore airfoils for a selected condition",
            frequencyPercent: 100,
            risk: "normal",
            rationale: "Browse and compare measured catalog metrics.",
          },
        ],
        primaryJourney: "rank-airfoils",
        regions: [
          {
            name: "Airfoil ranking",
            selector: list,
            role: "primary-content",
            journey: "rank-airfoils",
          },
        ],
        waitFor: { selector: surface + "[data-hydrated='true']" },
        geometryAssertions,
        reviewInputs: [
          ...reviewInputs,
          { path: "apps/web/lib/api.ts", kind: "ui-code" },
          { path: "apps/web/lib/airfoil-glyph.ts", kind: "ui-code" },
          { path: "apps/web/components/AirfoilGlyph.tsx", kind: "ui-code" },
          {
            path: "apps/web/components/browse/CatalogContent.tsx",
            kind: "ui-code",
          },
          { path: "apps/web/components/shell/AppShell.tsx", kind: "ui-code" },
          {
            path: "apps/web/app/catalog-page/[view]/page.tsx",
            kind: "ui-code",
          },
          { path: "apps/web/next.config.ts", kind: "ui-code" },
        ],
        states: actions,
      },
    ],
    requiredCoverage: states.flatMap((state) =>
      viewports.map((v) => ({
        target: name,
        state,
        viewport: v.name,
        width: v.width,
      })),
    ),
    execution: { maxConcurrency: 1 },
    maxPageCount: states.length * viewports.length,
    performance: { ttfbLocalOnly: true, ttfbMs: 10, lcpMs: 800 },
  };
}
