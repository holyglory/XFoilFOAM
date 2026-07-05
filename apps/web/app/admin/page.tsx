import { Suspense } from "react";

import { AdminConsole } from "@/components/admin/AdminConsole";
import { AppShell } from "@/components/shell/AppShell";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <AppShell active="admin">
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 22px 56px" }}>
        {/* AdminConsole reads useSearchParams (URL is the routing source of
            truth, spec §11) — Next requires a Suspense boundary above it. */}
        <Suspense fallback={null}>
          <AdminConsole />
        </Suspense>
      </div>
    </AppShell>
  );
}
