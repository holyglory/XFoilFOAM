export const REMOTE_HUB_SYNC_PATH = "/api/sync/v1";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function rawAuthorityHostname(authority: string): string | null {
  if (authority.startsWith("[")) {
    const match = authority.match(/^\[([^\]]+)\](?::\d+)?$/);
    return match?.[1]?.toLowerCase() ?? null;
  }
  const match = authority.match(/^([^:]+)(?::\d+)?$/);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Parse and canonicalize the one trusted remote-hub authority.
 *
 * Remote solver credentials and sync secrets are bearer credentials. They may
 * only travel to HTTPS hubs, except for the three literal loopback hostnames
 * used by local development and tests. The path is deliberately exact so a
 * stored URL cannot smuggle a different endpoint through dot segments,
 * encoding, a query, a fragment, or a trailing path.
 */
export function canonicalRemoteHubBaseUrl(value: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error("remote hub URL must be a canonical absolute URL");
  }

  const lexical = value.match(/^(https?):\/\/([^/?#]+)(\/api\/sync\/v1)$/i);
  if (!lexical) {
    throw new Error(
      `remote hub URL must end at the exact ${REMOTE_HUB_SYNC_PATH} path without credentials, query, fragment, or trailing path`,
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("remote hub URL must be a valid absolute URL");
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== REMOTE_HUB_SYNC_PATH
  ) {
    throw new Error(
      `remote hub URL must end at the exact ${REMOTE_HUB_SYNC_PATH} path without credentials, query, fragment, or trailing path`,
    );
  }

  const rawHostname = rawAuthorityHostname(lexical[2]!);
  const loopback = rawHostname != null && LOOPBACK_HOSTNAMES.has(rawHostname);
  if (url.protocol === "http:") {
    if (!loopback) {
      throw new Error(
        "remote hub URL must use HTTPS; HTTP is allowed only for literal localhost, 127.0.0.1, or ::1",
      );
    }
  } else if (url.protocol !== "https:") {
    throw new Error("remote hub URL must use HTTPS");
  }

  return `${url.origin}${REMOTE_HUB_SYNC_PATH}`;
}

export function isCanonicalRemoteHubBaseUrl(value: string): boolean {
  try {
    canonicalRemoteHubBaseUrl(value);
    return true;
  } catch {
    return false;
  }
}
