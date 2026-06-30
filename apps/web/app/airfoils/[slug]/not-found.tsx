import Link from "next/link";

import { AppShell } from "@/components/shell/AppShell";
import { C, MONO } from "@/lib/tokens";

export default function NotFound() {
  return (
    <AppShell active="detail">
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "64px 22px", fontFamily: MONO }}>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>Airfoil not found.</div>
        <Link href="/" style={{ color: C.teal, fontSize: 13 }}>
          ← back to browse
        </Link>
      </div>
    </AppShell>
  );
}
