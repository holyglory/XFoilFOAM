import { createHash, type Hash } from "node:crypto";
import {
  canonicalReportJson,
  parseReportJson,
  reportJsonObject,
  splitProgressiveReportText,
} from "./progressive-report-archive";

/** Split only an unambiguous top-level canonical result slot. All varying
 * envelope tokens still use the production lossless canonical serializer. */
export function canonicalLegacyResultSlot(
  envelope: ReturnType<typeof reportJsonObject>,
) {
  const canonical = canonicalReportJson({ ...envelope, result: null });
  const slot = '"result":null';
  const at = canonical.indexOf(slot);
  if (at < 0 || at !== canonical.lastIndexOf(slot)) return undefined;
  return {
    prefix: canonical.slice(0, at + slot.length - 4),
    suffix: canonical.slice(at + slot.length),
  };
}

/** Verify one signed original. Reuse a hash state only after the exact PG
 * prefix and complete result token match and the separately parsed envelope
 * has the same canonical prefix. Each suffix and signature is independent. */
export class LegacyOriginSigner {
  constructor(private readonly retainResult = true) {}

  private prior?: {
    prefix: string;
    result: string;
    signedPrefix: string;
    hash: Hash;
  };
  matches(
    text: string,
    job: string,
    solver: string,
    sequence: number,
    signature: string,
    // On a repeat the freshly parsed envelope has a null result slot. The
    // complete object token is the previously authenticated, byte-equal text.
    verified?: (
      envelope: ReturnType<typeof reportJsonObject>,
      resultText: string | null,
      repeated: boolean,
    ) => void,
  ) {
    const owns = (report: ReturnType<typeof reportJsonObject>) =>
      report.executionId === job &&
      report.solverId === solver &&
      canonicalReportJson(report.sequence!) === String(sequence);
    const prev = this.prior;
    if (
      prev &&
      text.startsWith(prev.prefix) &&
      text.startsWith(prev.result, prev.prefix.length)
    ) {
      const suffix = text.slice(prev.prefix.length + prev.result.length);
      const envelope = reportJsonObject(
        parseReportJson(prev.prefix + "null" + suffix),
      );
      const slot = canonicalLegacyResultSlot(envelope);
      if (slot?.prefix === prev.signedPrefix) {
        if (!owns(envelope) || prev.hash.copy().update(slot.suffix).digest("hex") !== signature)
          return false;
        verified?.(envelope, prev.result, true);
        return true;
      }
    }
    this.prior = undefined;
    const { report, prefix, result } = splitProgressiveReportText(text);
    if (!owns(report)) return false;
    const slot = this.retainResult && result !== null ? canonicalLegacyResultSlot(report) : undefined;
    if (result !== null && slot) {
      const hash = createHash("sha256")
        .update(slot.prefix)
        .update(canonicalReportJson(report.result!));
      if (hash.copy().update(slot.suffix).digest("hex") !== signature)
        return false;
      verified?.(report, result, false);
      this.prior = { prefix, result, signedPrefix: slot.prefix, hash };
      return true;
    }
    if (createHash("sha256").update(canonicalReportJson(report)).digest("hex") !== signature)
      return false;
    verified?.(report, result, false);
    return true;
  }
}
