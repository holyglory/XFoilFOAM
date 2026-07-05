import { describe, expect, it } from "vitest";

import { isaAtmosphere, ISA_P0_PA, ISA_T0_K } from "../components/admin/campaigns/isa";

// Reference values from the ICAO Standard Atmosphere tables (Doc 7488) /
// US Standard Atmosphere 1976 — real-world checkpoints, not values derived
// from the implementation.
describe("isaAtmosphere", () => {
  it("reproduces sea level exactly", () => {
    const sl = isaAtmosphere(0);
    expect(sl.temperatureK).toBe(ISA_T0_K);
    expect(sl.pressurePa).toBe(ISA_P0_PA);
  });

  it("matches the ICAO table in the troposphere (5 000 m)", () => {
    const s = isaAtmosphere(5000);
    expect(s.temperatureK).toBeCloseTo(255.65, 2); // 288.15 − 6.5·5
    expect(s.pressurePa / 100).toBeCloseTo(540.48, 0); // 540.48 hPa ±0.5
  });

  it("matches the tropopause (11 000 m)", () => {
    const s = isaAtmosphere(11000);
    expect(s.temperatureK).toBeCloseTo(216.65, 2);
    expect(s.pressurePa / 100).toBeCloseTo(226.32, 0); // 226.32 hPa
  });

  it("is isothermal between 11 and 20 km with exponential pressure (15 000 m)", () => {
    const s = isaAtmosphere(15000);
    expect(s.temperatureK).toBeCloseTo(216.65, 2);
    expect(s.pressurePa / 100).toBeCloseTo(120.45, 0); // 120.45 hPa (USSA 1976, geopotential)
  });

  it("applies the +1 K/km inversion above 20 km (25 000 m)", () => {
    const s = isaAtmosphere(25000);
    expect(s.temperatureK).toBeCloseTo(221.65, 2); // 216.65 + 1.0·5
    expect(s.pressurePa / 100).toBeCloseTo(25.11, 1); // 25.11 hPa (USSA 1976, geopotential)
  });

  it("handles below-sea-level altitudes on the tropospheric gradient (−500 m)", () => {
    const s = isaAtmosphere(-500);
    expect(s.temperatureK).toBeCloseTo(291.4, 2); // 288.15 + 6.5·0.5
    expect(s.pressurePa).toBeCloseTo(107477, -2); // ≈1074.8 hPa
  });

  it("rejects unsupported altitudes instead of extrapolating", () => {
    expect(() => isaAtmosphere(60000)).toThrow(/supports/);
    expect(() => isaAtmosphere(-6000)).toThrow(/supports/);
    expect(() => isaAtmosphere(Number.NaN)).toThrow(/finite/);
  });
});
