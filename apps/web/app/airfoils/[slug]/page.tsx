import { notFound } from "next/navigation";
import { Suspense } from "react";

import { DetailHeader } from "@/components/detail/Header";
import { DetailIsland } from "@/components/detail/DetailIsland";
import { AppShell } from "@/components/shell/AppShell";
import { getAirfoilCurveDetail, getAirfoilDetail } from "@/lib/api";
import { parsePinnedRevisionParam } from "@/lib/detail-links";
import { metricConditionParam } from "@/lib/metric-condition";

export default function AirfoilDetailPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense
      fallback={
        <AppShell active="detail">
          <main style={{ padding: 24 }}>
            <p role="status">Loading airfoil polar…</p>
          </main>
        </AppShell>
      }
    >
      <AirfoilDetailContent {...props} />
    </Suspense>
  );
}

async function AirfoilDetailContent({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  // ?revision=<uuid> (campaign spec §11 pinned-detail admin journey): admin
  // evidence links pin the job's setup revision so campaign evidence — whose
  // presets are disabled by design — is visible here. Invalid shapes are
  // ignored and the page falls back to the public enabled-presets view.
  const query = await searchParams;
  const pinnedRevisionId = parsePinnedRevisionParam(query.revision);
  const openCfdInitially = query.points === "1";
  const detail =
    pinnedRevisionId || openCfdInitially
      ? await getAirfoilDetail(slug, pinnedRevisionId)
      : await getAirfoilCurveDetail(slug);
  if (!detail) notFound();
  return (
    <AppShell active="detail">
      <div
        style={{ maxWidth: 1280, margin: "0 auto", padding: "20px 22px 56px" }}
      >
        <DetailHeader detail={detail} />
        <DetailIsland
          detail={detail}
          pinnedRevisionId={pinnedRevisionId}
          openCfdInitially={openCfdInitially}
          initialConditionKey={metricConditionParam(query.condition)}
        />
      </div>
    </AppShell>
  );
}
