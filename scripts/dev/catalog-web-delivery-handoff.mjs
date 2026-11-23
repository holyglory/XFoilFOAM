import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  artifactRoot,
  currentSource,
  digestPattern,
  httpRecord,
  observeHttp,
  publicRoute,
  publishDirectory,
  root,
  sha,
  target,
  verifyRepresentations,
  writeJson,
  writeLocal,
} from "./verify-catalog-web-delivery.mjs";

async function fileBytes(path, max = 16 * 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert(
      stat.isFile() && stat.size > 0 && stat.size <= max,
      "invalid evidence file " + path,
    );
    const bytes = await file.readFile();
    assert.equal(bytes.length, stat.size, "evidence changed during read");
    return bytes;
  } finally {
    await file.close();
  }
}

export async function referencedFile(directory, ref) {
  assert(
    ref && typeof ref.file === "string" && !isAbsolute(ref.file),
    "relative evidence file required",
  );
  assert(
    ref.file
      .split(/[\\/]/)
      .every((part) => part && part !== "." && part !== ".."),
    "invalid evidence path",
  );
  assert.match(ref.sha256, digestPattern);
  const base = await realpath(directory);
  const path = join(base, ref.file);
  const rel = relative(base, await realpath(path));
  assert(
    rel && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..",
    "evidence file escaped its directory",
  );
  const bytes = await fileBytes(path);
  assert.equal(sha(bytes), ref.sha256, "referenced evidence bytes changed");
  return bytes;
}

async function loadInputs(filename) {
  const paths = JSON.parse(await fileBytes(filename));
  const directory = dirname(resolve(filename));
  const location = (name) => {
    assert(
      typeof paths[name] === "string" && paths[name].trim(),
      "missing input " + name,
    );
    return resolve(directory, paths[name]);
  };
  assert.match(paths.formalRun, /^t[0-9]{8}T[0-9]{6}Z-[a-z0-9]+$/);
  assert.match(paths.productDesignReceiptId, /^audit-[a-f0-9]{64}$/);
  return {
    location,
    formalRun: paths.formalRun,
    designId: paths.productDesignReceiptId,
    releaseWorktree: paths.releaseWorktree && location("releaseWorktree"),
  };
}

function expectedBindings(formal, manualBytes) {
  return {
    formalRunId: formal.runId,
    candidateId: formal.candidateId,
    sourceSha256: formal.sourceSha256,
    artifactManifestSha256: formal.evidence.manifestSha256,
    manualReceiptId: "manual-" + sha(manualBytes),
  };
}

function checkBindings(receipt, expected) {
  for (const [field, value] of Object.entries(expected))
    assert.equal(receipt[field], value, "receipt binding differs at " + field);
}

// Audit receipts identify the sorted, compact JSON fields preceding receiptId.
export function designReceiptId(receipt) {
  const content = { ...receipt };
  delete content.receiptId;
  const sortKeys = (value) => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  };
  const compact = JSON.stringify(sortKeys(content)).replace(
    /[^\x00-\x7f]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  return "audit-" + sha(compact);
}

export function verifyDesign(design, audit, bindings, expectedId, webBuild) {
  checkBindings(design, bindings);
  assert.equal(
    design.manualSha256,
    bindings.manualReceiptId.slice("manual-".length),
  );
  assert.equal(design.result, "passed", "Product Design audit must pass");
  assert.equal(design.conclusion, "final result: passed");
  assert.equal(
    design.receiptId,
    expectedId,
    "unexpected Product Design receipt",
  );
  assert.equal(
    designReceiptId(design),
    expectedId,
    "Product Design receipt content changed",
  );
  assert.equal(
    design.implementation.observedBuild,
    webBuild,
    "audit observed a different UI build",
  );
  assert.match(design.implementation.uiRevision, /^[a-f0-9]{40}$/);
  assert(
    ["P0", "P1", "P2"].every((level) => design.severity[level] === 0),
    "blocking Product Design severity",
  );
  assert(
    Array.isArray(design.accessibility.findings) &&
      design.accessibility.findings.every((f) => f.priority === "P3"),
    "blocking accessibility finding",
  );
  assert(
    Array.isArray(design.steps) &&
      design.steps.length > 0 &&
      design.steps.every(
        (step, i) =>
          step.number === i + 1 &&
          step.health === "passed" &&
          typeof step.notes === "string" &&
          step.notes.trim(),
      ),
    "missing or failing audit journey step",
  );
  const markdown = audit.toString("utf8");
  for (const step of design.steps) {
    assert(
      markdown.includes(step.title) &&
        markdown.includes(step.notes) &&
        markdown.includes("](" + step.screenshot + ")"),
      "audit report differs from its signed step and screenshot",
    );
  }
  assert.equal(
    audit.toString("utf8").trimEnd().split(/\r?\n/).at(-1)?.trim(),
    "final result: passed",
  );
}

