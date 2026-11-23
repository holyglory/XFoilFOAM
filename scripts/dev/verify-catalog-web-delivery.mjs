/**
 * catalog-web-delivery/local retains a fresh observation of this checkout's
 * named catalog-paging deployment plus the validated formal, manual and
 * Product Design receipts. catalog-web-delivery/handoff adds the external
 * operator's rollout and the independent public HTTP and rendered evidence.
 *
 * Stage a private .codex-artifacts/catalog-delivery-inputs.json with paths
 * relative to that file or absolute: formalWorktree, manualReview,
 * productDesignReceipt, vpsHttpDirectory, vpsDeploymentReceipt. Also set
 * formalRun to the governed layout run ID and productDesignReceiptId to the
 * actual audit ID. Optional releaseWorktree identifies the promoted checkout
 * when it differs from formalWorktree. Its compiled UI digest must match.
 *
 * "reviews" validates and retains the upstream originals. Once the reviewed
 * application is live, the operator runs "capture-vps" with a new output
 * directory. The final check consumes the supplied deployment JSON object
 * under the "deployment" key. Copy the actual bindings from reviews.json
 * (formalRunId, candidateId, sourceSha256, artifactManifestSha256,
 * manualReceiptId, productDesignReceiptId). Supply result, liveRoute,
 * httpStatus, contentType, deployedAt, uiBuild, sourceRevision,
 * repositorySourceSha256, deploymentId, imageDigest and httpArtifactSha256.
 * provenance is {file,sha256} for the real operator record with its rollout,
 * revision and image IDs. Each renderedEvidence entry has file, sha256, url,
 * uiBuild and capturedAt for the actual public browser screenshot.
 *
 * Never substitute the public rollout ID for the owned local generation in
 * delivery.json. The parent submits the retained artifact to the Coordinator.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { webSourceIdentity } from "../../apps/web/source-identity.mjs";
import { originFromDeployment } from "./progressive-preview-origin.mjs";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const target = "catalog-paging-public";
export const publicRoute = "https://airfoils.pro/";
export const artifactRoot = join(root, ".codex-artifacts/catalog-web-delivery");
export const inputsPath = join(
  root,
  ".codex-artifacts/catalog-delivery-inputs.json",
);
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const digestPattern = /^[a-f0-9]{64}$/;
export const httpRecord = "journey/catalog-paging-public/http.json";
const limit = 4 * 1024 * 1024;

export async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

// Publish a complete directory only after both HTTP streams and all input checks succeed.
export async function publishDirectory(destination, build) {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, ".catalog-proof-"));
  try {
    await build(stage);
    await rm(destination, { recursive: true, force: true });
    await rename(stage, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function currentSource(worktree = root) {
  const executor =
    process.env.DEVCOORDINATOR_EXECUTOR ||
    join(
      dirname(await realpath("/usr/local/bin/devcoordinator2")),
      "devcoordinator2-executor",
    );
  const native = JSON.parse(
    execFileSync(executor, ["source-digest", "--worktree", worktree], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4096,
    }),
  );
  assert.equal(native.schema, 2);
  assert.match(native.sha256, digestPattern);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  }).trim();
  return {
    sourceSha256: native.sha256,
    webBuild: webSourceIdentity(worktree),
    revision,
  };
}

export function catalogDeployment(before, after) {
  const origin = originFromDeployment(before);
  assert.equal(originFromDeployment(after), origin, "local web port changed");
  for (const snapshot of [before, after]) {
    const d = snapshot.data;
    assert.equal(d.name, "catalog-paging", "wrong named deployment");
    assert.equal(d.source, "worktree");
    assert.equal(d.readiness.source_state, "current");
    assert(typeof d.deployment_id === "string" && d.deployment_id.length > 0);
    assert(
      Number.isSafeInteger(d.current_generation) && d.current_generation > 0,
    );
    assert.equal(
      d.components.find((c) => c.name === "web").generation,
      d.current_generation,
    );
  }
  assert.equal(
    before.data.deployment_id,
    after.data.deployment_id,
    "local deployment changed",
  );
  assert.equal(
    before.data.current_generation,
    after.data.current_generation,
    "local generation changed",
  );
  return {
    url: origin + "/",
    deploymentId: before.data.deployment_id,
    generation: before.data.current_generation,
  };
}

async function requestDocument(url, encoding) {
  const get = new URL(url).protocol === "https:" ? https.get : http.get;
  const response = await new Promise((accept, reject) => {
    get(
      url,
      {
        headers: { accept: "text/html", "accept-encoding": encoding },
        signal: AbortSignal.timeout(20_000),
      },
      accept,
    ).once("error", reject);
  });
  const chunks = [];
  let size = 0;
  try {
    assert.equal(
      response.statusCode,
      200,
      "catalog GET must return 200 directly",
    );
    for await (const chunk of response) {
      size += chunk.length;
      assert(size <= limit, "catalog HTTP body exceeds the observation limit");
      chunks.push(chunk);
    }
    assert(response.complete, "incomplete catalog HTTP response");
  } finally {
    response.destroy();
  }
  const headers = {};
  for (const name of [
    "content-type",
    "content-encoding",
    "content-length",
    "x-ui-source-revision",
    "etag",
    "vary",
    "cache-control",
    "date",
    "age",
  ]) {
    if (typeof response.headers[name] === "string")
      headers[name] = response.headers[name];
  }
  const bytes = Buffer.concat(chunks);
  return {
    bytes,
    evidence: {
      url,
      method: "GET",
      acceptEncoding: encoding,
      status: response.statusCode,
      headers,
      bytes: bytes.length,
      sha256: sha(bytes),
      checkedAt: new Date().toISOString(),
    },
  };
}

export function verifyRepresentations(url, build, identity, gzip) {
  assert.match(build, digestPattern);
  for (const [encoding, response] of [
    ["identity", identity],
    ["gzip", gzip],
  ]) {
    const { evidence, bytes } = response;
    assert.equal(evidence.url, url);
    assert.equal(evidence.method, "GET");
    assert.equal(evidence.acceptEncoding, encoding);
    assert.equal(evidence.status, 200);
    assert.equal(
      evidence.headers["content-type"]?.split(";")[0].trim().toLowerCase(),
      "text/html",
    );
    assert.equal(
      evidence.headers["x-ui-source-revision"],
      build,
      "served UI build differs from source",
    );
    assert.equal(
      evidence.headers["content-encoding"] ?? "identity",
      encoding,
      "server did not honor Accept-Encoding",
    );
    assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limit);
    assert.equal(evidence.bytes, bytes.length);
    assert.equal(evidence.sha256, sha(bytes), "HTTP body digest mismatch");
    if (evidence.headers["content-length"] !== undefined) {
      assert.equal(
        evidence.headers["content-length"],
        String(bytes.length),
        "HTTP Content-Length mismatch",
      );
    }
    assert(Number.isFinite(Date.parse(evidence.checkedAt)));
  }
  assert.deepEqual(
    gunzipSync(gzip.bytes, { maxOutputLength: limit }),
    identity.bytes,
    "gzip must restore exactly the separately observed identity representation",
  );
  const digest = identity.evidence.sha256;
  for (const r of [identity, gzip]) {
    assert.equal(
      r.evidence.headers.etag?.replace(/^W\//, ""),
      '"' + digest + '"',
      "catalog ETag does not bind observed HTML",
    );
  }
  const html = identity.bytes.toString("utf8");
  for (const marker of [
    "browse-surface",
    "catalog-profile-count",
    "catalog-visible-count",
  ]) {
    assert(
      html.includes('data-testid="' + marker + '"'),
      "missing catalog element " + marker,
    );
  }
  const rows = [...html.matchAll(/\bdata-testid="airfoil-row-([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert(
    rows.length > 0 && rows.length <= 40 && new Set(rows).size === rows.length,
    "expected the bounded catalog first page with distinct profiles",
  );
  return {
    rows: rows.length,
    htmlSha256: digest,
    gzipSha256: gzip.evidence.sha256,
  };
}

export async function observeHttp(url, build, directory) {
  // Node's native HTTP client retains compressed bytes for the physical wire witness.
  const identity = await requestDocument(url, "identity");
  const gzip = await requestDocument(url, "gzip");
  const result = verifyRepresentations(url, build, identity, gzip);
  await mkdir(dirname(join(directory, httpRecord)), { recursive: true });
  await Promise.all([
    writeFile(join(directory, "catalog.html"), identity.bytes, { mode: 0o600 }),
    writeFile(join(directory, "catalog.html.gz"), gzip.bytes, { mode: 0o600 }),
    writeJson(join(directory, httpRecord), {
      identity: identity.evidence,
      gzip: gzip.evidence,
    }),
  ]);
  return {
    ...result,
    contentType: identity.evidence.headers["content-type"],
    checkedAt: Date.parse(gzip.evidence.checkedAt),
  };
}

export async function writeLocal(dir, worktree = root) {
  const status = () =>
    JSON.parse(
      execFileSync(
        "/usr/local/bin/devcoordinator2",
        [
          "--client",
          "codex",
          "call",
          "deployment.status",
          "--params",
          JSON.stringify({ path: worktree, name: "catalog-paging" }),
        ],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 },
      ),
    );
  const before = status();
  const source = await currentSource(worktree);
  const url = catalogDeployment(before, before).url;
  const http = await observeHttp(url, source.webBuild, dir);
  const deployed = catalogDeployment(before, status());
  assert.deepEqual(
    await currentSource(worktree),
    source,
    "source changed during local observation",
  );
  const delivery = {
    version: 1,
    kind: "web-deployment",
    target,
    source_sha256: source.sourceSha256,
    file: "catalog.html",
    observed_sha256: http.htmlSha256,
    checked_at_ms: http.checkedAt,
    access: url,
    observation: "web_route_passed",
    deployment: {
      deployment_id: deployed.deploymentId,
      generation_number: deployed.generation,
      http_status: 200,
      content_type: http.contentType,
    },
  };
  await writeJson(join(dir, "source.json"), {
    ...source,
    target,
    deploymentName: before.data.name,
    ...deployed,
  });
  await writeJson(join(dir, "delivery.json"), delivery);
  await writeJson(join(dir, "completion.json"), {
    schema_version: 1,
    claim: "preliminary",
    source_sha256: source.sourceSha256,
    capabilities: [
      {
        id: "catalog-home-http",
        scope: "product",
        state: "real_e2e",
        expected_result:
          "The public catalog serves a bounded first page with equal gzip and identity representations.",
        evidence_refs: [
          httpRecord,
          "catalog.html",
          "catalog.html.gz",
          "source.json",
        ],
        enabled_control: false,
      },
    ],
  });
}

export async function observeLocal(
  destination = join(artifactRoot, "local"),
  worktree = root,
) {
  return publishDirectory(destination, (dir) => writeLocal(dir, worktree));
}

async function main() {
  const [command, inputFile] = process.argv.slice(2);
  if (command === "local") return observeLocal();
  if (command === "candidate-local" && inputFile)
    return observeLocal(
      join(artifactRoot, "candidate-local"),
      await realpath(inputFile),
    );
  const { captureVps, packageHandoff, packageReviews, reviewedLocal } =
    await import("./catalog-web-delivery-handoff.mjs");
  if (command === "reviewed-local")
    return reviewedLocal(inputFile ?? inputsPath);
  if (command === "reviews") return packageReviews(inputFile ?? inputsPath);
  if (command === "capture-vps") return captureVps(inputFile ?? inputsPath);
  if (command === "handoff") return packageHandoff(inputFile ?? inputsPath);
  throw new Error(
    "Expected local, candidate-local WORKTREE, reviews, capture-vps, or handoff",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
