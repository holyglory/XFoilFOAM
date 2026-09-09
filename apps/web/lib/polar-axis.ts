export function polarAxisLayout(
  minimum: number,
  maximum: number,
  width: number,
) {
  const count = width < 440 ? 4 : 6;
  const ticks = Array.from({ length: count }, (_, index) => {
    const fraction = index / (count - 1);
    const value = minimum + (maximum - minimum) * fraction;
    return { fraction, value, label: Number(value.toPrecision(4)).toString() };
  });
  const left = Math.max(58, ...ticks.map((tick) => tick.label.length * 8 + 16));
  return { ticks, left, plotWidth: Math.max(1, width - left - 24) };
}