function coordinator(operation, params) {
  const result = JSON.parse(
    execFileSync(
      "/usr/local/bin/devcoordinator2",
      [
        "--client",
        "codex",
        "call",
        operation,
        "--params",
        JSON.stringify(params),
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    ),
  );
  assert(result.ok, "Coordinator could not validate " + operation);
  return result.data;
}

async function auditCapture(design, directory, worktree, earliest) {
  const impl = design.implementation;
  const catalog = coordinator("test.artifact.catalog", {
    path: worktree,
    run_id: impl.auditCaptureRun,
    check: "capture",
    artifact: "catalog-audit-captures",
    limit: 50,
  });
  assert(
    catalog.run_id === impl.auditCaptureRun &&
      catalog.test === "catalog-design-audit-capture" &&
      catalog.run_complete &&
      catalog.run_status === "passed" &&
      !catalog.next_offset,
    "missing completed governed design capture",
  );
  const files = new Map(catalog.entries.map((entry) => [entry.path, entry]));
  const metadata = await referencedFile(directory, {
    file: "captures.json",
    sha256: files.get("captures.json")?.sha256,
  });
  const captured = JSON.parse(metadata);
  assert.equal(captured.deployment, impl.deploymentId);
  assert(Number.isSafeInteger(impl.generation) && impl.generation > 0);
  assert.equal(captured.generation, impl.generation);
  assert.equal(captured.source, impl.observedBuild);
  assert.equal(captured.steps.length, design.steps.length);
  const images = [];
  for (const [i, step] of design.steps.entries()) {
    const real = captured.steps[i];
    assert(
      real.file === step.screenshot &&
        real.sha256 === step.sha256 &&
        real.theme === step.theme &&
        files.get(real.file)?.sha256 === real.sha256,
      "audit screenshot differs from governed capture",
    );
    assert.deepEqual(real.viewport, step.viewport);
    assert(
      real.path.startsWith("/") &&
        !real.path.startsWith("//") &&
        earliest <= Date.parse(real.capturedAt) &&
        Date.parse(real.capturedAt) <= Date.parse(design.reviewedAt),
      "audit screenshot time or route differs",
    );
    images.push(await imageFile(directory, real));
  }
  const reference = await imageFile(directory, design.reference);
  return {
    metadata,
    images,
    reference,
    manifest: catalog.manifest_sha256,
    source: catalog.source_sha256,
  };
}

export function verifyExternal(
  deployment,
  capture,
  bindings,
  candidate,
  representations,
  provenance,
  designTime,
) {
  checkBindings(deployment, bindings);
  checkBindings(capture, bindings);
  assert.equal(deployment.result, "passed", "external deployment must pass");
  assert.equal(deployment.liveRoute, publicRoute);
  assert.equal(capture.liveRoute, publicRoute);
  assert.equal(deployment.httpStatus, 200);
  assert.equal(
    deployment.contentType?.split(";")[0].trim().toLowerCase(),
    "text/html",
  );
  assert.equal(deployment.uiBuild, candidate.webBuild);
  assert.equal(deployment.sourceRevision, candidate.revision);
  assert.equal(deployment.repositorySourceSha256, candidate.sourceSha256);
  assert.equal(capture.uiBuild, candidate.webBuild);
  assert.equal(capture.sourceRevision, candidate.revision);
  assert.equal(capture.repositorySourceSha256, candidate.sourceSha256);
  assert.match(deployment.imageDigest, /^sha256:[a-f0-9]{64}$/);
  assert(
    typeof deployment.deploymentId === "string" &&
      deployment.deploymentId.trim(),
    "external operator deployment identity required",
  );
  for (const expected of [
    deployment.sourceRevision,
    deployment.imageDigest,
    deployment.deploymentId,
  ]) {
    assert(
      provenance.includes(Buffer.from(expected)),
      "operator provenance does not identify the deployed revision and image",
    );
  }
  const { httpBytes, identity, gzip } = representations;
  const meta = JSON.parse(httpBytes);
  verifyRepresentations(
    publicRoute,
    candidate.webBuild,
    { bytes: identity, evidence: meta.identity },
    { bytes: gzip, evidence: meta.gzip },
  );
  const deployedAt = Date.parse(deployment.deployedAt);
  assert(
    designTime <= deployedAt &&
      deployedAt <= Date.parse(meta.identity.checkedAt) &&
      Date.parse(meta.identity.checkedAt) <= Date.parse(meta.gzip.checkedAt),
    "external evidence chronology differs",
  );
  assert.equal(
    deployment.httpArtifactSha256,
    sha(httpBytes),
    "external HTTP artifact identity differs",
  );
  assert.equal(capture.httpArtifactSha256, sha(httpBytes));
  assert.equal(capture.htmlSha256, sha(identity));
  assert.equal(capture.gzipSha256, sha(gzip));
}

// The native finalizer checks the original hashed formal artifacts, screenshots,
// coverage and individual decisions. Use the governed run directory it actually wrote.
async function upstream(filename) {
  const { formalRun, location, designId, releaseWorktree } =
    await loadInputs(filename);
  const worktree = await realpath(location("formalWorktree"));
  const dir = join(
    worktree,
    ".devcoordinator/test/logs/runs",
    formalRun,
    "checks/layout/check/evidence",
  );
  const candidate = await currentSource(
    releaseWorktree ? await realpath(releaseWorktree) : worktree,
  );
  const formalBytes = await fileBytes(join(dir, "formal-receipt.json"));
  const manifest = await fileBytes(join(dir, "formal-artifacts.json"));
  const formal = JSON.parse(formalBytes).formal;
  assert.equal(formal?.result, "passed");
  assert.equal(formal.freshComplete, true);
  assert.equal(
    formal.evidence.manifestSha256,
    sha(manifest),
    "formal artifact manifest changed",
  );
  assert.match(formal.sourceSha256, digestPattern);
  const reportPath = join(dir, "report.json");
  const report = JSON.parse(await fileBytes(reportPath, 32 * 1024 * 1024));
  assert.equal(report.runId, formal.runId);
  assert.equal(report.formal.candidateId, formal.candidateId);
  assert(
    report.pages.length > 0 &&
      report.pages.every(
        (p) =>
          p.outcome === "checked" &&
          p.status === 200 &&
          p.target?.primaryJourney === "rank-airfoils" &&
          (p.target.name === "catalog-paging" ||
            p.target.name === "catalog-paging [" + p.target.stateName + "]") &&
          p.requestedPath === "/" &&
          p.finalPath === "/" &&
          p.sourceBinding?.status === "matched" &&
          p.sourceBinding.expected === candidate.webBuild &&
          p.sourceBinding.observed === candidate.webBuild &&
          p.sourceBinding.observedFrom ===
            "response-header:x-ui-source-revision",
      ),
    "formal catalog route or observed UI build differs",
  );
  const native = coordinator("test.evidence.get", {
    path: worktree,
    run_id: formalRun,
    limit: 1,
  });
  assert(
    native.status === "available" &&
      native.run_id === formalRun &&
      native.bundles.some(
        (b) =>
          b.check === "layout" &&
          b.formal_run_id === formal.runId &&
          b.coverage.readiness_eligible &&
          b.coverage.checked_pages === report.pages.length,
      ),
    "missing authentic governed formal run",
  );
  const manualPath = location("manualReview");
  const manualBytes = await fileBytes(manualPath);
  const manual = JSON.parse(manualBytes).manual;
  assert.equal(manual?.result, "passed", "manual review must pass");
  assert.equal(manual.formalRunId, formal.runId);
  assert.equal(manual.formalManifestSha256, sha(manifest));
  assert.equal(manual.sourceSha256, formal.sourceSha256);
  execFileSync(
    "/usr/local/bin/devcoordinator2-tooling",
    [
      "formal-ui",
      "review",
      "--report",
      reportPath,
      "--queue",
      join(dir, "review-queue.json"),
      "--review",
      manualPath,
    ],
    { timeout: 90_000, maxBuffer: 128 * 1024 },
  );
  assert.deepEqual(
    await fileBytes(manualPath),
    manualBytes,
    "manual receipt changed",
  );
  const bindings = expectedBindings(formal, manualBytes);
  const designPath = location("productDesignReceipt");
  const designBytes = await fileBytes(designPath);
  const design = JSON.parse(designBytes);
  const audit = await fileBytes(join(dirname(designPath), "review.md"));
  verifyDesign(design, audit, bindings, designId, candidate.webBuild);
  const designTime = Date.parse(design.reviewedAt);
  assert(
    Date.parse(report.endedAt) <= Date.parse(manual.reviewedAt) &&
      Date.parse(manual.reviewedAt) <= designTime,
    "review chronology differs",
  );
  const captured = await auditCapture(
    design,
    dirname(designPath),
    worktree,
    Date.parse(manual.reviewedAt),
  );
  return {
    candidate,
    location,
    bindings: { ...bindings, productDesignReceiptId: designId },
    formalRun,
    formalBytes,
    manifest,
    manualBytes,
    designBytes,
    audit,
    captured,
    designTime,
    design,
  };
}

async function imageFile(directory, ref) {
  const bytes = await referencedFile(directory, ref);
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  assert(png || jpeg, "rendered evidence must contain a PNG or JPEG image");
  return { bytes, extension: png ? "png" : "jpg", sha256: sha(bytes) };
}

function reviewFiles(chain) {
  const files = new Map([
    ["formal-receipt.json", chain.formalBytes],
    ["formal-artifacts.json", chain.manifest],
    ["manual-review.json", chain.manualBytes],
    ["design/product-design.json", chain.designBytes],
    ["design/review.md", chain.audit],
    ["design/captures.json", chain.captured.metadata],
    ["design/" + chain.design.reference.file, chain.captured.reference.bytes],
  ]);
  for (const [i, image] of chain.captured.images.entries())
    files.set("design/" + chain.design.steps[i].screenshot, image.bytes);
  return files;
}

async function attach(directory, files) {
  for (const [name, bytes] of files) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), bytes, { mode: 0o600 });
  }
}

