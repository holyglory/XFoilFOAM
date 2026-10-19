import { Suspense } from "react";
import { cookies } from "next/headers";

import { AdminConsole } from "@/components/admin/AdminConsole";
import { AppShell } from "@/components/shell/AppShell";
import type { AdminBootstrap } from "@/components/admin/AdminConsole";

export const dynamic = "force-dynamic";

const ADMIN_BOOTSTRAP_SERVER_BUDGET_MS = 700;

async function loadAdminBootstrap(): Promise<AdminBootstrap | null | undefined> {
  const authCookie = (await cookies()).get("aero_admin");
  if (!authCookie) return null;
  const apiUrl = process.env.API_URL ?? "http://localhost:4000";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    ADMIN_BOOTSTRAP_SERVER_BUDGET_MS,
  );
  try {
    const response = await fetch(
      `${apiUrl}/api/admin/bootstrap?status=active%2Cpaused%2Cattention&limit=50`,
      {
        headers: { cookie: `${authCookie.name}=${authCookie.value}` },
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as AdminBootstrap;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

type AdminPageProps = {
  searchParams?: Promise<{
    section?: string;
    campaign?: string;
    wizard?: string;
  }>;
};

export default async function AdminPage({
  searchParams,
}: AdminPageProps) {
  const params = (await searchParams) ?? {};
  const isCampaignHub =
    (params.section ?? "simulations") === "simulations" &&
    !params.campaign &&
    !params.wizard;
  const initialBootstrap = isCampaignHub ? await loadAdminBootstrap() : null;
  return (
    <AppShell active="admin">
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 22px 56px" }}>
        {/* AdminConsole reads useSearchParams (URL is the routing source of
            truth, spec §11) — Next requires a Suspense boundary above it. */}
        <Suspense fallback={null}>
          <AdminConsole initialBootstrap={initialBootstrap} />
        </Suspense>
      </div>
    </AppShell>
  );
}
