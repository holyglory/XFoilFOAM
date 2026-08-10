import { describe, expect, it } from "vitest";

import {
  NO_SHEDDING_CERTIFICATE_VERSION,
  NO_SHEDDING_MIN_SAMPLE_COUNT,
  parseNoSheddingCertificate,
} from "../src/no-shedding-certificate";

function certificate() {
  return {
    reducer_version: NO_SHEDDING_CERTIFICATE_VERSION,
    certified: true,
    required_observation_s: 4.2,
    observation_start_time: 1.8,
    observation_end_time: 6,
    observed_observation_s: 4.2,
    source_sample_count: 401,
    transport_sample_count: 400,
    relative_tolerance: 0.005,
    absolute_floor: 0.001,
    cl_mean: 0.0006,
    cd_mean: 0.012,
    cm_mean: -0.0002,
    cl_rms: 0.0001,
    cd_rms: 0.00002,
    cm_rms: 0.00001,
    transport_cl_mean: 0.00059,
    transport_cd_mean: 0.01201,
    transport_cm_mean: -0.00019,
    transport_cl_rms: 0.00012,
    transport_cd_rms: 0.00003,
    transport_cm_rms: 0.00002,
  };
}

describe("no-shedding URANS observation certificate parser", () => {
  it("accepts a complete slow-wake physical observation proof", () => {
    const parsed = parseNoSheddingCertificate(certificate());

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        reducer_version: NO_SHEDDING_CERTIFICATE_VERSION,
        certified: true,
        observed_observation_s: 4.2,
      });
    }
  });

  it("fails closed when an apparently flat run is shorter than the slow-wake horizon", () => {
    const invalid = certificate();
    invalid.observed_observation_s = 4.1;

    const parsed = parseNoSheddingCertificate(invalid);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "no_shedding_certificate.observed_observation_s: does not match the observation time window",
      );
      expect(parsed.errors).toContain(
        "no_shedding_certificate: observation is below the physical slow-shedding horizon",
      );
    }
  });

  it("rejects an amplitude verdict that conflicts with its own raw statistics", () => {
    const invalid = certificate();
    invalid.cl_rms = 0.1;

    const parsed = parseNoSheddingCertificate(invalid);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "no_shedding_certificate.cl_rms: exceeds its stamped amplitude tolerance",
      );
    }
  });

  it("rejects sparse raw and transported witnesses", () => {
    const invalid = {
      ...certificate(),
      source_sample_count: 2,
      transport_sample_count: 2,
    };

    const parsed = parseNoSheddingCertificate(invalid);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        `no_shedding_certificate.source_sample_count: expected integer >= ${NO_SHEDDING_MIN_SAMPLE_COUNT}`,
      );
      expect(parsed.errors).toContain(
        `no_shedding_certificate.transport_sample_count: expected integer >= ${NO_SHEDDING_MIN_SAMPLE_COUNT}`,
      );
    }
  });

  it("rejects a noisy moment channel even when lift and drag are quiet", () => {
    const invalid = {
      ...certificate(),
      cm_mean: -0.0002,
      cm_rms: 0.01,
    };

    const parsed = parseNoSheddingCertificate(invalid);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "no_shedding_certificate.cm_rms: exceeds its stamped amplitude tolerance",
      );
    }
  });

  it("requires finite, non-negative bounded transport statistics", () => {
    const invalid = {
      ...certificate(),
      transport_cl_mean: Number.NaN,
      transport_cd_rms: -0.001,
    };

    const parsed = parseNoSheddingCertificate(invalid);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "no_shedding_certificate.transport_cl_mean: expected finite number",
      );
      expect(parsed.errors).toContain(
        "no_shedding_certificate.transport_cd_rms: expected non-negative number",
      );
    }
  });

  it("keeps a finite transport witness distinct from the raw verdict", () => {
    const witness = {
      ...certificate(),
      // The transport is a lossy bounded projection and is checked against the
      // supplied force history by the control plane. The parser owns only the
      // versioned wire shape, so it must not silently substitute raw values.
      transport_cl_mean: 0.0011,
      transport_cl_rms: 0.0007,
      transport_cd_mean: 0.0118,
      transport_cd_rms: 0.0004,
      transport_cm_mean: -0.0009,
      transport_cm_rms: 0.0003,
    };

    const parsed = parseNoSheddingCertificate(witness);

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value.transport_cl_mean).toBe(witness.transport_cl_mean);
      expect(parsed.value.transport_cl_mean).not.toBe(parsed.value.cl_mean);
    }
  });

  it("rejects drifted extra fields instead of reclassifying them as legacy evidence", () => {
    const parsed = parseNoSheddingCertificate({
      ...certificate(),
      inferred: true,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        'no_shedding_certificate: unexpected key "inferred" (contract drift)',
      );
    }
  });
});
