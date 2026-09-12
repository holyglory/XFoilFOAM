import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { originFromDeployment } from "./progressive-preview-origin.mjs";

export function webDeliveryProof({
  before,
  after,
  sourceBefore,
  sourceAfter,
  body,
  status,
  contentType,
  checkedAt,
}) {
  const origin = originFromDeployment(before);
  assert.equal(originFromDeployment(after), origin);
  assert.equal(before.data.deployment_id, after.data.deployment_id);
  assert(
    Number.isSafeInteger(before.data.current_generation) &&
      before.data.current_generation > 0,
  );
  assert.equal(before.data.current_generation, after.data.current_generation);
  assert.match(sourceBefore, /^[a-f0-9]{64}$/);
  assert.equal(sourceAfter, sourceBefore);
  assert.equal(status, 200);
  assert.equal(contentType?.split(";", 1)[0].trim().toLowerCase(), "text/html");
  assert(
    Buffer.isBuffer(body) && body.length > 0 && body.length <= 4 * 1024 ** 2,
  );
  assert(
    body.toString("utf8").includes('data-testid="progressive-polar-viewer"'),
  );
  assert(Number.isSafeInteger(checkedAt) && checkedAt > 0);
  return {
    version: 1,
    kind: "web-deployment",
    target: "progressive-web-preview",
    source_sha256: sourceBefore,
    file: "airfoil-detail.html",
    observed_sha256: createHash("sha256").update(body).digest("hex"),
    checked_at_ms: checkedAt,
    access: `${origin}/airfoils/ag24`,
    observation: "web_route_passed",
    deployment: {
      deployment_id: before.data.deployment_id,
      generation_number: before.data.current_generation,
      http_status: status,
      content_type: contentType,
    },
  };
}

async function main() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const cli = "/usr/local/bin/devcoordinator2";
  const executor =
    process.env.DEVCOORDINATOR_EXECUTOR ??
    join(dirname(await realpath(cli)), "devcoordinator2-executor");
  const deployment = () =>
    JSON.parse(
      execFileSync(
        cli,
        ["deployment", "status", root, "--name", "progressive-preview"],
        { encoding: "utf8", timeout: 30000, maxBuffer: 256 * 1024 },
      ),
    );
  const source = () => {
    const result = JSON.parse(
      execFileSync(executor, ["source-digest", "--worktree", root], {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4096,
      }),
    );
    assert.equal(result.schema, 2);
    return result.sha256;
  };
  const before = deployment();
  const sourceBefore = source();
  const response = await fetch(
    `${originFromDeployment(before)}/airfoils/ag24`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { accept: "text/html" },
    },
  );
  const body = Buffer.from(await response.arrayBuffer());
  const checkedAt = Date.now();
  const proof = webDeliveryProof({
    before,
    after: deployment(),
    sourceBefore,
    sourceAfter: source(),
    body,
    status: response.status,
    contentType: response.headers.get("content-type"),
    checkedAt,
  });
  const destination = join(root, ".codex-artifacts/progressive-web-delivery");
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, proof.file), body, { mode: 0o600 });
  await writeFile(
    join(destination, "verification.json"),
    `${JSON.stringify(proof)}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      kind: proof.kind,
      generation: proof.deployment.generation_number,
      access: proof.access,
      sourceSha256: proof.source_sha256,
      observedSha256: proof.observed_sha256,
      checkedAt,
    }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
