// Scientific colormaps shared by real OpenFOAM post-processing helpers.

export type RGB = [number, number, number];

export function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Diverging blue-white-red, input clamped to [-1, 1]. */
export function coolwarm(v: number): string {
  v = Math.max(-1, Math.min(1, v));
  const c =
    v < 0
      ? lerp3([40, 64, 170], [232, 234, 240], v + 1)
      : lerp3([232, 234, 240], [196, 32, 46], v);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Perceptual viridis, input clamped to [0, 1]. */
export function viridis(t: number): string {
  t = Math.max(0, Math.min(1, t));
  const st: RGB[] = [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ];
  const x = t * 4;
  const i = Math.min(3, Math.floor(x));
  const f = x - i;
  const c = lerp3(st[i], st[i + 1], f);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
