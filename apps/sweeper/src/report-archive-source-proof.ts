import { createHash } from "node:crypto";
import {
  canonicalReportJson,
  parseReportJson,
  reportJsonObject,
  splitProgressiveReportText,
  type ReportJson,
} from "@aerodb/db/progressive-report-archive";
import { retainedReportInventory } from "@aerodb/db/retained-solver-reports";

type Envelope = Record<string, ReportJson>;
type Sources = ReturnType<typeof retainedReportInventory>["sources"];
interface VerifiedResult {
  prefix: string;
  result: string;
  canonical: Buffer;
  sources: Sources;
  sourceList: string;
}

export function reportEnvelopeSignature(
  envelope: Envelope,
  canonicalResult?: string | Buffer,
) {
  const hash = createHash("sha256").update("{");
  const keys = Object.keys(envelope).sort((a, b) => a.localeCompare(b, "en"));
  for (const [i, key] of keys.entries()) {
    hash.update((i ? "," : "") + JSON.stringify(key) + ":");
    hash.update(
      key === "result" && canonicalResult !== undefined
        ? canonicalResult
        : canonicalReportJson(envelope[key]),
    );
  }
  return hash.update("}").digest("hex");
}

export function reportSourceInventorySignature(
  envelope: Envelope,
  reportSignature: string,
  sources: Sources,
) {
  return createHash("sha256")
    .update(
      canonicalReportJson({
        kind: "progressive-remote-report-inventory-v1",
        executionId: envelope.executionId,
        sequence: envelope.sequence,
        reportContentSignature: reportSignature,
        sources,
      }),
    )
    .digest("hex");
}

/** Keep one authenticated scientific value for this ordered writer page.
 * The prefix includes everything through the start of the original root result
 * token. Both that prefix and the entire token must match the new PG text.
 * Parsing the remaining envelope still checks every field and JSON boundary. */
export function cancelledReportSourceVerifier(executionId: string) {
  let previous: VerifiedResult | undefined;
  return (
    raw: string,
    sequence: number,
    signature: string,
    expectedInventory: string,
  ) => {
    let verified = previous;
    let envelope: Envelope;
    let canonical: Buffer | undefined;
    let inventory: string;
    let sourceList: string;
    if (
      previous &&
      raw.startsWith(previous.prefix) &&
      raw.startsWith(previous.result, previous.prefix.length)
    ) {
      const end = previous.prefix.length + previous.result.length;
      envelope = reportJsonObject(
        parseReportJson(previous.prefix + "null" + raw.slice(end)),
      );
      canonical = previous.canonical;
      inventory = reportSourceInventorySignature(
        envelope,
        signature,
        previous.sources,
      );
      sourceList = previous.sourceList;
    } else {
      previous = undefined;
      verified = undefined;
      const cut = splitProgressiveReportText(raw);
      envelope = cut.report;
      const checked = retainedReportInventory(envelope, signature);
      inventory = checked.signature;
      sourceList = canonicalReportJson(checked.sources);
      if (cut.result !== null) {
        canonical = Buffer.from(canonicalReportJson(envelope.result), "utf8");
        verified = {
          prefix: cut.prefix,
          result: cut.result,
          canonical,
          sources: checked.sources,
          sourceList,
        };
      }
    }
    if (
      envelope.executionId !== executionId ||
      canonicalReportJson(envelope.sequence) !== String(sequence) ||
      reportEnvelopeSignature(envelope, canonical) !== signature ||
      inventory !== expectedInventory
    ) {
      throw new Error(
        "Cancelled report differs from the receipted source inventory",
      );
    }
    previous = verified;
    return sourceList;
  };
}
