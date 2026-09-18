"use client";

import type { PolarMetricCondition } from "@aerodb/core";
import { conditionLabel } from "@/lib/metric-condition";
import { C } from "@/lib/tokens";

export function MetricConditionSelector({
  conditions,
  value,
  onChange,
  label = "Metrics for",
  allowBest = true,
}: {
  conditions: PolarMetricCondition[];
  value: string;
  onChange: (key: string) => void;
  label?: string;
  allowBest?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        fontSize: 12,
        color: C.muted,
      }}
    >
      <span style={{ whiteSpace: "nowrap" }}>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{
          minWidth: 0,
          width: "100%",
          maxWidth: 420,
          padding: "10px 12px",
          borderRadius: 10,
          border: `1px solid ${C.tealBorder}`,
          background: C.panel,
          color: C.text,
          fontSize: 12,
        }}
      >
        {allowBest && <option value="">Best available</option>}
        {value && !conditions.some((condition) => condition.key === value) && (
          <option value={value}>Selected condition unavailable</option>
        )}
        {conditions.map((condition, index) => (
          <option key={condition.key} value={condition.key}>
            {conditionLabel(condition)}
            {conditions.filter(
              (other) => conditionLabel(other) === conditionLabel(condition),
            ).length > 1
              ? ` · ${index + 1}`
              : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
