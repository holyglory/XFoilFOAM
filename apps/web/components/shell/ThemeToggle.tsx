"use client";

import { useEffect, useState } from "react";

import { C } from "@/lib/tokens";

type Theme = "dark" | "light";

export function ThemeToggle() {
  // Server + first client render assume the SSR default (dark) to avoid a hydration
  // mismatch; useEffect then syncs to whatever the no-flash script already applied.
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    if (t === "light" || t === "dark") setTheme(t);
  }, []);

  const apply = (t: Theme) => {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("aero-theme", t);
    } catch {
      /* ignore */
    }
    setTheme(t);
  };

  const isLight = theme === "light";
  return (
    <button
      type="button"
      onClick={() => apply(isLight ? "dark" : "light")}
      aria-label={`Switch to ${isLight ? "dark" : "light"} theme`}
      title={`Switch to ${isLight ? "dark" : "light"} theme`}
      style={{
        position: "relative",
        width: 54,
        height: 26,
        borderRadius: 999,
        border: `1px solid ${C.stroke}`,
        background: C.panel3,
        cursor: "pointer",
        padding: 0,
        flex: "none",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: "50%",
          left: isLight ? 4 : 30,
          transform: "translateY(-50%)",
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: C.teal,
          color: C.tealInk,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          lineHeight: 1,
          transition: "left 0.18s ease",
        }}
      >
        {isLight ? "☀" : "☾"}
      </span>
    </button>
  );
}
