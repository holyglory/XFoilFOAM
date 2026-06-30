// Geometry reference fixture copied from the original Airfoils.Pro prototype.

export const RELIST = [100000, 200000, 500000, 1000000];
export const RE_COLORS = { 100000: '#f5a524', 200000: '#a78bfa', 500000: '#f56565', 1000000: '#38bdf8' };

// --- catalog definitions: t/m/p are fractions of chord ---
export const CATALOG = [
  { name: 'NACA 0012', family: 'NACA 4-digit', t: 0.12, m: 0.0, p: 0.0 },
  { name: 'NACA 0009', family: 'NACA 4-digit', t: 0.09, m: 0.0, p: 0.0 },
  { name: 'NACA 2412', family: 'NACA 4-digit', t: 0.12, m: 0.02, p: 0.40 },
  { name: 'NACA 4412', family: 'NACA 4-digit', t: 0.12, m: 0.04, p: 0.40 },
  { name: 'NACA 4415', family: 'NACA 4-digit', t: 0.15, m: 0.04, p: 0.40 },
  { name: 'NACA 23012', family: 'NACA 5-digit', t: 0.12, m: 0.018, p: 0.18 },
  { name: 'Clark Y', family: 'Classic', t: 0.117, m: 0.034, p: 0.42 },
  { name: 'GOE 398', family: 'Göttingen', t: 0.11, m: 0.05, p: 0.40 },
  { name: 'SD7037', family: 'Selig (low-Re)', t: 0.092, m: 0.031, p: 0.42 },
  { name: 'E387', family: 'Eppler', t: 0.091, m: 0.038, p: 0.45 },
  { name: 'AG24', family: 'Drela (low-Re)', t: 0.084, m: 0.022, p: 0.36 },
  { name: 'MH60', family: 'Hepperle', t: 0.101, m: 0.016, p: 0.34 },
  { name: 'S1223', family: 'Selig (high-lift)', t: 0.12, m: 0.081, p: 0.49 },
  { name: 'FX 63-137', family: 'Wortmann', t: 0.137, m: 0.06, p: 0.50 },
];

// --- geometry ---
export function buildAirfoil(params) {
  const { t, m, p } = params;
  const n = 90;
  const up = [], lo = [], cam = [];
  let areaU = 0, areaL = 0, areaC = 0, lastx = 0, lastyu = 0, lastyl = 0, lastyc = 0;
  for (let i = 0; i <= n; i++) {
    const beta = Math.PI * i / n;
    const x = (1 - Math.cos(beta)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
    let yc = 0, dyc = 0;
    if (p > 0 && m > 0) {
      if (x < p) { yc = m / (p * p) * (2 * p * x - x * x); dyc = 2 * m / (p * p) * (p - x); }
      else { yc = m / ((1 - p) * (1 - p)) * ((1 - 2 * p) + 2 * p * x - x * x); dyc = 2 * m / ((1 - p) * (1 - p)) * (p - x); }
    }
    const th = Math.atan(dyc);
    up.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lo.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
    cam.push([x, yc]);
    if (i > 0) {
      const dx = x - lastx;
      areaU += dx * (up[i][1] + lastyu) / 2;
      areaL += dx * (lo[i][1] + lastyl) / 2;
      areaC += dx * (yc + lastyc) / 2;
    }
    lastx = x; lastyu = up[i][1]; lastyl = lo[i][1]; lastyc = yc;
  }
  const contour = [];
  for (let i = up.length - 1; i >= 0; i--) contour.push({ x: up[i][0], y: up[i][1] });
  for (let i = 0; i < lo.length; i++) contour.push({ x: lo[i][0], y: lo[i][1] });
  const camber = cam.map(c => ({ x: c[0], y: c[1] }));
  return { contour, camber, areas: { upper: areaU, lower: areaL, camber: areaC }, leRadius: 1.1019 * t * t };
}

export function makePath(pts, mx, cy, scale, close) {
  let d = '';
  pts.forEach((pt, i) => { d += (i === 0 ? 'M' : 'L') + (mx + pt.x * scale).toFixed(1) + ' ' + (cy - pt.y * scale).toFixed(1) + ' '; });
  return d + (close ? 'Z' : '');
}

export function fRe(re) { return re >= 1e6 ? (re / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M' : Math.round(re / 1000) + 'k'; }
