"use client";

import { useEffect, useRef } from "react";

export const CAMPAIGN_DIAL_TICK_COUNT = 60;

export interface CampaignDialGeometry {
  centerX: number;
  centerY: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  progressEndAngle: number;
}

/** Pure geometry contract shared by the live canvas and focused unit tests. */
export function campaignDialGeometry(
  width: number,
  height: number,
  value: number,
  max: number,
): CampaignDialGeometry {
  // The approved arc nearly touches the 535×277 canvas edges. Keep only the
  // half-stroke allowance so the visible track preserves that full span.
  const pad = Math.max(6.5, Math.min(width, height) * 0.024);
  const centerX = width / 2;
  const centerY = height - 6.5;
  const radius = Math.max(0, Math.min(centerX - pad, centerY - pad));
  const finiteMax = Number.isFinite(max) && max > 0 ? max : 0;
  const finiteValue = Number.isFinite(value) ? value : 0;
  const fraction =
    finiteMax > 0 ? Math.min(1, Math.max(0, finiteValue) / finiteMax) : 0;
  const startAngle = Math.PI;
  const endAngle = Math.PI * 2;

  return {
    centerX,
    centerY,
    radius,
    startAngle,
    endAngle,
    progressEndAngle: startAngle + Math.PI * fraction,
  };
}

function cssColor(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback;
}

function drawCampaignDial(
  canvas: HTMLCanvasElement,
  value: number,
  max: number,
) {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const pixelWidth = Math.max(1, Math.round(bounds.width * dpr));
  const pixelHeight = Math.max(1, Math.round(bounds.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);

  const rootStyles = getComputedStyle(document.documentElement);
  const track = cssColor(rootStyles, "--aero-stroke", "#263441");
  const tick = cssColor(rootStyles, "--aero-dim", "#516170");
  const majorTick = cssColor(rootStyles, "--aero-muted", "#8a97a4");
  const active = cssColor(rootStyles, "--aero-teal", "#55d8c8");
  const geometry = campaignDialGeometry(
    bounds.width,
    bounds.height,
    value,
    max,
  );
  const { centerX, centerY, radius, startAngle, endAngle } = geometry;

  // Dense radial calibration marks are the dial's inner texture. Every
  // fifteenth mark is longer and brighter, matching the approved cardinal
  // ticks without implying a numeric speedometer scale.
  for (let index = 0; index <= CAMPAIGN_DIAL_TICK_COUNT; index += 1) {
    const angle = startAngle + (Math.PI * index) / CAMPAIGN_DIAL_TICK_COUNT;
    const isMajor = index % 15 === 0;
    const outer = radius - 18;
    const inner = radius - (isMajor ? 38 : 28);

    context.beginPath();
    context.moveTo(
      centerX + Math.cos(angle) * inner,
      centerY + Math.sin(angle) * inner,
    );
    context.lineTo(
      centerX + Math.cos(angle) * outer,
      centerY + Math.sin(angle) * outer,
    );
    context.strokeStyle = isMajor ? majorTick : tick;
    context.globalAlpha = isMajor ? 0.72 : 0.36;
    context.lineWidth = isMajor ? 1.55 : 1;
    context.lineCap = "butt";
    context.stroke();
  }
  context.globalAlpha = 1;

  context.beginPath();
  context.arc(centerX, centerY, radius, startAngle, endAngle);
  context.strokeStyle = track;
  context.lineWidth = 12;
  context.lineCap = "butt";
  context.stroke();

  // Never manufacture a minimum visible fraction: a tiny campaign percentage
  // stays a tiny arc. The local bloom helps it remain legible without lying.
  if (geometry.progressEndAngle > startAngle) {
    context.save();
    context.beginPath();
    context.arc(
      centerX,
      centerY,
      radius,
      startAngle,
      geometry.progressEndAngle,
    );
    context.strokeStyle = active;
    context.lineWidth = 12;
    context.lineCap = "butt";
    context.shadowColor = active;
    context.shadowBlur = 12;
    context.globalAlpha = 0.96;
    context.stroke();
    context.restore();
  }
}

export function CampaignProgressGauge({
  value,
  max,
  valueLabel,
  stateLabel,
  totalLabel,
  percentLabel,
}: {
  value: number;
  max: number;
  valueLabel: string;
  stateLabel: string;
  totalLabel: string;
  percentLabel: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const finiteMax = Number.isFinite(max) && max > 0 ? max : 0;
  const finiteValue = Number.isFinite(value) ? value : 0;
  const safeMax = finiteMax || 1;
  const safeValue = Math.min(safeMax, Math.max(0, finiteValue));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let frame = 0;
    const draw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        drawCampaignDial(canvas, safeValue, finiteMax),
      );
    };
    const resizeObserver = new ResizeObserver(draw);
    const themeObserver = new MutationObserver(draw);
    resizeObserver.observe(canvas);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    draw();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, [finiteMax, safeValue]);

  const ariaValueText =
    finiteMax > 0
      ? `${valueLabel} of ${totalLabel}, ${percentLabel} complete`
      : "No campaign points requested";

  return (
    <div
      data-testid="campaign-progress-gauge"
      className="campaign-progress-gauge"
      role="progressbar"
      aria-label="Campaign completion"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={safeValue}
      aria-valuetext={ariaValueText}
    >
      <canvas
        ref={canvasRef}
        data-testid="campaign-progress-dial-canvas"
        className="campaign-progress-dial-canvas"
        aria-hidden="true"
      />
      <div className="campaign-instrument-gauge-value">
        <strong>{valueLabel}</strong>
        <span>{stateLabel}</span>
        <small>of {totalLabel}</small>
        <b>{percentLabel} complete</b>
      </div>
    </div>
  );
}
