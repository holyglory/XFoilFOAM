// Airfoils.Pro palette. Every value resolves to a CSS variable (defined in globals.css),
// so flipping `data-theme` on <html> re-themes every inline style with no re-render.
export const C = {
  bg: "var(--aero-bg)",
  panel: "var(--aero-panel)",
  panel2: "var(--aero-panel2)",
  panel3: "var(--aero-panel3)",
  border: "var(--aero-border)",
  borderSoft: "var(--aero-border-soft)",
  borderRow: "var(--aero-border-row)",
  borderRule: "var(--aero-border-rule)",
  stroke: "var(--aero-stroke)",
  stroke2: "var(--aero-stroke2)",
  text: "var(--aero-text)",
  text2: "var(--aero-text2)",
  muted: "var(--aero-muted)",
  dim: "var(--aero-dim)",
  dimmer: "var(--aero-dimmer)",
  dimmest: "var(--aero-dimmest)",
  teal: "var(--aero-teal)",
  tealBorder: "var(--aero-teal-border)",
  tealDim: "var(--aero-teal-dim)",
  tealText: "var(--aero-teal-text)",
  tealFill: "var(--aero-teal-fill)",
  tealInk: "var(--aero-teal-ink)",
  amber: "var(--aero-amber)",
  red: "var(--aero-red)",
  redText: "var(--aero-red-text)",
  // calm "awaiting URANS" stage-2 tint (approved design c19fd74a) — never an
  // error color; rejected tier-1 evidence queued for the unsteady re-solve.
  violet: "var(--aero-violet)",
  violetBorder: "var(--aero-violet-border)",
  violetFill: "var(--aero-violet-fill)",
  // chrome surfaces (were hardcoded literals)
  topbarBg: "var(--aero-topbar-bg)",
  navActive: "var(--aero-nav-active)",
  rowActive: "var(--aero-row-active)",
  tabActive: "var(--aero-tab-active)",
  popover: "var(--aero-popover)",
  modalBg: "var(--aero-modal-bg)",
  overlay: "var(--aero-overlay)",
  shadow: "var(--aero-shadow)",
  // chart chrome (themed; data-viz internals use VIZ below instead)
  grid: "var(--aero-grid)",
  gridX: "var(--aero-grid-x)",
  axis: "var(--aero-axis)",
} as const;

// Fixed data-viz palette. The polar/compare charts and the sim field canvases stay
// on a dark "scope" in BOTH themes — their multi-colour encodings are tuned for dark.
export const VIZ = {
  bg: "#070b10",
  panel: "#0a0f15",
  grid: "#16202b",
  gridX: "#131b24",
  axis: "#2a3540",
  text: "#8a97a4",
  dim: "#586572",
  popover: "#0e151d",
} as const;

export const RE_COLORS: Record<number, string> = {
  100000: "#f5a524",
  200000: "#a78bfa",
  500000: "#f56565",
  1000000: "#38bdf8",
};

export const MONO = "'IBM Plex Mono', monospace";
export const SANS = "'IBM Plex Sans', system-ui, sans-serif";
