import {
  canonicalRemoteHubBaseUrl,
  isCanonicalRemoteHubBaseUrl,
} from "../src/remote-hub-url";
import { describe, expect, it } from "vitest";

describe("canonicalRemoteHubBaseUrl", () => {
  it.each([
    ["https://hub.example/api/sync/v1", "https://hub.example/api/sync/v1"],
    ["HTTPS://HUB.EXAMPLE:443/api/sync/v1", "https://hub.example/api/sync/v1"],
    [
      "https://hub.example:8443/api/sync/v1",
      "https://hub.example:8443/api/sync/v1",
    ],
    ["http://localhost:3000/api/sync/v1", "http://localhost:3000/api/sync/v1"],
    ["http://127.0.0.1/api/sync/v1", "http://127.0.0.1/api/sync/v1"],
    ["http://[::1]/api/sync/v1", "http://[::1]/api/sync/v1"],
  ])("accepts the trusted endpoint %s", (input, expected) => {
    expect(canonicalRemoteHubBaseUrl(input)).toBe(expected);
    expect(isCanonicalRemoteHubBaseUrl(input)).toBe(true);
  });

  it.each([
    "http://hub.example/api/sync/v1",
    "http://localhost.example/api/sync/v1",
    "http://127.0.0.2/api/sync/v1",
    "http://127.1/api/sync/v1",
    "http://[::2]/api/sync/v1",
    "ftp://hub.example/api/sync/v1",
    "https://user@hub.example/api/sync/v1",
    "https://user:password@hub.example/api/sync/v1",
    "https://hub.example/api/sync/v1?token=x",
    "https://hub.example/api/sync/v1?",
    "https://hub.example/api/sync/v1#fragment",
    "https://hub.example/api/sync/v1#",
    "https://hub.example/api/sync/v1/",
    "https://hub.example/api/sync/v1/claim",
    "https://hub.example/api/sync/../sync/v1",
    "https://hub.example/api/sync/%76%31",
    " https://hub.example/api/sync/v1",
    "https://hub.example/api/sync/v1 ",
    "hub.example/api/sync/v1",
  ])("rejects an unsafe or ambiguous endpoint %s", (input) => {
    expect(() => canonicalRemoteHubBaseUrl(input)).toThrow();
    expect(isCanonicalRemoteHubBaseUrl(input)).toBe(false);
  });
});
