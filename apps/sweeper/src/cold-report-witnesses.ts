import type { DB } from "@aerodb/db";
import { progressiveReportedPointSources } from "@aerodb/db/progressive-remote-report";
import {
  readProgressiveReport,
  recheckRemoteReportMember,
  verifiedProgressiveReportMember,
} from "@aerodb/db/progressive-report-reader";
import { SHARED_REPORT_FORMAT, verifySharedReportGeneration } from "./shared-report-archive";
import type { ReportObjects } from "./shared-report-objects";

export type ReceiptPoint = {
  seq: number;
  sig: string;
  point: string;
  aoa: number | string;
  slug: string | null;
};

type Coordinates = { aoa: number; slug: string | null };
type MemberProof = NonNullable<ReturnType<typeof verifiedProgressiveReportMember>>;

function matches(points: ReadonlyMap<string, Coordinates>, row: ReceiptPoint) {
  const source = points.get(row.point);
  return source !== undefined && source.aoa === Number(row.aoa) && source.slug === row.slug;
}

/** Keep only points previously matched against a fully restored signed report.
 * Every reuse still authenticates the immutable manifest and scientific bytes. */
export class ColdReportWitnesses {
  private readonly recent = new Map<string, { proof: MemberProof; points: Map<string, Coordinates> }>();

  constructor(private readonly objects?: ReportObjects) {}

  async verify(db: DB, job: string, rows: readonly ReceiptPoint[]) {
    for (let start = 0; start < rows.length;) {
      const first = rows[start]!;
      let end = start + 1;
      while (end < rows.length && rows[end]!.seq === first.seq && rows[end]!.sig === first.sig) end++;
      await this.verifyMember(db, job, rows.slice(start, end));
      start = end;
    }
  }

  private async verifyMember(db: DB, job: string, rows: readonly ReceiptPoint[]) {
    const { seq, sig } = rows[0]!;
    const key = JSON.stringify([job, seq, sig]);
    const prior = this.recent.get(key);
    if (this.objects && prior && rows.every(row => matches(prior.points, row)) &&
        await recheckRemoteReportMember(db, prior.proof)) {
      await verifySharedReportGeneration(this.objects, prior.proof.identity);
      if (!await recheckRemoteReportMember(db, prior.proof))
        throw new Error("Cold scientific witness changed during generation verification");
      return;
    }

    const body = await readProgressiveReport(db, {
      sourceKind: "remote", executionId: job, sequence: seq, contentSignature: sig,
    });
    if (!body.result) throw new Error("Cold scientific witness has no result");
    const points = new Map(progressiveReportedPointSources(body.result).map(source => [
      source.contentSignature, { aoa: source.point.aoa_deg, slug: source.point.case_slug ?? null },
    ]));
    if (!rows.every(row => matches(points, row)))
      throw new Error("Cold scientific witness changed its exact point");
    const proof = verifiedProgressiveReportMember(body);
    if (this.objects && proof?.identity.archiveFormat === SHARED_REPORT_FORMAT &&
        proof.identity.bucket === this.objects.bucket) {
      const checked = new Map(rows.map(row => [row.point, points.get(row.point)!]));
      this.recent.delete(key);
      this.recent.set(key, { proof, points: checked });
      if (this.recent.size > 8) this.recent.delete(this.recent.keys().next().value!);
    }
  }
}
