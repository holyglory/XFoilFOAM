import type { ReactNode } from "react";

import { C, SANS } from "@/lib/tokens";
import { TopBar } from "./TopBar";

export function AppShell({ active, children }: { active: string; children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: C.bg,
        backgroundImage: "radial-gradient(circle at 18% -10%, rgba(45,212,191,0.06), transparent 45%)",
        fontFamily: SANS,
        color: C.text,
      }}
    >
      <TopBar active={active} />
      {children}
    </div>
  );
}
