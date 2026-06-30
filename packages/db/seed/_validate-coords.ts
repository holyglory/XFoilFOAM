// Dev utility: parse every bundled Selig/UIUC .dat and print a sanity summary.
// Run: pnpm --filter @aerodb/db exec tsx seed/_validate-coords.ts
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveGeometry, parseCoordinates } from "@aerodb/core";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "selig-database");
for (const file of readdirSync(dir)
  .filter((f) => !f.startsWith(".") && f.endsWith(".dat"))
  .sort()) {
  const text = readFileSync(join(dir, file), "utf8");
  try {
    const parsed = parseCoordinates(text);
    const xs = parsed.points.map((p) => p.x);
    const ys = parsed.points.map((p) => p.y);
    const g = deriveGeometry(parsed.points);
    console.log(
      `${file.padEnd(15)} ${parsed.format.padEnd(9)} n=${String(parsed.points.length).padStart(3)} ` +
        `x[${Math.min(...xs).toFixed(2)},${Math.max(...xs).toFixed(2)}] ` +
        `y[${Math.min(...ys).toFixed(2)},${Math.max(...ys).toFixed(2)}] ` +
        `t=${g.thicknessPct.toFixed(1)}% cam=${g.camberPct.toFixed(1)}% ` +
        `name="${parsed.name.slice(0, 24)}"`,
    );
  } catch (e) {
    console.log(`${file.padEnd(15)} PARSE ERROR: ${(e as Error).message}`);
  }
}
