import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { gzip } from "node:zlib";

process.env.NODE_ENV ??= "production";
const { default: next } = await import("next");
const { values } = parseArgs({
  options: {
    hostname: { type: "string", default: "0.0.0.0" },
    port: { type: "string", default: "3100" },
  },
});
const port = Number(values.port);
const app = next({ dev: false, hostname: values.hostname, port });
await app.prepare();
const buildId = readFileSync(
  join(process.env.NEXT_DIST_DIR ?? ".next", "BUILD_ID"),
  "utf8",
).trim();
if (!/^[a-f0-9]{64}$/.test(buildId))
  throw new Error("Missing the compiled web source identity.");
const handle = app.getRequestHandler();
const compress = promisify(gzip);
const dist = process.env.NEXT_DIST_DIR ?? ".next";
const campaignRoute = "/admin-page/campaign";
// Only the compiled, identity-free document can use this path. Its client
// fetches the current admin and campaign through the usual protected API.
// If the route ever becomes dynamic, let Next render the request normally.
let campaignDocument;
try {
  const manifest = JSON.parse(
    readFileSync(join(dist, "prerender-manifest.json"), "utf8"),
  );
  if (manifest.routes?.[campaignRoute]?.initialRevalidateSeconds === false) {
    const body = readFileSync(
      join(dist, "server", "app", "admin-page", "campaign.html"),
    );
    campaignDocument = { body, gzip: await compress(body) };
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const refreshId = randomUUID();
const freshMs = 5_000;
const maxAgeMs = 60_000;
const vary = [
  "accept-encoding",
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-url",
];
let cached;
let pending;
let retryAt = 0;

// Read one ordinary anonymous HTML response from this build. Next retains
// ownership of server rendering, regeneration, API routes and Flight requests.
async function refresh() {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    headers: {
      accept: "text/html",
      "accept-encoding": "identity",
      "x-airfoils-page-refresh": refreshId,
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const control = response.headers.get("cache-control") ?? "";
  const varies = (response.headers.get("vary") ?? "")
    .toLowerCase()
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const length = Number(response.headers.get("content-length"));
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.startsWith("text/html") ||
    response.headers.has("set-cookie") ||
    !/\b(?:public|s-maxage)\b/i.test(control) ||
    /\b(?:no-store|private)\b/i.test(control) ||
    varies.some((key) => !vary.includes(key)) ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > 2 * 1024 * 1024
  ) {
    await response.body?.cancel();
    throw new Error(
      "The unfiltered catalog did not return a cacheable, bounded public document.",
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== length) throw new Error("Incomplete catalog document.");
  const compressed = await compress(body);
  const headers = Object.fromEntries(response.headers);
  for (const key of [
    "connection",
    "keep-alive",
    "date",
    "age",
    "transfer-encoding",
    "content-length",
    "content-encoding",
    "x-nextjs-cache",
  ])
    delete headers[key];
  headers.etag = `W/"${createHash("sha256").update(body).digest("hex")}"`;
  headers.vary = [
    ...new Set([...varies, "accept-encoding", "cookie", "authorization"]),
  ].join(", ");
  cached = { body, compressed, headers, at: Date.now() };
}

function refreshOnce() {
  if (!pending && Date.now() >= retryAt) {
    pending = refresh()
      .catch((error) => {
        retryAt = Date.now() + freshMs;
        console.warn("[catalog]", error.message);
      })
      .finally(() => {
        pending = undefined;
      });
  }
  return pending;
}

function acceptedEncoding(value = "") {
  const choices = new Map(
    value
      .toLowerCase()
      .split(",")
      .map((entry) => {
        const [name, q] = entry.trim().split(/\s*;\s*q=/);
        return [name, q === undefined ? 1 : Number(q)];
      }),
  );
  const gz = choices.get("gzip") ?? choices.get("*") ?? 0;
  const identity = choices.get("identity") ?? (choices.get("*") === 0 ? 0 : 1);
  return gz > 0 && gz >= identity ? "gzip" : identity > 0 ? "identity" : null;
}

async function serve(req, res) {
  res.setHeader("x-ui-source-revision", buildId);
  const h = req.headers;
  const documentRequest =
    (req.method === "GET" || req.method === "HEAD") &&
    h["x-airfoils-page-refresh"] !== refreshId &&
    !h.range &&
    !h["next-action"] &&
    !h["x-nextjs-data"] &&
    !h["x-middleware-prefetch"] &&
    !h["if-match"] &&
    !h["if-unmodified-since"] &&
    !h["if-modified-since"] &&
    !vary.slice(1).some((key) => key in h) &&
    (!h.accept || /text\/html|\*\/\*/i.test(h.accept));
  const encoding = documentRequest && acceptedEncoding(h["accept-encoding"]);
  if (
    encoding &&
    campaignDocument &&
    req.url?.startsWith("/admin?") &&
    !h["if-none-match"]
  ) {
    const url = new URL(req.url, "http://localhost");
    const campaign = url.searchParams.get("campaign");
    if (
      url.pathname === "/admin" &&
      url.searchParams.size === 1 &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(campaign ?? "")
    ) {
      const body =
        encoding === "gzip" ? campaignDocument.gzip : campaignDocument.body;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "private, no-store");
      res.setHeader("vary", vary.join(", "));
      res.setHeader("content-length", body.length);
      if (encoding === "gzip") res.setHeader("content-encoding", "gzip");
      return res.end(req.method === "HEAD" ? undefined : body);
    }
  }
  if (encoding && req.url === "/" && !h.cookie && !h.authorization) {
    if (!cached || Date.now() - cached.at > maxAgeMs) await refreshOnce();
    const entry = cached;
    if (entry && Date.now() - entry.at <= maxAgeMs) {
      if (Date.now() - entry.at >= freshMs) void refreshOnce();
      const body = encoding === "gzip" ? entry.compressed : entry.body;
      for (const [key, value] of Object.entries(entry.headers))
        res.setHeader(key, value);
      res.setHeader("age", Math.floor((Date.now() - entry.at) / 1_000));
      if (
        h["if-none-match"]
          ?.split(/\s*,\s*/)
          .some(
            (tag) =>
              tag === "*" ||
              tag.replace(/^W\//, "") ===
                entry.headers.etag.replace(/^W\//, ""),
          )
      ) {
        res.writeHead(304);
        return res.end();
      }
      res.setHeader("content-length", body.length);
      if (encoding === "gzip") res.setHeader("content-encoding", "gzip");
      return res.end(req.method === "HEAD" ? undefined : body);
    }
  }
  return handle(req, res);
}

const server = createServer((req, res) => {
  serve(req, res).catch((error) => {
    console.error("[web]", error.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.on("upgrade", app.getUpgradeHandler());
server.listen(port, values.hostname, () => {
  void refreshOnce();
  // A quiet catalog still has a recent document ready for the next visitor.
  // Active traffic already refreshes it more frequently through the request path.
  const idleRefreshMs = Math.floor(maxAgeMs / 2);
  const timer = setInterval(() => {
    if (!cached || Date.now() - cached.at >= idleRefreshMs - freshMs)
      void refreshOnce();
  }, idleRefreshMs);
  timer.unref();
  server.once("close", () => clearInterval(timer));
});
