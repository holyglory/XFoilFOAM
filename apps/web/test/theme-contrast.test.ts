import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { VIZ } from "../lib/tokens";

const css = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const light = css.match(/\[data-theme="light"\]\s*\{([^}]+)\}/)![1];
const token = (name: string) =>
  light.match(new RegExp(`--aero-${name}:\\s*(#[a-f0-9]{6});`))![1];
const channels = (hex: string) =>
  [1, 3, 5].map(
    (start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255,
  );
const luminance = (values: number[]) =>
  values
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    )
    .reduce(
      (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
      0,
    );
const contrast = (foreground: number[], background: number[]) => {
  const values = [luminance(foreground), luminance(background)].sort(
    (left, right) => left - right,
  );
  return (values[1] + 0.05) / (values[0] + 0.05);
};

it("keeps light-theme actions and warning labels readable on their real surfaces", () => {
  for (const name of ["teal", "amber"]) {
    for (const surface of ["bg", "panel", "panel2", "panel3"]) {
      expect(
        contrast(channels(token(name)), channels(token(surface))),
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(
    contrast(channels(token("teal-ink")), channels(token("teal"))),
  ).toBeGreaterThanOrEqual(4.5);
  const tint = channels(token("panel")).map(
    (channel, index) => 0.9 * channel + (0.1 * [13, 148, 136][index]) / 255,
  );
  expect(contrast(channels(token("teal")), tint)).toBeGreaterThanOrEqual(4.5);
});

it("detects the original low-contrast pairs without rejecting black on white", () => {
  expect(contrast(channels("#0d9488"), channels("#ffffff"))).toBeLessThan(4.5);
  expect(contrast(channels("#bb7a0c"), channels("#ffffff"))).toBeLessThan(4.5);
  expect(contrast(channels("#000000"), channels("#ffffff"))).toBe(21);
});

it("keeps evidence captions and stored track scales readable in both themes", () => {
  const dark = css.match(/\[data-theme="dark"\]\s*\{([^}]+)\}/)![1];
  for (const theme of [dark, light]) {
    const color = (name: string) =>
      channels(
        theme.match(new RegExp(`--aero-${name}:\\s*(#[a-f0-9]{6});`))![1],
      );
    expect(contrast(color("muted"), color("panel2"))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(color("dim"), color("panel2"))).toBeLessThan(4.5);
  }
  expect(contrast(channels(VIZ.text), channels(VIZ.bg))).toBeGreaterThanOrEqual(
    4.5,
  );
  expect(contrast(channels(token("muted")), channels(VIZ.bg))).toBeLessThan(
    4.5,
  );
  const modal = readFileSync(
    new URL("../components/detail/SimModal.tsx", import.meta.url),
    "utf8",
  );
  for (const id of ["sim-active-scale", "sim-coefficient-caption"]) {
    expect(
      modal.slice(modal.indexOf(`data-testid="${id}"`)).split("</")[0],
    ).toContain("color: C.muted");
  }
});
