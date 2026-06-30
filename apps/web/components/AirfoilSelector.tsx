"use client";

import type { AirfoilSummary } from "@aerodb/core";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { AirfoilGlyph } from "@/components/AirfoilGlyph";
import { C, MONO } from "@/lib/tokens";

export function AirfoilSelector({
  items,
  onSelect,
  exclude = [],
  triggerLabel = "＋ add airfoil…",
  disabled = false,
}: {
  items: AirfoilSummary[];
  onSelect: (a: AirfoilSummary) => void;
  exclude?: string[];
  triggerLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const [showDetails, setShowDetails] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const excludeSet = useMemo(() => new Set(exclude), [exclude]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((a) => a.name.toLowerCase().includes(q) || a.family.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setHi(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const pick = (a: AirfoilSummary) => {
    if (excludeSet.has(a.slug)) return;
    onSelect(a);
    setQuery("");
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[hi];
      if (a) pick(a);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          fontFamily: MONO,
          fontSize: 12,
          color: C.teal,
          background: C.panel3,
          border: `1px solid ${C.tealBorder}`,
          borderRadius: 999,
          padding: "7px 12px",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {triggerLabel}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: 340,
            maxWidth: "min(340px, 90vw)",
            background: C.panel,
            border: `1px solid ${C.stroke}`,
            borderRadius: 12,
            boxShadow: `0 16px 40px ${C.shadow}`,
            zIndex: 40,
            overflow: "hidden",
          }}
        >
          {/* search + details toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, borderBottom: `1px solid ${C.borderSoft}` }}>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHi(0);
              }}
              onKeyDown={onKey}
              placeholder="⌕  search airfoils…"
              style={{ flex: 1, fontFamily: MONO, fontSize: 12, color: C.text, background: C.panel2, border: `1px solid ${C.stroke}`, borderRadius: 7, padding: "7px 10px", outline: "none" }}
            />
            <button
              type="button"
              onClick={() => setShowDetails((d) => !d)}
              title="Toggle details"
              style={{ fontFamily: MONO, fontSize: 10, color: showDetails ? C.teal : C.dim, background: "none", border: `1px solid ${showDetails ? C.tealBorder : C.stroke}`, borderRadius: 6, padding: "5px 8px", cursor: "pointer", flex: "none" }}
            >
              details
            </button>
          </div>

          {/* list */}
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {filtered.length === 0 ? (
              <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim, padding: "16px 12px" }}>no match</div>
            ) : (
              filtered.map((a, i) => {
                const added = excludeSet.has(a.slug);
                return (
                  <div
                    key={a.slug}
                    onMouseEnter={() => setHi(i)}
                    onClick={() => pick(a)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      cursor: added ? "default" : "pointer",
                      background: hi === i && !added ? C.rowActive : "transparent",
                      opacity: added ? 0.55 : 1,
                      borderBottom: `1px solid ${C.borderRow}`,
                    }}
                  >
                    <AirfoilGlyph points={a.points} width={42} height={20} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                      <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>{a.family}</div>
                    </div>
                    {added ? (
                      <span style={{ fontFamily: MONO, fontSize: 10, color: C.teal, flex: "none" }}>✓ added</span>
                    ) : (
                      showDetails && (
                        <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, textAlign: "right", flex: "none", lineHeight: 1.5 }}>
                          t/c {a.thicknessPct.toFixed(1)}% · cam {a.camberPct.toFixed(1)}%
                          <br />
                          {a.ldmax == null || a.cdmin == null ? (
                            <span style={{ color: C.dim }}>no polar data</span>
                          ) : (
                            <>
                              <span style={{ color: C.teal }}>L/D {a.ldmax.toFixed(0)}</span> · Cd {a.cdmin.toFixed(4)}
                            </>
                          )}
                        </div>
                      )
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
