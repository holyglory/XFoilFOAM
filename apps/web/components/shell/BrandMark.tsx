"use client";

import { C } from "@/lib/tokens";

export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Airfoils.Pro"
      style={{ display: "block", flex: "0 0 auto" }}
    >
      <rect
        x="3.5"
        y="3.5"
        width="25"
        height="25"
        rx="6"
        fill="rgba(45, 212, 191, 0.08)"
        stroke={C.teal}
        strokeWidth="2"
      />
      <path
        d="M8.7 17.1c4.8-3.6 10.8-3.5 15.5-.2-4.8 1.2-10.3 1.4-15.5.2Z"
        fill="none"
        stroke={C.teal}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10.2" cy="12" r="1.6" fill={C.teal} opacity="0.9" />
    </svg>
  );
}
