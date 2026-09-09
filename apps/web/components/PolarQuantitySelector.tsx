"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./PolarControls.module.css";

export const POLAR_QUANTITY_LABELS = {
  cl: "Lift",
  cd: "Drag",
  cm: "Pitching moment",
  ld: "Lift / drag",
  polar: "Drag polar",
} as const;

export type PolarQuantity = keyof typeof POLAR_QUANTITY_LABELS;

const SHORT_LABELS: Record<PolarQuantity, string> = {
  cl: "Cl",
  cd: "Cd",
  cm: "Cm",
  ld: "L/D",
  polar: "Cl–Cd",
};

export function PolarQuantitySelector({
  value,
  onChange,
  disabled,
  label,
}: {
  value: PolarQuantity;
  onChange: (value: PolarQuantity) => void;
  disabled: boolean;
  label: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(true);
  useEffect(() => {
    const row = root.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const buttons = [...row.querySelectorAll("button")];
    const labels = [...row.querySelectorAll<HTMLElement>("[data-full-label]")];
    const measure = () => {
      const rowStyle = getComputedStyle(row);
      const gap = Number.parseFloat(
        rowStyle.getPropertyValue("--quantity-label-gap"),
      );
      const padding = Number.parseFloat(
        rowStyle.getPropertyValue("--quantity-label-padding"),
      );
      const required = buttons.reduce(
        (total, button, index) => {
          const style = getComputedStyle(button);
          const spacing = [
            style.borderLeftWidth,
            style.borderRightWidth,
          ].reduce(
            (sum, width) => sum + (Number.parseFloat(width) || 0),
            2 * padding,
          );
          return (
            total +
            Math.max(
              Number.parseFloat(style.minWidth) || 0,
              labels[index].getBoundingClientRect().width + spacing,
            )
          );
        },
        gap * Math.max(0, buttons.length - 1),
      );
      setCompact(required > row.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    for (const node of labels) observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      className={styles.quantities}
      data-compact={compact}
    >
      {(Object.entries(POLAR_QUANTITY_LABELS) as [PolarQuantity, string][]).map(
        ([key, name]) => (
          <button
            key={key}
            type="button"
            className={styles.quantity}
            disabled={disabled}
            aria-label={name}
            title={name}
            aria-pressed={value === key}
            onClick={() => onChange(key)}
          >
            <span
              data-expanded-label
              aria-hidden="true"
              className={styles.fullLabel}
            >
              {name}
            </span>
            <span aria-hidden="true" className={styles.shortLabel}>
              {SHORT_LABELS[key]}
            </span>
          </button>
        ),
      )}
      <span aria-hidden="true" className={styles.measurements}>
        {Object.entries(POLAR_QUANTITY_LABELS).map(([key, name]) => (
          <span
            key={key}
            data-full-label
            data-expanded-label
            className={styles.measuredLabel}
          >
            {name}
          </span>
        ))}
      </span>
    </div>
  );
}
