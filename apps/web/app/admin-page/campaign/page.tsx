import { AdminPageShell } from "@/components/admin/AdminPageShell";

// Campaign details and the current admin identity are fetched by AdminConsole
// from the protected API. The initial shell is identical for every campaign.
export const dynamic = "force-static";

export default function CampaignPage() {
  return <AdminPageShell initialBootstrap={null} />;
}
