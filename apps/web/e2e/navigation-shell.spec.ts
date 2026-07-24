// Responsive navigation regression.
//
// MUST-CATCH: the public tabs and admin sections previously became horizontal
// scroll strips on narrow screens, and /admin rendered the public navigation
// above the admin navigation. These checks require one route-owned menu, prove
// the burger interactions, and reject document or navigation-shell overflow.

import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page) {
  const geometry = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const topbar = document.querySelector<HTMLElement>(".topbar-shell");
    const adminNav = document.querySelector<HTMLElement>(".admin-nav-column");
    return {
      document: {
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
      },
      topbar: topbar
        ? { clientWidth: topbar.clientWidth, scrollWidth: topbar.scrollWidth }
        : null,
      adminNav: adminNav
        ? {
            clientWidth: adminNav.clientWidth,
            scrollWidth: adminNav.scrollWidth,
          }
        : null,
    };
  });

  expect(geometry.document.scrollWidth).toBeLessThanOrEqual(
    geometry.document.clientWidth,
  );
  expect(geometry.topbar?.scrollWidth).toBeLessThanOrEqual(
    geometry.topbar?.clientWidth ?? 0,
  );
  if (geometry.adminNav) {
    expect(geometry.adminNav.scrollWidth).toBeLessThanOrEqual(
      geometry.adminNav.clientWidth,
    );
  }
}

test.describe("route-owned responsive navigation", () => {
  test("public pages use a working burger without horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 653, height: 921 });
    await page.goto("/");

    const trigger = page.getByTestId("public-nav-menu-button");
    await expect(trigger).toBeVisible();
    await expect(page.locator(".topbar-tabs")).toBeHidden();
    await expectNoHorizontalOverflow(page);

    await trigger.click();
    const menu = page.getByRole("navigation", { name: "Public navigation" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { name: "Browse" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Search" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Detail" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Compare" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("admin pages hide public navigation and use the admin burger", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 653, height: 921 });
    await page.goto("/admin?section=health");

    await expect(
      page.locator('.topbar-shell[data-surface="admin"]'),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Public navigation" }),
    ).toHaveCount(0);

    const trigger = page.getByTestId("admin-nav-menu-button");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("Health");
    await expectNoHorizontalOverflow(page);

    await trigger.click();
    const menu = page.getByRole("navigation", { name: "Admin navigation" });
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("admin-nav-simulations")).toBeVisible();
    await expect(menu.getByTestId("admin-nav-queue")).toBeVisible();
    await expect(menu.getByTestId("admin-nav-health")).toBeVisible();
    await expect(menu.getByTestId("admin-nav-setup")).toBeVisible();
    await expect(menu.getByTestId("admin-nav-catalog")).toBeVisible();
    await expect(menu.getByTestId("admin-nav-sync")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await menu.getByTestId("admin-nav-queue").click();
    await expect(page).toHaveURL(/\?section=queue$/);
    await expect(menu).toBeHidden();
    await expect(trigger).toContainText("Solver");
  });

  test("desktop admin keeps the sidebar but still omits public tabs", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/admin");

    await expect(page.getByTestId("admin-nav-menu-button")).toBeHidden();
    await expect(
      page.getByRole("navigation", { name: "Admin navigation" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Public navigation" }),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});
