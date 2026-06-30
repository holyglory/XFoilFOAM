import { describe, expect, it } from "vitest";

import { parseUnitNumber, siToUnit, unitToSi } from "../lib/unit-conversions";

describe("unit conversions", () => {
  it("converts temperature between K, Celsius, and Fahrenheit", () => {
    expect(siToUnit(273.15, "temperature", "C")).toBeCloseTo(0);
    expect(unitToSi(0, "temperature", "C")).toBeCloseTo(273.15);
    expect(siToUnit(273.15, "temperature", "F")).toBeCloseTo(32);
    expect(unitToSi(32, "temperature", "F")).toBeCloseTo(273.15);
  });

  it("converts length between meters and common display units", () => {
    expect(siToUnit(1, "length", "cm")).toBeCloseTo(100);
    expect(siToUnit(1, "length", "mm")).toBeCloseTo(1000);
    expect(unitToSi(12, "length", "in")).toBeCloseTo(0.3048);
    expect(unitToSi(1, "length", "ft")).toBeCloseTo(0.3048);
  });

  it("converts speed between m/s and common display units", () => {
    expect(siToUnit(10, "speed", "kmh")).toBeCloseTo(36);
    expect(unitToSi(36, "speed", "kmh")).toBeCloseTo(10);
    expect(unitToSi(10, "speed", "mph")).toBeCloseTo(4.4704);
    expect(unitToSi(10, "speed", "kt")).toBeCloseTo(5.14444444);
  });

  it("converts pressure between Pa and common display units", () => {
    expect(siToUnit(101325, "pressure", "kPa")).toBeCloseTo(101.325);
    expect(siToUnit(101325, "pressure", "bar")).toBeCloseTo(1.01325);
    expect(unitToSi(1, "pressure", "atm")).toBeCloseTo(101325);
    expect(unitToSi(14.6959488, "pressure", "psi")).toBeCloseTo(101325, 1);
  });

  it("parses decimal comma input", () => {
    expect(parseUnitNumber("288,15")).toBeCloseTo(288.15);
    expect(parseUnitNumber("101.325")).toBeCloseTo(101.325);
    expect(parseUnitNumber("")).toBeNull();
    expect(parseUnitNumber("not a number")).toBeNull();
  });
});
