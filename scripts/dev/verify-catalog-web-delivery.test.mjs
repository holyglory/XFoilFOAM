import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  catalogDeployment,
  publicRoute,
  sha,
  verifyRepresentations,
} from "./verify-catalog-web-delivery.mjs";
import {
  designReceiptId,
  referencedFile,
  verifyDesign,
  verifyExternal,
} from "./catalog-web-delivery-handoff.mjs";

function observation() {
  // Isolated contract inputs. The production CLI obtains its own HTTP bytes and status.
  const build = sha("test UI"),
    candidate = {
      webBuild: build,
      revision: "a".repeat(40),
      sourceSha256: sha("test checkout"),
    };
  const html = Buffer.from(
    '<main data-testid="browse-surface"><span data-testid="catalog-profile-count"></span>' +
      '<div data-testid="airfoil-row-example"></div><span data-testid="catalog-visible-count"></span></main>',
  );
  const compressed = gzipSync(html);
  function response(bytes, encoding) {
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "x-ui-source-revision": build,
      "content-length": String(bytes.length),
      etag: 'W/"' + sha(html) + '"',
    };
    if (encoding === "gzip") headers["content-encoding"] = encoding;
    return {
      bytes,
      evidence: {
        url: publicRoute,
        method: "GET",
        acceptEncoding: encoding,
        status: 200,
        headers,
        bytes: bytes.length,
        sha256: sha(bytes),
        checkedAt: "2020-01-04T00:00:00Z",
      },
    };
  }
  const identity = response(html, "identity"),
    gzip = response(compressed, "gzip");
  const httpBytes = Buffer.from(
    JSON.stringify({ identity: identity.evidence, gzip: gzip.evidence }),
  );
  const bindings = {
    formalRunId: "test-formal-run",
    sourceSha256: sha("formal source"),
    artifactManifestSha256: sha("formal files"),
    candidateId: sha("formal candidate"),
    manualReceiptId: "manual-" + sha("manual"),
    productDesignReceiptId: "sha256:" + sha("audit"),
  };
  const deployment = {
    ...bindings,
    result: "passed",
    liveRoute: publicRoute,
    sourceRevision: candidate.revision,
    uiBuild: build,
    repositorySourceSha256: candidate.sourceSha256,
    imageDigest: "sha256:" + sha("test image"),
    deploymentId: "test-external-release",
    deployedAt: "2020-01-03T00:00:00Z",
    httpStatus: 200,
    contentType: "text/html",
    httpArtifactSha256: sha(httpBytes),
  };
  const capture = {
    ...bindings,
    liveRoute: publicRoute,
    uiBuild: build,
    sourceRevision: candidate.revision,
    repositorySourceSha256: candidate.sourceSha256,
    httpArtifactSha256: sha(httpBytes),
    htmlSha256: sha(html),
    gzipSha256: sha(compressed),
  };
  return {
    candidate,
    identity,
    gzip,
    deployment,
    bindings,
    capture,
    representations: { httpBytes, identity: html, gzip: compressed },
    provenance: Buffer.from(
      [
        candidate.revision,
        deployment.imageDigest,
        deployment.deploymentId,
      ].join("\n"),
    ),
    designTime: Date.parse("2020-01-02T00:00:00Z"),
  };
}

test("records separate, complete gzip and identity representations of the same catalog", () => {
  const v = observation();
  assert.equal(
    verifyRepresentations(publicRoute, v.candidate.webBuild, v.identity, v.gzip)
      .rows,
    1,
  );
  for (const mismatch of [
    (v) => {
      v.gzip.bytes = v.gzip.bytes.subarray(0, -3);
    },
    (v) => {
      v.identity.evidence.headers["content-encoding"] = "gzip";
    },
    (v) => {
      v.gzip.evidence.headers["x-ui-source-revision"] = sha("other source");
    },
    (v) => {
      v.gzip.evidence.headers["content-length"] = "1";
    },
    (v) => {
      v.identity.evidence.url += "?other";
    },
    (v) => {
      v.identity.evidence.status = 302;
    },
    (v) => {
      v.identity.evidence.headers.etag = '"different"';
    },
  ]) {
    const v = observation();
    mismatch(v);
    assert.throws(() =>
      verifyRepresentations(
        publicRoute,
        v.candidate.webBuild,
        v.identity,
        v.gzip,
      ),
    );
  }
  const wrong = observation(),
    other = gzipSync(Buffer.from("different body"));
  Object.assign(wrong.gzip, { bytes: other });
  Object.assign(wrong.gzip.evidence, {
    bytes: other.length,
    sha256: sha(other),
  });
  wrong.gzip.evidence.headers["content-length"] = String(other.length);
  assert.throws(
    () =>
      verifyRepresentations(
        publicRoute,
        wrong.candidate.webBuild,
        wrong.identity,
        wrong.gzip,
      ),
    /restore exactly/,
  );
});

