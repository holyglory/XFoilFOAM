"use client";

import Link from "next/link";
import { type MouseEventHandler, useEffect, useState } from "react";

import { C } from "@/lib/tokens";

export function DetailNavLink({
  active,
  mobile = false,
  onNavigate,
}: {
  active: boolean;
  mobile?: boolean;
  onNavigate?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const [href, setHref] = useState("/?chooseDetail=1");

  useEffect(() => {
    const slug = window.localStorage.getItem("aerodb-last-detail-slug");
    setHref(slug ? `/airfoils/${slug}` : "/?chooseDetail=1");
  }, []);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      style={{
        padding: "6px 13px",
        borderRadius: 7,
        color: active ? C.text : C.muted,
        background: active ? C.navActive : "transparent",
        fontWeight: active ? 600 : 400,
        display: mobile ? "block" : undefined,
        width: mobile ? "100%" : undefined,
      }}
    >
      Detail
    </Link>
  );
}
