import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function originFromDeployment(response) {
  if (!response?.ok || response.data?.state !== "running")
    throw new Error("The progressive preview deployment is not running");
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

export function progressivePreviewOrigin() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const response = execFileSync(
    "/usr/local/bin/devcoordinator2",
    [
      "deployment",
      "status",
      root,
      "--name",
      "progressive-preview",
      "--client",
      "codex",
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 },
  );
  return originFromDeployment(JSON.parse(response));
}
