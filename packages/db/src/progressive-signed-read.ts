import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { canonicalAnalysisEntries, canonicalAnalysisJson } from "./analysis-target";

/** Visit the canonical byte sequence used by the original signer. A fragment
 * ends between JSON tokens, so a UTF-8 character cannot cross hash updates. */
function* writeValue(value: unknown, parts: string[]): Generator<void> {
  if (Array.isArray(value)) {
    parts.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i) parts.push(",");
      if (i in value) yield* writeValue(value[i], parts);
    }
    parts.push("]");
  } else if (typeof value === "object" && value !== null) {
    parts.push("{");
    let first = true;
    for (const [key, item] of canonicalAnalysisEntries(value)) {
      if (!first) parts.push(",");
      first = false;
      parts.push(JSON.stringify(key), ":");
      yield* writeValue(item, parts);
    }
    parts.push("}");
  } else {
    parts.push(canonicalAnalysisJson(value));
  }
  if (parts.length >= 4096) yield;
}

/** Used on private, decoded database report values. The importer still owns
 * its admission slot while other requests can receive their worker replies. */
export async function hashSignedReportValue(value: unknown, copy?: string[]) {
  const hash = createHash("sha256");
  const parts: string[] = [];
  const flush = () => {
    const text = parts.join("");
    hash.update(text, "utf8");
    copy?.push(text);
    parts.length = 0;
  };
  let nextYield = performance.now();
  for (const _ of writeValue(value, parts)) {
    flush();
    if (performance.now() >= nextYield) {
      await setImmediate();
      nextYield = performance.now() + 12;
    }
  }
  flush();
  return hash.digest("hex");
}
