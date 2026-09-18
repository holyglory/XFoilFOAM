"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { CSSProperties } from "react";
import { comparisonHref } from "@/lib/compare-selection";
import {
  metricConditionParam,
  withMetricCondition,
} from "@/lib/metric-condition";

export function ConditionComparisonLink({
  slug,
  style,
}: {
  slug: string;
  style: CSSProperties;
}) {
  const query = useSearchParams();
  const condition = metricConditionParam(query.get("condition") ?? undefined);
  return (
    <Link
      href={withMetricCondition(comparisonHref([slug]), condition)}
      style={style}
    >
      Compare
    </Link>
  );
}
