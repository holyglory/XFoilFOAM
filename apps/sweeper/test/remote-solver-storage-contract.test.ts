import { afterEach, describe, expect, it } from "vitest";

import {
  assertRemoteSolverHubUrlContract,
  assertRemoteSolverNodeEvidenceContract,
  configuredBuildVersion,
  configuredDeploymentRole,
} from "../src/config";

const savedBucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
const savedRemoteOnly = process.env.AIRFOILFOAM_EVIDENCE_REMOTE_ONLY;
const savedControlPlaneToken = process.env.ENGINE_CONTROL_PLANE_TOKEN;
const savedDeploymentRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;

afterEach(() => {
  if (savedBucket === undefined) delete process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
  else process.env.AIRFOILFOAM_EVIDENCE_BUCKET = savedBucket;
  if (savedRemoteOnly === undefined)
    delete process.env.AIRFOILFOAM_EVIDENCE_REMOTE_ONLY;
  else process.env.AIRFOILFOAM_EVIDENCE_REMOTE_ONLY = savedRemoteOnly;
  if (savedControlPlaneToken === undefined)
    delete process.env.ENGINE_CONTROL_PLANE_TOKEN;
  else process.env.ENGINE_CONTROL_PLANE_TOKEN = savedControlPlaneToken;
  if (savedDeploymentRole === undefined)
    delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
  else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = savedDeploymentRole;
});

describe("credentialless remote-solver evidence storage contract", () => {
  it("accepts local tar.zst retention for hub-brokered upload", () => {
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
    process.env.AIRFOILFOAM_EVIDENCE_BUCKET = "";
    process.env.AIRFOILFOAM_EVIDENCE_REMOTE_ONLY = "false";
    process.env.ENGINE_CONTROL_PLANE_TOKEN =
      "remote-storage-contract-control-plane-token";

    expect(() => assertRemoteSolverNodeEvidenceContract(true)).not.toThrow();
  });

  it.each([
    ["airfoils-pro-storage-bucket", "false"],
    ["", "true"],
    ["airfoils-pro-storage-bucket", "true"],
  ])(
    "fails closed when remote mode has engine bucket %j and remote-only %j",
    (bucket, remoteOnly) => {
      process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = bucket;
      process.env.AIRFOILFOAM_EVIDENCE_REMOTE_ONLY = remoteOnly;

      expect(() => assertRemoteSolverNodeEvidenceContract(true)).toThrow(
        /local tar\.zst survives for hub-brokered upload/,
      );
    },
  );

  it("keeps the hub GCS contract when the hub enables remote solvers", () => {
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
    process.env.AIRFOILFOAM_EVIDENCE_BUCKET = "airfoils-pro-storage-bucket";
    process.env.AIRFOILFOAM_EVIDENCE_REMOTE_ONLY = "true";

    expect(() => assertRemoteSolverNodeEvidenceContract(true)).not.toThrow();
  });

  it("rejects an invalid deployment role instead of guessing its evidence mode", () => {
    expect(() =>
      configuredDeploymentRole({ AIRFOILFOAM_DEPLOYMENT_ROLE: "worker" }),
    ).toThrow(/must be hub or remote-solver/);
  });
});

describe("remote solver hub URL startup contract", () => {
  it.each([
    "https://hub.example.test/api/sync/v1",
    "http://localhost:3000/api/sync/v1",
    "http://127.0.0.1/api/sync/v1",
    "http://[::1]/api/sync/v1",
  ])("accepts a safe stored endpoint %s", (url) => {
    expect(assertRemoteSolverHubUrlContract(url)).toBe(url);
  });

  it.each([
    "http://hub.example.test/api/sync/v1",
    "https://user:password@hub.example.test/api/sync/v1",
    "https://hub.example.test/api/sync/v1?token=x",
    "https://hub.example.test/api/sync/v1#fragment",
    "https://hub.example.test/api/sync/v1/",
  ])("fails startup closed for unsafe stored endpoint %s", (url) => {
    expect(() => assertRemoteSolverHubUrlContract(url)).toThrow();
  });
});

describe("remote solver build identity", () => {
  it("reports the current deployment build instead of the registration-era value", () => {
    expect(
      configuredBuildVersion({
        AIRFOILFOAM_BUILD_ID: " hz-solver2-current-v12 ",
        npm_package_version: "0.1.0",
      }),
    ).toBe("hz-solver2-current-v12");
  });

  it("uses package provenance only when no deployment build is configured", () => {
    expect(configuredBuildVersion({ npm_package_version: " 0.1.0 " })).toBe(
      "0.1.0",
    );
    expect(configuredBuildVersion({})).toBeNull();
  });
});
