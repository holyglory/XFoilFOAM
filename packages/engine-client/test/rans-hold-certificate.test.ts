import { describe, expect, it } from "vitest";

import {
  parseRansHoldCertificate,
  RANS_HOLD_CERTIFICATE_VERSION,
} from "../src/rans-hold-certificate";

function channel(mean: number) {
  const peakToPeak = Math.abs(mean) * 0.001;
  return {
    mean,
    min_value: mean - peakToPeak / 2,
    max_value: mean + peakToPeak / 2,
    peak_to_peak: peakToPeak,
    relative_spread: peakToPeak / (Math.abs(mean) + 0.001),
  };
}

function certificate() {
  return {
    reducer_version: RANS_HOLD_CERTIFICATE_VERSION,
    sample_count: 200,
    required_sample_count: 200,
    start_iteration: 801,
    end_iteration: 1000,
    relative_tolerance: 0.0025,
    absolute_floor: 0.001,
    certified: true,
    cl: channel(0.8),
    cd: channel(0.02),
    cm: channel(-0.03),
  };
}

describe("RANS all-channel hold certificate parser", () => {
  it("accepts an exact all-channel raw final-window proof", () => {
    const parsed = parseRansHoldCertificate(certificate());

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        reducer_version: RANS_HOLD_CERTIFICATE_VERSION,
        start_iteration: 801,
        end_iteration: 1000,
        certified: true,
      });
    }
  });

  it("fails closed when the moment channel exceeds the stamped hold tolerance", () => {
    const invalid = certificate();
    invalid.cm.relative_spread = 0.02;

    const parsed = parseRansHoldCertificate(invalid);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "rans_hold_certificate.cm.relative_spread: exceeds the stamped tolerance",
      );
    }
  });

  it("fails closed when a payload claims a non-exact final iteration window", () => {
    const invalid = certificate();
    invalid.end_iteration = 1001;

    const parsed = parseRansHoldCertificate(invalid);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "rans_hold_certificate: iteration window length must equal sample_count",
      );
    }
  });

  it("rejects extra keys instead of treating drifted proof as legacy", () => {
    const parsed = parseRansHoldCertificate({
      ...certificate(),
      legacy_fallback: true,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        'rans_hold_certificate: unexpected key "legacy_fallback" (contract drift)',
      );
    }
  });
});
