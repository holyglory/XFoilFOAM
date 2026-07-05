"use client";

import Link from "next/link";

import { C, MONO } from "@/lib/tokens";
import { BrandMark } from "./BrandMark";
import { DetailNavLink } from "./DetailNavLink";
import { ThemeToggle } from "./ThemeToggle";

const TABS = [
  { k: "browse", label: "Browse", href: "/" },
  { k: "search", label: "Search", href: "/search" },
  { k: "detail", label: "Detail", href: "" },
  { k: "compare", label: "Compare", href: "/compare" },
];

export function TopBar({ active }: { active: string }) {
  return (
    <div
      className="topbar-shell"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 20,
        padding: "0 22px",
        height: 52,
        borderBottom: `1px solid ${C.border}`,
        background: C.topbarBg,
        backdropFilter: "blur(8px)",
        position: "sticky",
        top: 0,
        zIndex: 30,
      }}
    >
      <style jsx global>{`
        @media (max-width: 860px) {
          .topbar-shell {
            gap: 10px !important;
            padding: 0 12px !important;
          }
          .topbar-jump {
            max-width: 150px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          /* Narrow viewports: the nav tab row scrolls inside its own container
             instead of pushing the actions group past the document edge. */
          .topbar-brand,
          .topbar-actions {
            flex-shrink: 0;
          }
          .topbar-tabs {
            min-width: 0;
            overflow-x: auto;
          }
          .topbar-tabs > * {
            flex-shrink: 0;
            white-space: nowrap;
          }
        }
        @media (max-width: 640px) {
          .topbar-brand-text {
            display: none;
          }
          .topbar-jump {
            display: none;
          }
        }
      `}</style>
      <Link href="/" aria-label="Airfoils.Pro home" className="topbar-brand" style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <BrandMark size={24} />
        <span className="topbar-brand-text" style={{ fontWeight: 700, letterSpacing: 0, fontSize: 14 }}>
          Airfoils<span style={{ color: C.teal }}>.Pro</span>
        </span>
      </Link>
      <div className="topbar-tabs" style={{ display: "flex", gap: 2, fontSize: 13 }}>
        {TABS.map((t) => {
          const on = t.k === active;
          if (t.k === "detail") return <DetailNavLink key={t.k} active={on} />;
          return (
            <Link
              key={t.k}
              href={t.href}
              style={{
                padding: "6px 13px",
                borderRadius: 7,
                color: on ? C.text : C.muted,
                background: on ? C.navActive : "transparent",
                fontWeight: on ? 600 : 400,
              }}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      <div
        className="topbar-actions"
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontFamily: MONO,
          fontSize: 11,
          color: C.dim,
        }}
      >
        <span className="topbar-jump" style={{ border: `1px solid ${C.stroke}`, borderRadius: 7, padding: "6px 11px", color: C.muted }}>
          ⌕&nbsp;&nbsp;jump to airfoil…
        </span>
        <ThemeToggle />
        <Link href="/admin" title="Admin" aria-label="Admin" style={{ display: "block" }}>
          <span
            style={{
              display: "block",
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: C.navActive,
              border: `1px solid ${active === "admin" ? C.teal : C.stroke}`,
            }}
          />
        </Link>
      </div>
    </div>
  );
}
