import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { evaluateGasState } from "../../packages/core/src/gas-state";
import { sourceAirModel } from "../../packages/core/test/fixtures/source-air-model";
import { originFromDeployment } from "./progressive-preview-origin.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const deployment = JSON.parse(
  execFileSync(
    "/usr/local/bin/devcoordinator2",
    [
      "deployment",
      "status",
      root,
      "--name",
      "progressive-preview",
      "--client",
      "codex",
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 },
  ),
);
const origin = originFromDeployment(deployment);
const apis = deployment.data.components.filter(
  (component: { name: string }) => component.name === "api",
);
assert(
  apis.length === 1 && apis[0].owned === true && apis[0].state === "running",
);
assert(
  Number.isInteger(apis[0].port) &&
    apis[0].port >= 1024 &&
    apis[0].port <= 65535,
);
const api = `http://127.0.0.1:${apis[0].port}`;
const browser = await chromium.launch({ headless: true });
const outcomes = [];

try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const ownedIds = new Set<string>();
    const errors: string[] = [];
    const apiOrigins = new Set<string>();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const requested = new URL(request.url());
      if (requested.pathname.startsWith("/api/"))
        apiOrigins.add(requested.origin);
    });
    try {
      const gas = sourceAirModel();
      const reference = evaluateGasState(gas, 288.15, 101325);
      const name = `Material check ${viewport.width} ${randomUUID()}`;
      const seeded = await page.request.post(`${api}/api/admin/mediums`, {
        data: {
          name,
          phase: "gas",
          density: reference.density,
          refTemperatureK: 288.15,
          refPressurePa: 101325,
          viscosityModel: "constant",
          constantDynamicViscosity: reference.dynamicViscosity,
          speedOfSound: reference.speedOfSound,
          gasThermodynamics: gas,
          notes:
            "Isolated rendered lifecycle verification; removed after the check",
        },
      });
      assert.equal(seeded.status(), 201, await seeded.text());
      const original = await seeded.json();
      ownedIds.add(original.id);
      await page.goto(`${origin}/admin?section=setup&tab=mediums`, {
        waitUntil: "domcontentloaded",
      });
      const materials = page.getByTestId("medium-materials");
      const editor = page.getByRole("dialog", { name: "Medium editor" });
      const item = (label: string) =>
        materials.locator("button[aria-pressed]").filter({ hasText: label });
      await expect(item(name)).toBeVisible();
      await expect(editor).not.toBeVisible();
      await item(name).click();
      await expect(editor).toBeVisible();
      const nameInput = editor.locator('[data-admin-field="Name"] input');
      await expect(nameInput).toBeFocused();
      await expect(editor.getByLabel("Use selected gas model")).toBeChecked();
      const bounds = await editor.boundingBox();
      assert(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= viewport.width + 1 &&
          bounds.y + bounds.height <= viewport.height + 1,
        JSON.stringify({ viewport, bounds }),
      );
      await editor
        .getByText("Model source and temperature range", { exact: true })
        .click();
      await expect(
        editor.getByText("100–2000 K · Temperature-dependent heat capacity"),
      ).toBeVisible();
      await editor
        .getByText("Model source and temperature range", { exact: true })
        .click();

      await nameInput.fill(`${name} discarded`);
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(editor).not.toBeVisible();
      await item(name).click();
      await expect(nameInput).toHaveValue(name);
      await page.keyboard.press("Escape");
      await expect(editor).not.toBeVisible();
      await item(name).click();
      const copyName = `${name} copy`;
      await nameInput.fill(copyName);
      const createResponse = page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/admin/mediums` &&
          response.request().method() === "POST",
      );
      await editor
        .getByRole("button", { name: "save as new medium", exact: true })
        .click();
      const saved = await createResponse;
      assert.equal(saved.status(), 201, await saved.text());
      const copy = await saved.json();
      ownedIds.add(copy.id);
      assert.deepEqual(copy.gasThermodynamics, gas);
      await expect(editor).not.toBeVisible();
      await expect(item(copyName)).toHaveAttribute("aria-pressed", "true");
      await page.reload({ waitUntil: "domcontentloaded" });
      await item(copyName).click();
      await expect(editor.getByLabel("Use selected gas model")).toBeChecked();
      await editor
        .locator('[data-admin-field="Phase"] select')
        .selectOption("liquid");
      const rejectedResponse = page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/admin/mediums/${copy.id}` &&
          response.request().method() === "PATCH",
      );
      await editor
        .getByRole("button", { name: "update selected medium", exact: true })
        .click();
      const rejected = await rejectedResponse;
      assert.equal(rejected.status(), 400);
      await expect(editor.getByText(/requires the gas phase/)).toBeVisible();
      await editor
        .locator('[data-admin-field="Phase"] select')
        .selectOption("gas");
      await editor.getByLabel("Use selected gas model").uncheck();
      const clearedResponse = page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/admin/mediums/${copy.id}` &&
          response.request().method() === "PATCH",
      );
      await editor
        .getByRole("button", { name: "update selected medium", exact: true })
        .click();
      const cleared = await clearedResponse;
      assert.equal(cleared.status(), 200, await cleared.text());
      assert.equal((await cleared.json()).gasThermodynamics, null);
      await expect(editor).not.toBeVisible();
      await page.reload({ waitUntil: "domcontentloaded" });
      await item(copyName).click();
      await expect(editor.getByLabel("Use selected gas model")).toHaveCount(0);
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      page.once("dialog", (dialog) => dialog.dismiss());
      await materials
        .getByRole("button", { name: `Remove ${copyName}`, exact: true })
        .click();
      await expect(item(copyName)).toHaveCount(1);
      page.once("dialog", (dialog) => dialog.accept());
      const removedResponse = page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/mediums/${copy.id}` &&
          response.request().method() === "DELETE",
      );
      await materials
        .getByRole("button", { name: `Remove ${copyName}`, exact: true })
        .click();
      assert.equal((await removedResponse).status(), 204);
      ownedIds.delete(copy.id);
      await expect(item(copyName)).toHaveCount(0);
      await materials.getByRole("button", { name: "New", exact: true }).click();
      await expect(editor).toBeVisible();
      await expect(nameInput).toBeFocused();
      await expect(
        editor.getByRole("button", { name: "add medium", exact: true }),
      ).toBeVisible();
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      const originals = await (
        await page.request.get(`${api}/api/admin/mediums`)
      ).json();
      assert.deepEqual(
        originals.items.find(
          (entry: { id: string }) => entry.id === original.id,
        ).gasThermodynamics,
        gas,
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(
        [...apiOrigins],
        [origin],
        "Browser API requests must use the preview origin, not a visitor's localhost service",
      );
      outcomes.push({
        viewport,
        copiedModelPreserved: true,
        explicitClearPersisted: true,
        rejectedChangeUnwritten: true,
        cancellationUnwritten: true,
        explicitRemoval: true,
        newEditorFocused: true,
        dialogBounds: bounds,
      });
    } finally {
      const cleanupErrors = [];
      for (const id of ownedIds) {
        const response = await page.request.delete(`${api}/api/mediums/${id}`);
        if (![204, 404].includes(response.status()))
          cleanupErrors.push({ id, status: response.status() });
      }
      await page.close();
      assert.deepEqual(
        cleanupErrors,
        [],
        "Owned material fixtures must be removed",
      );
    }
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ kind: "rendered-material-lifecycle", outcomes }));
