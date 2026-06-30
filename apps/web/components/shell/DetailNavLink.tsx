"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { C } from "@/lib/tokens";

export function DetailNavLink({ active }: { active: boolean }) {
  const [href, setHref] = useState("/?chooseDetail=1");

  useEffect(() => {
    const slug = window.localStorage.getItem("aerodb-last-detail-slug");
    setHref(slug ? `/airfoils/${slug}` : "/?chooseDetail=1");
  }, []);

  return (
    <Link
      href={href}
      style={{
        padding: "6px 13px",
        borderRadius: 7,
        color: active ? C.text : C.muted,
        background: active ? C.navActive : "transparent",
        fontWeight: active ? 600 : 400,
      }}
    >
      Detail
    </Link>
  );
}