function reviewIdentity(chain) {
  return {
    ...chain.bindings,
    governedFormalRun: chain.formalRun,
    uiRevision: chain.design.implementation.uiRevision,
    uiBuild: chain.candidate.webBuild,
    captureRun: chain.design.implementation.auditCaptureRun,
    captureManifestSha256: chain.captured.manifest,
    captureRepositorySourceSha256: chain.captured.source,
  };
}

export async function reviewedLocal(filename) {
  const chain = await upstream(filename);
  await publishDirectory(join(artifactRoot, "local"), async (stage) => {
    await writeLocal(stage);
    const source = JSON.parse(await fileBytes(join(stage, "source.json")));
    assert.equal(
      source.webBuild,
      chain.candidate.webBuild,
      "local deployment differs from audited build",
    );
    await attach(stage, reviewFiles(chain));
    await writeJson(join(stage, "reviews.json"), reviewIdentity(chain));
  });
}

export async function packageReviews(filename) {
  const chain = await upstream(filename);
  await publishDirectory(join(artifactRoot, "reviewed"), async (dir) => {
    await attach(dir, reviewFiles(chain));
    await writeJson(join(dir, "reviews.json"), reviewIdentity(chain));
  });
}

// This is an operator-invoked, read-only public GET after the reviewed build is live.
export async function captureVps(filename) {
  const { candidate, bindings, location } = await upstream(filename);
  const directory = location("vpsHttpDirectory");
  await mkdir(directory, { recursive: false, mode: 0o700 });
  try {
    const http = await observeHttp(publicRoute, candidate.webBuild, directory);
    await writeJson(join(directory, "capture.json"), {
      ...bindings,
      liveRoute: publicRoute,
      uiBuild: candidate.webBuild,
      sourceRevision: candidate.revision,
      repositorySourceSha256: candidate.sourceSha256,
      htmlSha256: http.htmlSha256,
      gzipSha256: http.gzipSha256,
      httpArtifactSha256: sha(await fileBytes(join(directory, httpRecord))),
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function packageHandoff(filename) {
  const chain = await upstream(filename);
  const { candidate, bindings, location } = chain;
  const dir = location("vpsHttpDirectory");
  const deployPath = location("vpsDeploymentReceipt");
  const deploymentBytes = await fileBytes(deployPath);
  const deployment = JSON.parse(deploymentBytes).deployment;
  assert(deployment, "external VPS deployment receipt is missing");
  const deployProof = await referencedFile(
    dirname(deployPath),
    deployment.provenance,
  );
  const renderDir = join(artifactRoot, "vps-render");
  const renderBytes = await fileBytes(join(renderDir, "rendered-evidence.json"));
  const render = JSON.parse(renderBytes);
  assert.match(render.governedRunId, /^t[0-9]{8}T[0-9]{6}Z-[a-z0-9]+$/);
  assert.equal(render.governedCheck, "external-render");
  if (render.governedRunId !== process.env.DEVCOORDINATOR_RUN_ID || process.env.DEVCOORDINATOR_CHECK_NAME !== "handoff") {
    const retained = coordinator("test.artifact.catalog", {path: root, run_id: render.governedRunId,
      check: "external-render", artifact: "catalog-vps-render", limit: 20});
    assert(retained.run_status === "passed" && retained.entries.some(e =>
      e.path === "rendered-evidence.json" && e.sha256 === sha(renderBytes)), "unverified external browser capture");
  }
  checkBindings(render, { httpArtifactSha256: deployment.httpArtifactSha256,
    formalRunId: bindings.formalRunId, productDesignReceiptId: bindings.productDesignReceiptId });
  assert(Array.isArray(render.renderedEvidence) && render.renderedEvidence.length, "governed live render required");
  const liveFiles = new Map();
  const importLive = (name, bytes) => {
    assert(
      !liveFiles.has(name) &&
        ![
          "deployment.json",
          "capture.json",
          "http.json",
          "catalog.html",
          "catalog.html.gz",
        ].includes(name),
      "duplicate or reserved live evidence filename",
    );
    liveFiles.set(name, bytes);
  };
  importLive(deployment.provenance.file, deployProof);
  importLive("browser/rendered-evidence.json", renderBytes);
  const refs = [
    ...(deployment.renderedEvidence ?? []).map(ref => ({ref, directory: dirname(deployPath), prefix: ""})),
    ...render.renderedEvidence.map(ref => ({ref, directory: renderDir, prefix: "browser/"})),
  ];
  for (const {ref, directory, prefix} of refs) {
    assert.equal(
      ref.url,
      publicRoute,
      "live screenshot came from a different route",
    );
    assert.equal(
      ref.uiBuild,
      candidate.webBuild,
      "live screenshot build differs",
    );
    assert(
      Date.parse(ref.capturedAt) >= Date.parse(deployment.deployedAt),
      "live screenshot predates deployment",
    );
    importLive(prefix + ref.file, (await imageFile(directory, ref)).bytes);
  }
  const captureBytes = await fileBytes(join(dir, "capture.json"));
  const httpBytes = await fileBytes(join(dir, httpRecord));
  const identity = await fileBytes(join(dir, "catalog.html"));
  const gzip = await fileBytes(join(dir, "catalog.html.gz"));
  verifyExternal(
    deployment,
    JSON.parse(captureBytes),
    bindings,
    candidate,
    { httpBytes, identity, gzip },
    deployProof,
    chain.designTime,
  );
  assert.equal(
    (await currentSource()).webBuild,
    candidate.webBuild,
    "local catalog differs from the reviewed build",
  );

  await publishDirectory(join(artifactRoot, "handoff"), async (stage) => {
    await writeLocal(stage);
    const files = new Map([
      ...reviewFiles(chain),
      ["vps/deployment.json", deploymentBytes],
      ["vps/capture.json", captureBytes],
      ["vps/http.json", httpBytes],
      ["vps/catalog.html", identity],
      ["vps/catalog.html.gz", gzip],
    ]);
    for (const [name, bytes] of liveFiles) files.set("vps/" + name, bytes);
    await attach(stage, files);
    await writeJson(join(stage, "handoff.json"), {
      target,
      ...reviewIdentity(chain),
      candidate,
      local: JSON.parse(await fileBytes(join(stage, "source.json"))),
      external: {
        route: publicRoute,
        deploymentId: deployment.deploymentId,
        imageDigest: deployment.imageDigest,
        renderedEvidence: {file: "vps/browser/rendered-evidence.json", sha256: sha(renderBytes)},
      },
      files: Object.fromEntries(
        [...files].map(([name, bytes]) => [
          name,
          { sha256: sha(bytes), bytes: bytes.length },
        ]),
      ),
    });
    const completion = JSON.parse(
      await fileBytes(join(stage, "completion.json")),
    );
    completion.claim = "complete";
    completion.capabilities[0].evidence_refs.push(
      "formal-receipt.json",
      "manual-review.json",
      "design/product-design.json",
      "vps/http.json",
      "vps/deployment.json",
      "handoff.json",
    );
    await writeJson(join(stage, "completion.json"), completion);
  });
}
