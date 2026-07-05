import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiURL = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:4000";

interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  parentId?: string | null;
  path?: string;
}

interface AirfoilRow {
  id: string;
  slug: string;
  name: string;
}

interface HashtagRow {
  id: string;
  slug: string;
  name: string;
}

interface MediumRow {
  id: string;
  slug: string;
  name: string;
}

interface SimulationPresetCompatRow {
  id: string;
  slug: string;
  name: string;
  mediumId: string;
  speedMps: number;
  referenceChordM: number;
  pressurePa: number;
  temperatureK: number;
  reynolds: number;
  mach?: number | null;
}

interface SimulationSetupRow {
  simulationPresets: Array<{
    slug: string;
    targetScope: "all" | "airfoils";
    targetAirfoilIds: string[];
  }>;
}

const state: {
  stamp: string;
  root: CategoryRow;
  child: CategoryRow;
  dest: CategoryRow;
  rootAirfoil: AirfoilRow;
  childAirfoil: AirfoilRow;
  removeAirfoil: AirfoilRow;
  tag: HashtagRow;
  tag2: HashtagRow;
} = {} as never;

async function json<T>(request: APIRequestContext, method: "get" | "post" | "patch" | "delete", path: string, data?: unknown): Promise<T> {
  const res = await request[method](`${apiURL}${path}`, { data });
  expect(res.ok(), `${method.toUpperCase()} ${path} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

async function createCategory(request: APIRequestContext, name: string, parentId?: string): Promise<CategoryRow> {
  return json<CategoryRow>(request, "post", "/api/admin/categories", { name, parentId: parentId ?? null });
}

async function createAirfoil(request: APIRequestContext, name: string, categorySlug: string, t: number, m: number, p: number): Promise<AirfoilRow> {
  return json<AirfoilRow>(request, "post", "/api/airfoils", { name, categorySlug, naca: { t, m, p } });
}

async function createHashtag(request: APIRequestContext, name: string): Promise<HashtagRow> {
  return json<HashtagRow>(request, "post", "/api/admin/hashtags", { name });
}

async function listMediums(request: APIRequestContext): Promise<MediumRow[]> {
  return (await json<{ items: MediumRow[] }>(request, "get", "/api/admin/mediums")).items;
}

async function listBoundaryConditions(request: APIRequestContext): Promise<SimulationPresetCompatRow[]> {
  return (await json<{ items: SimulationPresetCompatRow[] }>(request, "get", "/api/admin/boundary-conditions")).items;
}

async function getSimulationSetup(request: APIRequestContext): Promise<SimulationSetupRow> {
  return json<SimulationSetupRow>(request, "get", "/api/admin/simulation-setup");
}

// ---- admin IA navigation (nav: Simulations / Solver / Setup library /
// Catalog / Sync API; the Solver section keeps URL key ?section=queue;
// Mediums is a Setup-library tab; Add airfoils / Categories / Hashtags are
// Catalog tabs; URL search-param routing) ----
type AdminSection = "simulations" | "queue" | "setup" | "catalog" | "sync";

async function gotoAdminSection(page: Page, section: AdminSection) {
  if (!page.url().includes("/admin")) await page.goto("/admin");
  await page.getByTestId(`admin-nav-${section}`).click();
}

async function openSetupTab(page: Page, tab: string) {
  await gotoAdminSection(page, "setup");
  await page.getByRole("button", { name: new RegExp(`^${tab}$`, "i") }).click();
}

async function openCatalogTab(page: Page, tab: "add" | "categories" | "hashtags") {
  await gotoAdminSection(page, "catalog");
  await page.getByTestId(`catalog-tab-${tab}`).click();
}

async function fillWrappedField(page: Page, label: string, value: string) {
  const accessible = page.getByLabel(label, { exact: true });
  if ((await accessible.count()) > 0) {
    await accessible.first().fill(value);
    return;
  }
  await page.locator("label").filter({ hasText: label }).locator("input, textarea").first().fill(value);
}

async function selectWrappedField(page: Page, label: string, value: string) {
  const accessible = page.getByLabel(label, { exact: true });
  if ((await accessible.count()) > 0) {
    await accessible.first().selectOption(value);
    return;
  }
  await page.locator("label").filter({ hasText: label }).locator("select").first().selectOption(value);
}

async function selectUnit(page: Page, field: string, unit: string) {
  await page.getByRole("button", { name: `${field} unit` }).click();
  await page.getByRole("menuitemradio", { name: unit }).click();
}

async function selectRow(page: Page, slug: string) {
  await page.getByTestId(`airfoil-row-${slug}`).hover();
  await page.getByTestId(`select-airfoil-${slug}`).click();
}

async function dragCategory(page: Page, sourceSlug: string, targetSlug: string, yRatio: number) {
  const source = page.getByTestId(`admin-category-${sourceSlug}`);
  const target = page.getByTestId(`admin-category-${targetSlug}`);
  const box = await target.boundingBox();
  expect(box, `target ${targetSlug} should have a bounding box`).not.toBeNull();
  await source.dragTo(target, { targetPosition: { x: Math.max(12, box!.width / 2), y: Math.max(2, Math.min(box!.height - 2, box!.height * yRatio)) } });
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAirfoilQueryFor(responseUrl: string, categorySlug: string, includeSubcategories: boolean): boolean {
  try {
    const url = new URL(responseUrl);
    return (
      url.pathname === "/api/airfoils" &&
      url.searchParams.get("category") === categorySlug &&
      url.searchParams.get("includeSubcategories") === String(includeSubcategories)
    );
  } catch {
    return false;
  }
}

async function selectBrowseCategory(page: Page, categorySlug: string, includeSubcategories = true) {
  await expect(page.getByTestId("browse-surface")).toHaveAttribute("data-hydrated", "true");
  await Promise.all([
    page.waitForResponse((res) => res.ok() && isAirfoilQueryFor(res.url(), categorySlug, includeSubcategories)),
    page.getByTestId(`category-${categorySlug}`).click(),
  ]);
}

async function setBrowseIncludeSubcategories(page: Page, checked: boolean, categorySlug: string) {
  await expect(page.getByTestId("browse-surface")).toHaveAttribute("data-hydrated", "true");
  await Promise.all([
    page.waitForResponse((res) => res.ok() && isAirfoilQueryFor(res.url(), categorySlug, checked)),
    checked ? page.getByTestId("include-subcategories").check() : page.getByTestId("include-subcategories").uncheck(),
  ]);
}

test.describe.serial("catalog tree, filters, hashtags, and bulk management", () => {
  test.beforeAll(async ({ request }) => {
    state.stamp = `pw-${Date.now().toString(36)}`;
    state.root = await createCategory(request, `${state.stamp} Root`);
    state.child = await createCategory(request, `${state.stamp} Child`, state.root.id);
    state.dest = await createCategory(request, `${state.stamp} Destination`);
    state.tag = await createHashtag(request, `${state.stamp} Filter`);
    state.tag2 = await createHashtag(request, `${state.stamp} Assigned`);
    state.rootAirfoil = await createAirfoil(request, `${state.stamp} Root 0012`, state.root.slug, 0.12, 0, 0);
    state.childAirfoil = await createAirfoil(request, `${state.stamp} Child 4415`, state.child.slug, 0.15, 0.04, 0.4);
    state.removeAirfoil = await createAirfoil(request, `${state.stamp} Remove 0009`, state.root.slug, 0.09, 0, 0);
    await json(request, "post", "/api/admin/airfoils/bulk", {
      ids: [state.childAirfoil.id],
      action: "assignHashtags",
      hashtagIds: [state.tag.id],
    });
  });

  test.afterAll(async ({ request }) => {
    if (state.stamp?.startsWith("pw-")) {
      await json(request, "post", "/api/admin/test-artifacts/purge", { prefix: state.stamp });
    }
  });

  test("admin preset save validates missing preset name without creating a row", async ({ page, request }) => {
    const before = (await getSimulationSetup(request)).simulationPresets.length;

    await page.goto("/admin");
    await openSetupTab(page, "Presets");
    await selectWrappedField(page, "Enabled", "no");

    const saveButton = page.getByRole("button", { name: /save new simulation preset/i });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect(page.getByText("Preset name is required").first()).toBeVisible();
    await expect(page.getByLabel("Preset name", { exact: true })).toBeFocused();
    expect((await getSimulationSetup(request)).simulationPresets).toHaveLength(before);
  });

  test("admin setup create and update actions validate required fields instead of disabling", async ({ page }) => {
    await page.goto("/admin");
    await gotoAdminSection(page, "setup");

    const cases = [
      { tab: "Flow state", button: /add flow state/i, message: "Name is required" },
      { tab: "Reference geometry", button: /add reference geometry/i, message: "Name is required" },
      { tab: "Boundary", button: /add boundary profile/i, message: "Name is required" },
      { tab: "Mesh", button: /add mesh profile/i, message: "Name is required" },
      { tab: "Solver", button: /add solver profile/i, message: "Name is required" },
      { tab: "Scheduling", button: /add scheduling profile/i, message: "Name is required" },
      { tab: "Output", button: /add output profile/i, message: "Name is required" },
      { tab: "Sweeps", button: /add sweep definition/i, message: "Name is required" },
      { tab: "Presets", button: /save new simulation preset/i, message: "Preset name is required" },
    ];

    for (const item of cases) {
      await page.getByRole("button", { name: new RegExp(`^${item.tab}$`, "i") }).click();
      const button = page.getByRole("button", { name: item.button });
      await expect(button).toBeEnabled();
      await button.click();
      await expect(page.getByText(item.message).first()).toBeVisible();
    }
  });

  test("adjacent admin forms validate missing user input without silent disabled buttons", async ({ page }) => {
    await page.goto("/admin");

    await openSetupTab(page, "Mediums");
    await expect(page.getByRole("button", { name: /add medium/i })).toBeEnabled();
    await page.getByRole("button", { name: /add medium/i }).click();
    await expect(page.getByText("Name is required").first()).toBeVisible();

    await openCatalogTab(page, "categories");
    await expect(page.getByRole("button", { name: /create category/i })).toBeEnabled();
    await page.getByRole("button", { name: /create category/i }).click();
    await expect(page.getByText("Name is required").first()).toBeVisible();

    await openCatalogTab(page, "hashtags");
    await expect(page.getByRole("button", { name: /add hashtag/i })).toBeEnabled();
    await page.getByRole("button", { name: /add hashtag/i }).click();
    await expect(page.getByText("Name is required").first()).toBeVisible();

    await openCatalogTab(page, "add");
    await page.getByRole("button", { name: /^Single$/i }).click();
    await page.getByRole("button", { name: /^Coordinates$/i }).click();
    await expect(page.getByRole("button", { name: /^Add airfoil$/i })).toBeEnabled();
    await page.getByRole("button", { name: /^Add airfoil$/i }).click();
    await expect(page.getByText("Coordinates are required")).toBeVisible();

    await gotoAdminSection(page, "sync");
    await fillWrappedField(page, "Up-tier endpoint", "");
    await expect(page.getByRole("button", { name: /sync DB \+ remote refs/i })).toBeEnabled();
    await page.getByRole("button", { name: /sync DB \+ remote refs/i }).click();
    await expect(page.getByText("Up-tier endpoint is required").first()).toBeVisible();
  });

  test("browse tree scopes direct and descendant airfoils", async ({ page }) => {
    await page.goto("/");
    await selectBrowseCategory(page, state.root.slug);
    await expect(page.getByTestId(`airfoil-row-${state.rootAirfoil.slug}`)).toBeVisible();
    await expect(page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`)).toBeVisible();

    await setBrowseIncludeSubcategories(page, false, state.root.slug);
    await expect(page.getByTestId(`airfoil-row-${state.rootAirfoil.slug}`)).toBeVisible();
    await expect(page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`)).toHaveCount(0);

    await page.getByTestId("airfoil-name-filter").fill(state.childAirfoil.name);
    await expect(page.getByText("no airfoils match.")).toBeVisible();

    await selectBrowseCategory(page, state.child.slug, false);
    await expect(page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`)).toBeVisible();
  });

  test("browse row chooses the Detail profile while checkbox stays selection-only", async ({ page }) => {
    await page.goto("/");
    await selectBrowseCategory(page, state.root.slug);
    await page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`).click();
    await expect(page).toHaveURL(new RegExp(`/airfoils/${state.childAirfoil.slug}$`));
    await expect(page.getByRole("heading", { name: state.childAirfoil.name })).toBeVisible();

    await page.goto("/");
    await selectBrowseCategory(page, state.root.slug);
    await page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`).hover();
    await page.getByTestId(`select-airfoil-${state.childAirfoil.slug}`).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("bulk-toolbar")).toContainText("1 selected");
  });

  test("advanced filters apply thickness, area UI, and hashtag filters", async ({ page }) => {
    await page.goto("/");
    await selectBrowseCategory(page, state.root.slug);
    await page.getByTestId("advanced-filters-button").click();
    await expect(page.getByTestId("advanced-filters-panel")).toBeVisible();

    await page.getByTestId("thickness-min").fill("14");
    await expect(page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`)).toBeVisible();
    await expect(page.getByTestId(`airfoil-row-${state.rootAirfoil.slug}`)).toHaveCount(0);

    await page.getByTestId("upperPositive-min").click();
    await expect(page.getByTestId("upperPositive-range")).toBeVisible();
    await expect(page.getByTestId("area-infographic")).toBeVisible();

    await page.getByTestId("thickness-min").fill("");
    await page.getByTestId(`hashtag-filter-${state.tag.slug}`).click();
    await expect(page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`)).toBeVisible();
    await expect(page.getByTestId(`airfoil-row-${state.rootAirfoil.slug}`)).toHaveCount(0);
  });

  test("selection controls appear on hover and select all/none works", async ({ page }) => {
    await page.goto("/");
    await selectBrowseCategory(page, state.root.slug);
    await page.getByTestId(`airfoil-row-${state.rootAirfoil.slug}`).hover();
    await page.getByTestId(`select-airfoil-${state.rootAirfoil.slug}`).click();
    await expect(page.getByTestId("bulk-toolbar")).toContainText("1 selected");

    await page.getByRole("button", { name: /select all/i }).click();
    await expect(page.getByTestId("bulk-toolbar")).toContainText("3 selected");

    await page.getByRole("button", { name: /select none/i }).click();
    await expect(page.getByTestId("bulk-toolbar")).toHaveCount(0);
  });

  test("bulk move persists category assignment", async ({ page }) => {
    await page.goto("/");
    await selectBrowseCategory(page, state.child.slug);
    await selectRow(page, state.childAirfoil.slug);
    await page.getByRole("button", { name: /move to category/i }).click();
    await page.getByPlaceholder("search category...").fill(state.dest.name);
    await page.getByTestId("bulk-move-popover").getByRole("button", { name: new RegExp(state.dest.name) }).click();
    await expect(page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`)).toHaveCount(0);

    await selectBrowseCategory(page, state.dest.slug);
    await expect(page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`)).toBeVisible();
    await page.reload();
    await selectBrowseCategory(page, state.dest.slug);
    await expect(page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`)).toBeVisible();
  });

  test("bulk hashtag assign and remove changes filter results", async ({ page }) => {
    await page.goto("/");
    await selectBrowseCategory(page, state.dest.slug);
    await selectRow(page, state.childAirfoil.slug);
    await page.getByTestId("bulk-hashtag-search").fill(state.tag2.name);
    await page.getByTestId("bulk-hashtag-popover").getByRole("button", { name: new RegExp(state.tag2.name) }).click();
    await page.getByRole("button", { name: /^assign$/i }).click();

    await page.getByTestId("advanced-filters-button").click();
    await page.getByTestId(`hashtag-filter-${state.tag2.slug}`).click();
    await expect(page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`)).toBeVisible();

    await selectRow(page, state.childAirfoil.slug);
    await page.getByTestId("bulk-hashtag-search").fill(state.tag2.name);
    await page.getByTestId("bulk-hashtag-popover").getByRole("button", { name: new RegExp(state.tag2.name) }).click();
    await page.getByRole("button", { name: /remove selected hashtags/i }).click();
    await expect(page.getByTestId(`airfoil-row-${state.childAirfoil.slug}`)).toHaveCount(0);
  });

  test("bulk archive and remove hide selected airfoils", async ({ page }) => {
    await page.goto("/");
    await selectBrowseCategory(page, state.root.slug);
    await setBrowseIncludeSubcategories(page, false, state.root.slug);

    await selectRow(page, state.rootAirfoil.slug);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /archive/i }).click();
    await expect(page.getByTestId(`airfoil-row-${state.rootAirfoil.slug}`)).toHaveCount(0);

    await selectRow(page, state.removeAirfoil.slug);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /remove selected airfoils/i }).click();
    await expect(page.getByTestId(`airfoil-row-${state.removeAirfoil.slug}`)).toHaveCount(0);
  });

  test("admin category editor creates, renames, blocks nonempty delete, moves, and deletes empty category", async ({ page }) => {
    await page.goto("/admin");
    await openCatalogTab(page, "categories");

    await page.getByTestId("new-category-name").fill(`${state.stamp} Empty`);
    await page.getByTestId("new-category-parent").selectOption(state.root.id);
    await page.getByRole("button", { name: /create category/i }).click();
    const createdButton = page.getByRole("button", { name: new RegExp(`${state.stamp} Empty`) });
    await expect(createdButton).toBeVisible();

    await createdButton.click();
    await page.getByTestId("edit-category-name").fill(`${state.stamp} Empty Renamed`);
    await page.getByTestId("edit-category-parent").selectOption(state.dest.id);
    await page.getByRole("button", { name: /^save$/i }).click();
    await expect(page.getByRole("button", { name: new RegExp(`${state.stamp} Empty Renamed`) })).toBeVisible();

    await page.getByTestId(`admin-category-${state.root.slug}`).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /^delete$/i }).click();
    await expect(page.getByText(/category has/i)).toBeVisible();

    await page.getByRole("button", { name: new RegExp(`${state.stamp} Empty Renamed`) }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /^delete$/i }).click();
    await expect(page.getByRole("button", { name: new RegExp(`${state.stamp} Empty Renamed`) })).toHaveCount(0);
  });

  test("admin category tree supports drag reparent and reorder", async ({ page, request }) => {
    const dragA = await createCategory(request, `${state.stamp} Drag A`);
    const dragB = await createCategory(request, `${state.stamp} Drag B`);
    await page.goto("/admin");
    await openCatalogTab(page, "categories");

    await dragCategory(page, dragA.slug, state.dest.slug, 0.5);
    await page.getByTestId(`admin-category-${dragA.slug}`).click();
    await expect(page.getByTestId("edit-category-parent")).toHaveValue(state.dest.id);

    await dragCategory(page, dragA.slug, dragB.slug, 0.9);
    await page.getByTestId(`admin-category-${dragA.slug}`).click();
    await expect(page.getByTestId("edit-category-parent")).toHaveValue("");
    const aBox = await page.getByTestId(`admin-category-${dragA.slug}`).boundingBox();
    const bBox = await page.getByTestId(`admin-category-${dragB.slug}`).boundingBox();
    expect(aBox?.y ?? 0).toBeGreaterThan(bBox?.y ?? 0);
  });

  // Read-only against the live queue: navigation + tab switching only — no
  // sweeper-state mutation (Pause/Resume, CPU slots, requeue are never
  // clicked), safe to run while a campaign is actively solving.
  test("admin Solver page shows activity, background, and engine surfaces", async ({ page }) => {
    await page.goto("/admin");
    await gotoAdminSection(page, "queue");
    await expect(page.getByTestId("openfoam-queue-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Solver" })).toBeVisible();

    // Activity (default tab): truth banner + controls + active jobs +
    // collapsed finished log.
    await expect(page.getByTestId("solver-banner")).toBeVisible();
    await expect(page.getByTestId("sweeper-process-state")).not.toBeEmpty();
    await expect(page.getByText("OpenFOAM CPU slots")).toBeVisible();
    await expect(page.getByTestId("queue-active-jobs")).toContainText("Active jobs");
    await expect(page.getByTestId("queue-finished-jobs")).toContainText("Finished job log");

    // Background tab (?tab=background): pending sweeps + external promises.
    await page.getByTestId("solver-tab-background").click();
    await expect(page).toHaveURL(/section=queue/);
    await expect(page).toHaveURL(/tab=background/);
    await expect(page.getByTestId("queue-pending-sweeps")).toContainText("Pending sweeps");
    await expect(page.getByText(/AoA sweep|No pending sweeps/).first()).toBeVisible();
    await expect(page.getByTestId("queue-external-promises")).toContainText("Externally promised");

    // Engine tab (?tab=engine): identity, celery introspection, cache stats
    // (real values or the honest unavailable line — never invented numbers).
    await page.getByTestId("solver-tab-engine").click();
    await expect(page).toHaveURL(/tab=engine/);
    await expect(page.getByTestId("engine-identity")).toContainText("url");
    await expect(page.getByTestId("engine-celery")).toBeVisible();
    await expect(page.getByTestId("engine-cache-card")).toContainText(/Mesh entries|cache stats unavailable/);
    await expect(page.getByTestId("engine-recover-stale")).toContainText("recover stale");

    // Back to Activity drops the tab param.
    await page.getByTestId("solver-tab-activity").click();
    await expect(page).not.toHaveURL(/tab=/);
    await expect(page.getByTestId("solver-banner")).toBeVisible();
  });

  test("admin creates and edits mediums from the UI", async ({ page, request }) => {
    const name = `${state.stamp} UI Medium`;
    await page.goto("/admin");
    await openSetupTab(page, "Mediums");

    await fillWrappedField(page, "Name", name);
    await fillWrappedField(page, "Slug optional", slugify(name));
    await selectWrappedField(page, "Phase", "gas");
    await fillWrappedField(page, "Density kg/m³", "1.19");
    await fillWrappedField(page, "Ref temp", "290");
    await fillWrappedField(page, "Ref pressure", "101325");
    await selectWrappedField(page, "Viscosity model", "constant");
    await fillWrappedField(page, "Dynamic viscosity", "0.0000182");
    await fillWrappedField(page, "Speed of sound", "342");
    await fillWrappedField(page, "Notes", "created by Playwright");
    await page.getByRole("button", { name: /add medium/i }).click();

    await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await fillWrappedField(page, "Notes", "edited by Playwright");
    await page.getByRole("button", { name: /save medium/i }).click();

    const medium = (await listMediums(request)).find((m) => m.slug === slugify(name));
    expect(medium?.name).toBe(name);
  });

  test("admin creates and edits simulation setup presets with derived Re and Mach", async ({ page, request }) => {
    const mediumName = `${state.stamp} BC Medium`;
    const bcName = `${state.stamp} UI BC`;
    await json<MediumRow>(request, "post", "/api/admin/mediums", {
      name: mediumName,
      slug: slugify(mediumName),
      phase: "gas",
      density: 1.225,
      refTemperatureK: 288.15,
      refPressurePa: 101325,
      viscosityModel: "sutherland",
      sutherlandMuRef: 0.00001827,
      sutherlandTRef: 291.15,
      sutherlandS: 120,
      speedOfSound: 340.3,
      notes: null,
    });

    await page.goto("/admin");
    await gotoAdminSection(page, "setup");

    await page.getByRole("button", { name: /^Flow state$/i }).click();
    await fillWrappedField(page, "Name", `${bcName} flow`);
    await fillWrappedField(page, "Slug optional", `${slugify(bcName)}-flow`);
    await selectWrappedField(page, "Medium", mediumName);
    await fillWrappedField(page, "Temperature", "288,15");
    await selectUnit(page, "Temperature", "°C");
    await expect(page.getByLabel("Temperature", { exact: true })).toHaveValue(/^15(\.0+)?$/);
    await selectUnit(page, "Temperature", "K");
    await expect(page.getByLabel("Temperature", { exact: true })).toHaveValue("288.15");
    await selectUnit(page, "Temperature", "°C");
    await fillWrappedField(page, "Temperature", "20");
    await selectUnit(page, "Pressure", "kPa");
    await fillWrappedField(page, "Pressure", "101.325");
    await selectUnit(page, "Speed", "km/h");
    await fillWrappedField(page, "Speed", "151.2");
    await expect(page.getByText("Derived Mach")).toBeVisible();
    await expect(page.getByText(/0\.123/).last()).toBeVisible();
    await page.getByRole("button", { name: /add flow state/i }).click();

    await page.getByRole("button", { name: /^Reference geometry$/i }).click();
    await fillWrappedField(page, "Name", `${bcName} reference geometry`);
    await fillWrappedField(page, "Slug optional", `${slugify(bcName)}-reference-geometry`);
    await expect(page.getByLabel("Geometry type")).toHaveCount(0);
    await expect(page.getByLabel("Reference length kind")).toHaveCount(0);
    await selectUnit(page, "Reference length", "ft");
    await fillWrappedField(page, "Reference length", "2.46063");
    await page.getByRole("button", { name: /add reference geometry/i }).click();

    await page.getByRole("button", { name: /^Boundary$/i }).click();
    await fillWrappedField(page, "Name", `${bcName} boundary`);
    await expect(page.getByLabel("Turbulent viscosity ratio νt/ν")).toBeVisible();
    const viscosityPresetBox = await page.getByLabel("Turbulent viscosity ratio νt/ν").boundingBox();
    expect(viscosityPresetBox?.width ?? 0).toBeGreaterThan(300);
    await expect(page.getByText("advanced raw value")).toBeVisible();
    await page.getByRole("button", { name: /add boundary profile/i }).click();

    await page.getByRole("button", { name: /^Mesh$/i }).click();
    await fillWrappedField(page, "Name", `${bcName} mesh`);
    await expect(page.getByLabel("Mesher")).toHaveCount(0);
    const meshGuide = page.getByLabel("Mesh parameter guide");
    await expect(meshGuide).toBeVisible();
    await expect(meshGuide.getByRole("img", { name: /c-grid airfoil mesh infographic/i })).toBeVisible();
    await expect(page.getByText("30,400")).toHaveCount(0);
    await expect(page.getByLabel("Surface", { exact: true })).toBeVisible();
    await page.getByLabel("Surface", { exact: true }).focus();
    await expect(page.getByLabel("Surface slider")).toBeVisible();
    await expect(meshGuide.locator("[data-mesh-note]")).toHaveCount(0);
    const meshArtifact = page.getByTestId("mesh-infographic-artifact");
    const meshExplanations = page.getByTestId("mesh-explanation-grid");
    await expect(meshExplanations).toBeVisible();
    await expect(page.getByText("Chordwise wall cells along the airfoil surface")).toBeVisible();
    await expect(page.getByText("The mesh stays chord-aligned while AoA sweeps rotate")).toBeVisible();
    const guideBox = await meshGuide.boundingBox();
    expect(guideBox?.width ?? 0).toBeGreaterThan(700);
    const artifactBox = await meshArtifact.boundingBox();
    const explanationBox = await meshExplanations.boundingBox();
    expect(explanationBox?.y ?? 0).toBeGreaterThan((artifactBox?.y ?? 0) + (artifactBox?.height ?? 0) - 1);
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(meshGuide).toBeVisible();
    await expect(meshGuide.locator("[data-mesh-note]")).toHaveCount(0);
    await expect(meshExplanations).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: /add mesh profile/i }).click();
    const originalMeshRow = page.getByRole("button", { name: new RegExp(`${bcName} mesh blockmesh`) });
    const variantMeshRow = page.getByRole("button", { name: new RegExp(`${bcName} mesh variant blockmesh`) });
    await expect(originalMeshRow).toBeVisible();

    await originalMeshRow.click();
    await expect(originalMeshRow).toContainText("loaded");
    await fillWrappedField(page, "Name", `${bcName} mesh variant`);
    await page.getByRole("button", { name: /save as new mesh profile/i }).click();
    await expect(variantMeshRow).toBeVisible();
    await expect(originalMeshRow).toBeVisible();
    await expect(page.getByRole("button", { name: /remove selected/i })).toHaveCount(0);
    await page.getByRole("button", { name: new RegExp(`^Remove ${escapeRegExp(`${bcName} mesh variant`)}$`) }).click();
    await expect(variantMeshRow).toHaveCount(0);
    await expect(originalMeshRow).toBeVisible();

    await page.getByRole("button", { name: /^Solver$/i }).click();
    await fillWrappedField(page, "Name", `${bcName} solver`);
    await page.getByRole("button", { name: /add solver profile/i }).click();

    await page.getByRole("button", { name: /^Scheduling$/i }).click();
    await fillWrappedField(page, "Name", `${bcName} scheduling`);
    await page.getByRole("button", { name: /add scheduling profile/i }).click();

    await page.getByRole("button", { name: /^Output$/i }).click();
    await fillWrappedField(page, "Name", `${bcName} output`);
    await page.getByRole("button", { name: /add output profile/i }).click();

    await page.getByRole("button", { name: /^Sweeps$/i }).click();
    await fillWrappedField(page, "Name", `${bcName} sweep`);
    await fillWrappedField(page, "AoA start", "-2");
    await fillWrappedField(page, "AoA stop", "6");
    await fillWrappedField(page, "AoA step", "2");
    await page.getByRole("button", { name: /add sweep definition/i }).click();

    await page.getByRole("button", { name: /^Presets$/i }).click();
    await expect(page.getByText("Draft changes are not saved automatically").first()).toBeVisible();
    await fillWrappedField(page, "Preset name", bcName);
    await fillWrappedField(page, "Slug optional", slugify(bcName));
    await selectWrappedField(page, "Flow state", `${bcName} flow`);
    await selectWrappedField(page, "Reference geometry", `${bcName} reference geometry`);
    await selectWrappedField(page, "Boundary profile", `${bcName} boundary`);
    await selectWrappedField(page, "Mesh profile", `${bcName} mesh`);
    await selectWrappedField(page, "Solver profile", `${bcName} solver`);
    await selectWrappedField(page, "Scheduling profile", `${bcName} scheduling`);
    await selectWrappedField(page, "Output profile", `${bcName} output`);
    await selectWrappedField(page, "Sweep definition", `${bcName} sweep`);
    await selectWrappedField(page, "Run scope", "airfoils");
    await page.getByTestId("preset-airfoil-search").fill("NACA 0012");
    await page.getByTestId("preset-airfoil-option-naca-0012").click();
    await expect(page.getByTestId("preset-airfoil-selected-count")).toContainText("1 selected");
    await selectWrappedField(page, "Enabled", "no");
    await page.getByRole("button", { name: /save new simulation preset/i }).click();

    await expect(page.getByRole("button", { name: new RegExp(bcName) })).toBeVisible();

    await page.getByRole("button", { name: /^Flow state$/i }).click();
    await page.getByRole("button", { name: new RegExp(`^(?!Remove )${escapeRegExp(`${bcName} flow`)}`) }).click();
    await selectUnit(page, "Speed", "m/s");
    await fillWrappedField(page, "Speed", "50");
    await expect(page.getByText(/0\.147/).last()).toBeVisible();
    await page.getByRole("button", { name: /update selected flow state/i }).click();

    await expect.poll(async () => (await listBoundaryConditions(request)).find((item) => item.slug === slugify(bcName))?.speedMps, {
      message: "boundary condition edit should persist",
    }).toBe(50);
    const saved = (await listBoundaryConditions(request)).find((item) => item.slug === slugify(bcName));
    expect(saved?.reynolds ?? 0).toBeGreaterThan(1_000_000);
    expect(saved?.mach ?? 0).toBeGreaterThan(0.14);
    expect(saved?.temperatureK ?? 0).toBeCloseTo(293.15, 2);
    expect(saved?.pressurePa ?? 0).toBeCloseTo(101325, 0);
    expect(saved?.referenceChordM ?? 0).toBeCloseTo(0.75, 4);
    const setup = await getSimulationSetup(request);
    const preset = setup.simulationPresets.find((item) => item.slug === slugify(bcName));
    expect(preset?.targetScope).toBe("airfoils");
    expect(preset?.targetAirfoilIds).toHaveLength(1);
  });

  test("admin hashtag editor creates, renames, and deletes hashtags", async ({ page }) => {
    const name = `${state.stamp} UI Tag`;
    const renamed = `${state.stamp} UI Tag Renamed`;
    await page.goto("/admin");
    await openCatalogTab(page, "hashtags");

    await page.getByTestId("new-hashtag-name").fill(name);
    await page.getByRole("button", { name: /add hashtag/i }).click();
    await expect(page.getByTestId(`hashtag-name-${slugify(name)}`)).toBeVisible();

    await page.getByTestId(`hashtag-name-${slugify(name)}`).fill(renamed);
    await page.getByRole("button", { name: /^save$/i }).last().click();
    await expect(page.getByTestId(`hashtag-name-${slugify(renamed)}`)).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /^delete$/i }).last().click();
    await expect(page.getByTestId(`hashtag-name-${slugify(renamed)}`)).toHaveCount(0);
  });
});
