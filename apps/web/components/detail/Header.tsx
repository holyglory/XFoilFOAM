import type { AirfoilDetailPayload } from "@aerodb/core";

import { browserUrl } from "@/lib/api";
import { C, MONO } from "@/lib/tokens";

export function DetailHeader({ detail }: { detail: AirfoilDetailPayload }) {
  const { breadcrumb, name, subtitle, tags } = detail;
  return (
    <>
      {/* breadcrumb */}
      <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, marginBottom: 14 }}>
        <span style={{ color: C.muted }}>{breadcrumb.db}</span>{" "}
        <span style={{ color: C.dimmer }}>/</span>{" "}
        <span style={{ color: C.muted }}>{breadcrumb.family}</span>{" "}
        <span style={{ color: C.dimmer }}>/</span>{" "}
        <span style={{ color: C.teal }}>{breadcrumb.name}</span>
      </div>

      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 24,
          flexWrap: "wrap",
          marginBottom: 20,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            {tags.map((tag, i) => (
              <span
                key={tag}
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: i === 0 ? "0.1em" : "0.06em",
                  color: i === 0 ? C.teal : C.muted,
                  border: `1px solid ${i === 0 ? C.tealBorder : C.stroke}`,
                  background: i === 0 ? C.tealFill : "transparent",
                  borderRadius: 5,
                  padding: "3px 8px",
                }}
              >
                {tag}
              </span>
            ))}
          </div>
          <h1 style={{ margin: 0, fontSize: 34, fontWeight: 700, letterSpacing: "-0.01em" }}>{name}</h1>
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted }}>{subtitle}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <button
            type="button"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 13,
              color: C.text,
              background: C.panel3,
              border: `1px solid ${C.stroke}`,
              borderRadius: 8,
              padding: "9px 14px",
              cursor: "pointer",
            }}
          >
            ＋ Add to compare
          </button>
          <a
            href={browserUrl(detail.downloads.selig ?? "#")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 13,
              fontWeight: 600,
              color: C.tealInk,
              background: C.teal,
              border: `1px solid ${C.teal}`,
              borderRadius: 8,
              padding: "9px 15px",
              cursor: "pointer",
            }}
          >
            ↓ Download
          </a>
        </div>
      </div>
    </>
  );
}
