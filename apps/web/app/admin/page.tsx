import { Suspense } from "react";
import { cookies } from "next/headers";

import { AdminConsole } from "@/components/admin/AdminConsole";
import { AppShell } from "@/components/shell/AppShell";
import type { AdminBootstrap } from "@/components/admin/AdminConsole";

export const dynamic = "force-dynamic";

async function loadAdminBootstrap(): Promise<AdminBootstrap | null> {
  const authCookie = (await cookies()).get("aero_admin");
  if (!authCookie) return null;
  const apiUrl = process.env.API_URL ?? "http://localhost:4000";
  try {
    const response = await fetch(
      `${apiUrl}/api/admin/bootstrap?status=active%2Cpaused%2Cattention&limit=50`,
      {
        headers: { cookie: `${authCookie.name}=${authCookie.value}` },
        cache: "no-store",
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as AdminBootstrap;
  } catch {
    return null;
  }
}

export default async function AdminPage() {
  const initialBootstrap = await loadAdminBootstrap();
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