test("uses the named owned running web generation for the local proof", () => {
  const b = {
    ok: true,
    data: {
      name: "catalog-paging",
      deployment_id: "fixture-deployment",
      current_generation: 4,
      state: "running",
      source: "worktree",
      readiness: { ready: true, pending_apply: false, source_state: "current" },
      components: [
        {
          name: "web",
          state: "running",
          owned: true,
          generation: 4,
          port: 25001,
        },
      ],
    },
  };
  assert.equal(catalogDeployment(b, b).url, "http://127.0.0.1:25001/");
  for (const change of [
    (d) => {
      d.name = "progressive-preview";
    },
    (d) => {
      d.current_generation++;
    },
    (d) => {
      d.components[0].owned = false;
    },
    (d) => {
      d.components[0].port++;
    },
    (d) => {
      d.deployment_id += "another";
    },
    (d) => {
      d.readiness.pending_apply = true;
    },
  ]) {
    const after = structuredClone(b);
    change(after.data);
    assert.throws(() => catalogDeployment(b, after));
  }
});

test("requires a genuine passing audit file bound to the upstream reviews", () => {
  const { bindings } = observation();
  delete bindings.productDesignReceiptId;
  const audit = Buffer.from(
    "Test journey\ntest step\n![Captured](test.png)\nfinal result: passed\n",
  );
  const source = sha("test build");
  const receipt = {
    ...bindings,
    result: "passed",
    conclusion: "final result: passed",
    manualSha256: sha("manual"),
    severity: { P0: 0, P1: 0, P2: 0, P3: 1 },
    accessibility: { findings: [{ priority: "P3" }] },
    steps: [
      {
        number: 1,
        title: "Test journey",
        screenshot: "test.png",
        health: "passed",
        notes: "test step",
      },
    ],
    implementation: { uiRevision: "a".repeat(40), observedBuild: source },
  };
  receipt.receiptId = designReceiptId(receipt);
  const verify = (r, bytes = audit, b = bindings) =>
    verifyDesign(r, bytes, b, receipt.receiptId, source);
  verify(receipt);
  for (const prop of Object.keys(bindings))
    assert.throws(() => verify({ ...receipt, [prop]: "wrong" }));
  assert.throws(() => verify({ ...receipt, steps: [] }));
  assert.throws(() =>
    verify({ ...receipt, severity: { P0: 0, P1: 0, P2: 1, P3: 0 } }),
  );
  assert.throws(() => verify(receipt, Buffer.from("final result: failed\n")));
  assert.throws(() =>
    verifyDesign(
      receipt,
      audit,
      bindings,
      receipt.receiptId,
      sha("other served build"),
    ),
  );
});

test("external route proof requires the real image, reviewed source, bytes and deployment time", () => {
  const check = (v) =>
    verifyExternal(
      v.deployment,
      v.capture,
      v.bindings,
      v.candidate,
      v.representations,
      v.provenance,
      v.designTime,
    );
  check(observation());
  for (const change of [
    (v) => {
      v.deployment.liveRoute = "http://127.0.0.1:25001/";
    },
    (v) => {
      v.capture.uiBuild = sha("old UI");
    },
    (v) => {
      v.deployment.sourceRevision = "b".repeat(40);
    },
    (v) => {
      v.capture.repositorySourceSha256 = sha("old candidate");
    },
    (v) => {
      v.capture.htmlSha256 = sha("substitution");
    },
    (v) => {
      v.capture.gzipSha256 = sha("substitution");
    },
    (v) => {
      v.deployment.httpArtifactSha256 = sha("different HTTP");
    },
    (v) => {
      v.deployment.productDesignReceiptId = "other audit";
    },
    (v) => {
      v.capture.artifactManifestSha256 = sha("other formal manifest");
    },
    (v) => {
      v.provenance = Buffer.from("unrelated deployment report");
    },
    (v) => {
      v.deployment.deployedAt = "2019-12-01T00:00:00Z";
    },
    (v) => {
      v.deployment.deployedAt = "2020-02-01T00:00:00Z";
    },
  ]) {
    const v = observation();
    change(v);
    assert.throws(() => check(v));
  }
});

test("a supplied receipt may attach only exact, regular evidence files within its directory", async () => {
  const temp = await mkdtemp(join(tmpdir(), "catalog-proof-test-"));
  try {
    const dir = join(temp, "audit");
    await mkdir(dir);
    const bytes = Buffer.from("test report");
    await writeFile(join(dir, "report"), bytes);
    await writeFile(join(temp, "outside"), bytes);
    await symlink(join(temp, "outside"), join(dir, "alias"));
    assert.deepEqual(
      await referencedFile(dir, { file: "report", sha256: sha(bytes) }),
      bytes,
    );
    for (const ref of [
      { file: "report", sha256: sha("changed") },
      { file: "absent", sha256: sha(bytes) },
      { file: "../outside", sha256: sha(bytes) },
      { file: "alias", sha256: sha(bytes) },
    ])
      await assert.rejects(referencedFile(dir, ref));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
