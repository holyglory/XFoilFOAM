import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Produce the same build identity from a checkout and the Docker build context.
// Include the shared geometry/DTO implementation, the renderer and its assets.
export function webSourceIdentity(root) {
  const digest = createHash("sha256");
  const visit = (path) => {
    const filename = join(root, path);
    const stat = lstatSync(filename, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const child of readdirSync(filename).sort())
        visit(path + "/" + child);
    } else if (stat.isFile()) {
      digest
        .update(path)
        .update("\0")
        .update(createHash("sha256").update(readFileSync(filename)).digest());
    }
  };
  for (const path of [
    "apps/web/app",
    "apps/web/components",
    "apps/web/lib",
    "apps/web/public",
    "apps/web/next.config.ts",
    "apps/web/package.json",
    "apps/web/server.mjs",
    "apps/web/source-identity.mjs",
    "packages/core/src",
    "packages/core/package.json",
    "pnpm-lock.yaml",
  ])
    visit(path);
  return digest.digest("hex");
}
