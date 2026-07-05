import { notFound } from "next/navigation";

import { DetailHeader } from "@/components/detail/Header";
import { DetailIsland } from "@/components/detail/DetailIsland";
import { AppShell } from "@/components/shell/AppShell";
import { getAirfoilDetail } from "@/lib/api";
import { parsePinnedRevisionParam } from "@/lib/detail-links";

export default async function AirfoilDetailPage({
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
  const pinnedRevisionId = parsePinnedRevisionParam((await searchParams).revision);
  const detail = await getAirfoilDetail(slug, pinnedRevisionId);
  if (!detail) notFound();
  return (
    <AppShell active="detail">
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "20px 22px 56px" }}>
        <DetailHeader detail={detail} />
        <DetailIsland detail={detail} pinnedRevisionId={pinnedRevisionId} />
      </div>
    </AppShell>
  );
}
