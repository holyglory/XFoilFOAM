import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function originFromDeployment(response) {
  if (!response?.ok || response.data?.state !== "running")
    throw new Error("The progressive preview deployment is not running");
  if (
    response.data.readiness?.ready !== true ||
    response.data.readiness.pending_apply !== false
  )
    throw new Error("The progressive preview source has not finished applying");
  const web =
    response.data.components?.filter((component) => component.name === "web") ??
    [];
  if (
    web.length !== 1 ||
    web[0].state !== "running" ||
    web[0].owned !== true ||
    !Number.isInteger(web[0].port) ||
    web[0].port < 1024 ||
    web[0].port > 65535
  )
    throw new Error(
      "The progressive preview has no unique running owned web port",
    );
  return `http://127.0.0.1:${web[0].port}`;
}

export function progressivePreviewDeployment({
  deploymentId = process.env.PROGRESSIVE_PREVIEW_DEPLOYMENT_ID,
  execute = execFileSync,
} = {}) {
  const explicitId = deploymentId !== undefined && deploymentId !== null;
  if (
    explicitId &&
    (typeof deploymentId !== "string" || deploymentId.trim().length === 0)
  )
    throw new Error("The progressive preview deployment ID must be non-empty");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const params = explicitId
    ? { deployment_id: deploymentId }
    : { path: root, name: "progressive-preview" };
  const response = JSON.parse(
    execute(
      "/usr/local/bin/devcoordinator2",
      [
        "--client",
        "codex",
        "call",
        "deployment.status",
        "--params",
        JSON.stringify(params),
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 },
    ),
  );
  originFromDeployment(response);
  if (explicitId && response.data.deployment_id !== deploymentId)
    throw new Error("The progressive preview deployment ID does not match");
  return response;
}

export function progressivePreviewOrigin(options) {
  return originFromDeployment(progressivePreviewDeployment(options));
}
