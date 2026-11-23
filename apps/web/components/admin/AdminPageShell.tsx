import { Suspense } from "react";
import { AdminConsole, type AdminBootstrap } from "./AdminConsole";
import { AppShell } from "@/components/shell/AppShell";

export function AdminPageShell({
  initialBootstrap,
}: {
  initialBootstrap: AdminBootstrap | null | undefined;
}) {
  return (
    <AppShell active="admin">
      <div
        style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 22px 56px" }}
      >
        <Suspense fallback={null}>
          <AdminConsole initialBootstrap={initialBootstrap} />
        </Suspense>
      </div>
    </AppShell>
  );
}
