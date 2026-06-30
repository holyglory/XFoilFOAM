import { notFound } from "next/navigation";

import { DetailHeader } from "@/components/detail/Header";
import { DetailIsland } from "@/components/detail/DetailIsland";
import { AppShell } from "@/components/shell/AppShell";
import { getAirfoilDetail } from "@/lib/api";

export default async function AirfoilDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const detail = await getAirfoilDetail(slug);
  if (!detail) notFound();
  return (
    <AppShell active="detail">
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "20px 22px 56px" }}>
        <DetailHeader detail={detail} />
        <DetailIsland detail={detail} />
      </div>
    </AppShell>
  );
}
