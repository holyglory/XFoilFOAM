"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

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
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const adminSurface = active === "admin";

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest("[data-public-menu-root]")
      ) {
        setMenuOpen(false);
      }
    };

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", closeOnOutsideClick);
    };
  }, [menuOpen]);

  return (
    <header
      className="topbar-shell"
      data-surface={adminSurface ? "admin" : "public"}
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
        .topbar-shell {
          isolation: isolate;
        }
        .topbar-public-menu-button,
        .topbar-mobile-menu {
          display: none;
        }
        .topbar-admin-context {
          border-left: 1px solid ${C.stroke};
          padding-left: 12px;
          color: ${C.muted};
          font-family: ${MONO};
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        @media (max-width: 860px) {
          .topbar-shell {
            gap: 10px !important;
            padding: 0 12px !important;
          }
          .topbar-shell[data-surface="public"] .topbar-tabs,
          .topbar-jump {
            display: none;
          }
          .topbar-brand,
          .topbar-actions {
            flex-shrink: 0;
          }
          .topbar-public-menu-button {
            display: inline-grid;
            place-items: center;
            width: 34px;
            height: 34px;
            flex: none;
            padding: 0;
            color: ${C.muted};
            background: ${C.panel2};
            border: 1px solid ${C.stroke};
            border-radius: 8px;
            cursor: pointer;
          }
          .topbar-public-menu-button:hover,
          .topbar-public-menu-button:focus-visible {
            color: ${C.text};
            border-color: ${C.tealBorder};
            outline: none;
          }
          .topbar-mobile-menu[data-open="true"] {
            position: absolute;
            top: calc(100% + 7px);
            right: 12px;
            z-index: 40;
            display: grid;
            width: min(270px, calc(100vw - 24px));
            gap: 3px;
            padding: 7px;
            background: ${C.popover};
            border: 1px solid ${C.stroke};
            border-radius: 10px;
            box-shadow: 0 16px 38px ${C.shadow};
            font-size: 13px;
          }
          .topbar-mobile-menu > a {
            min-width: 0;
            padding: 10px 11px !important;
            white-space: normal;
          }
        }
        @media (max-width: 360px) {
          .topbar-brand-text {
            display: none;
          }
        }
      `}</style>
      <Link
        href={adminSurface ? "/admin" : "/"}
        aria-label={
          adminSurface ? "Airfoils.Pro admin home" : "Airfoils.Pro home"
        }
        className="topbar-brand"
        style={{ display: "flex", alignItems: "center", gap: 9 }}
      >
        <BrandMark size={24} />
        <span
          className="topbar-brand-text"
          style={{ fontWeight: 700, letterSpacing: 0, fontSize: 14 }}
        >
          Airfoils<span style={{ color: C.teal }}>.Pro</span>
        </span>
      </Link>
      {adminSurface ? (
        <span className="topbar-admin-context">Admin</span>
      ) : (
        <nav
          className="topbar-tabs"
          aria-label="Public navigation"
          style={{ display: "flex", gap: 2, fontSize: 13 }}
        >
          {TABS.map((t) => {
            const on = t.k === active;
            if (t.k === "detail")
              return <DetailNavLink key={t.k} active={on} />;
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
        </nav>
      )}
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
        {!adminSurface && (
          <>
            <Link
              href="/search"
              className="topbar-jump"
              style={{
                border: `1px solid ${C.stroke}`,
                borderRadius: 7,
                padding: "6px 11px",
                color: C.muted,
              }}
            >
              ⌕&nbsp;&nbsp;jump to airfoil…
            </Link>
            <div data-public-menu-root>
              <button
                type="button"
                className="topbar-public-menu-button"
                data-testid="public-nav-menu-button"
                aria-label={
                  menuOpen
                    ? "Close public navigation"
                    : "Open public navigation"
                }
                aria-expanded={menuOpen}
                aria-controls="public-mobile-navigation"
                onClick={() => setMenuOpen((open) => !open)}
              >
                {menuOpen ? <X size={18} /> : <Menu size={18} />}
              </button>
              <nav
                id="public-mobile-navigation"
                className="topbar-mobile-menu"
                data-open={menuOpen ? "true" : "false"}
                aria-label="Public navigation"
              >
                {TABS.map((t) => {
                  const on = t.k === active;
                  if (t.k === "detail") {
                    return (
                      <DetailNavLink
                        key={t.k}
                        active={on}
                        mobile
                        onNavigate={() => setMenuOpen(false)}
                      />
                    );
                  }
                  return (
                    <Link
                      key={t.k}
                      href={t.href}
                      onClick={() => setMenuOpen(false)}
                      style={{
                        display: "block",
                        width: "100%",
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
              </nav>
            </div>
          </>
        )}
        <ThemeToggle />
        {!adminSurface && (
          <Link
            href="/admin"
            title="Admin"
            aria-label="Open admin"
            style={{ display: "block" }}
          >
            <span
              style={{
                display: "block",
                width: 26,
                height: 26,
                borderRadius: "50%",
                background: C.navActive,
                border: `1px solid ${C.stroke}`,
              }}
            />
          </Link>
        )}
      </div>
    </header>
  );
}
