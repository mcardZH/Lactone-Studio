/** Diverging palette coordinates, anchored at physical zero rather than the range midpoint. */
export function zeroCenteredFraction(value: number, min: number, max: number): number {
  value = Math.max(min, Math.min(max, value));
  if (value === 0) return .5;
  if (value < 0) return min < 0 ? Math.max(0, Math.min(.5, .5 * (1 - value / min))) : .5;
  return max > 0 ? Math.max(.5, Math.min(1, .5 + .5 * value / max)) : .5;
}

export function interpolateColor(fraction: number, colors: readonly string[]): string {
  const position = fraction * (colors.length - 1), lower = Math.min(colors.length - 2, Math.floor(position)), blend = position - lower;
  return '#' + [1, 3, 5].map(offset => {
    const a = parseInt(colors[lower].slice(offset, offset + 2), 16), b = parseInt(colors[lower + 1].slice(offset, offset + 2), 16);
    return Math.round(a * (1 - blend) + b * blend).toString(16).padStart(2, '0');
  }).join('');
}

/** Exact piecewise-linear knots shared by CSS, SVG and canvas colorbars. */
export function zeroCenteredColorStops(min: number, max: number, colors: readonly string[], reverse = false): { offset: number; color: string }[] {
  const color = (value: number) => {
    const fraction = zeroCenteredFraction(value, min, max);
    return interpolateColor(reverse ? 1 - fraction : fraction, colors);
  };
  if (min === max) return [{ offset: 0, color: color(min) }, { offset: 1, color: color(max) }];
  const extent = Math.max(Math.abs(min), Math.abs(max));
  const offset = (value: number) => (value / extent - min / extent) / (max / extent - min / extent);
  const values = [min, max];
  // Reverse the coordinate before locating palette knots; endpoints are sampled,
  // so a one-sided physical range never acquires the opposite-sign half-palette.
  for (let i = 0; i < colors.length; i++) {
    const fraction = reverse ? 1 - i / (colors.length - 1) : i / (colors.length - 1);
    const value = fraction < .5 ? (min < 0 ? min * (1 - 2 * fraction) : 0) : (max > 0 ? max * (2 * fraction - 1) : 0);
    if (value > min && value < max) values.push(value);
  }
  // Zero is also a derivative boundary for palettes with an even stop count.
  if (min < 0 && max > 0) values.push(0);
  return [...new Set(values)].sort((a, b) => a - b).map(value => ({ offset: offset(value), color: color(value) }));
}
