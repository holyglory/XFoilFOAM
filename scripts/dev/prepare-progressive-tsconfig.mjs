import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function prepareProgressiveTsconfig(directory, generation) {
  if (!/^[1-9]\d*$/.test(String(generation)))
    throw new Error("Expected a positive preview generation");
  const name = `.tsconfig-progressive-preview-${generation}.json`;
  copyFileSync(resolve(directory, "tsconfig.json"), resolve(directory, name));
  return name;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.stdout.write(
    prepareProgressiveTsconfig(process.argv[2], process.argv[3]) + "\n",
  );
