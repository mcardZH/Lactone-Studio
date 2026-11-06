export interface ScientificPlotPoint { x: number; y: number | null; index?: number; label?: string; tooltip?: string; segment?: string; xEnd?: number }
export interface ScientificPlotSeries { id: string; points: readonly ScientificPlotPoint[]; label?: string; color?: string; kind?: 'line' | 'stick' | 'histogram'; pointLabels?: boolean; showPoints?: boolean }
export interface ScientificPlotViewport { x: [number, number]; y: [number, number] }

export function plotDataBounds(series: readonly ScientificPlotSeries[]): ScientificPlotViewport | null {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const line of series) for (const point of line.points) {
    if (!Number.isFinite(point.x)) continue;
    xMin = Math.min(xMin, point.x); xMax = Math.max(xMax, point.x);
    if (line.kind === 'histogram' && Number.isFinite(point.xEnd)) { xMin = Math.min(xMin, point.xEnd!); xMax = Math.max(xMax, point.xEnd!); }
    if (point.y === null || !Number.isFinite(point.y)) continue;
    yMin = Math.min(yMin, point.y); yMax = Math.max(yMax, point.y);
    if (line.kind === 'stick' || line.kind === 'histogram') { yMin = Math.min(0, yMin); yMax = Math.max(0, yMax); }
  }
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite)) return null;
  const xPadding = xMax === xMin ? Math.max(Math.abs(xMin) * .01, .5) : 0;
  const yPadding = (yMax - yMin) * .12 || Math.max(Math.abs(yMin) * 1e-7, 1e-6);
  return { x: [xMin - xPadding, xMax + xPadding], y: [yMin - yPadding, yMax + yPadding] };
}

export function validPlotViewport(value: ScientificPlotViewport | null | undefined): value is ScientificPlotViewport {
  return Boolean(value && [...value.x, ...value.y].every(Number.isFinite) && value.x[0] < value.x[1] && value.y[0] < value.y[1]);
}

export function plotTicks(range: readonly [number, number], pixels: number, minimumSpacing = 76): { major: number[]; minor: number[]; step: number } {
  const [low, high] = range, span = high - low;
  if (!(span > 0) || !Number.isFinite(span)) return { major: [], minor: [], step: 0 };
  const target = span / Math.max(1, Math.floor(pixels / minimumSpacing));
  const power = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 2.5, 5, 10].find(value => value * power >= target)! * power;
  const major: number[] = [], minor: number[] = [];
  const substep = step / 5, start = Math.ceil((low - substep * 1e-7) / substep);
  for (let ordinal = start; ordinal <= Math.floor((high + substep * 1e-7) / substep) && ordinal < start + 200; ordinal++) {
    const value = Number((ordinal * substep).toPrecision(14));
    (ordinal % 5 === 0 ? major : minor).push(Object.is(value, -0) ? 0 : value);
  }
  // A narrow range between round values still needs a readable numerical axis.
  if (major.length < 2) return { major: [low, high], minor: minor.filter(value => value > low && value < high), step };
  return { major, minor, step };
}

export function formatPlotTick(value: number, step: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude > 0 && magnitude < 1e-4) {
    const decimals = Math.max(3, Math.min(12, Math.floor(Math.log10(magnitude)) - Math.floor(Math.log10(step || magnitude)) + 1));
    return value.toExponential(decimals);
  }
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step || 1)) + 1));
  return Number(value.toFixed(decimals)).toString();
}

/** Source order and real frame identities survive reversed/nonmonotonic axes and gaps. */
export function nearestScientificPlotIndex(series: readonly ScientificPlotSeries[], x: number): number | null {
  if (!Number.isFinite(x)) return null;
  let chosen: number | null = null, distance = Infinity;
  for (const line of series) for (const point of line.points) {
    if (point.index === undefined || !Number.isFinite(point.x)) continue;
    const next = Math.abs(point.x - x);
    if (next < distance) { chosen = point.index; distance = next; }
  }
  return chosen;
}

/** Pick actual stick geometry, including its baseline and endpoint. Equal-distance
 * overlaps prefer the nearest endpoint, then source identity, independently of
 * SVG paint/DOM order. */
export function nearestScientificStickIndex(series: readonly ScientificPlotSeries[], position: { x: number; y: number },
  projectX: (value: number) => number, projectY: (value: number) => number, tolerance = 8): number | null {
  let chosen: number | null = null, distance = tolerance * tolerance, endpointDistance = Infinity;
  for (const line of series) if (line.kind === 'stick') for (const point of line.points) {
    if (point.index === undefined || point.y === null || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const px = projectX(point.x), baseline = projectY(0), endpoint = projectY(point.y);
    const py = Math.max(Math.min(baseline, endpoint), Math.min(Math.max(baseline, endpoint), position.y));
    const next = (position.x - px) ** 2 + (position.y - py) ** 2;
    const nextEndpoint = (position.x - px) ** 2 + (position.y - endpoint) ** 2;
    if (next < distance || next === distance && (nextEndpoint < endpointDistance || nextEndpoint === endpointDistance && (chosen === null || point.index < chosen))) {
      chosen = point.index; distance = next; endpointDistance = nextEndpoint;
    }
  }
  return chosen;
}

/** Bounded presentation only. Null/nonfinite rows and source segment boundaries always break a path. */
export function scientificPlotPaths(points: readonly ScientificPlotPoint[], x: (value: number) => number, y: (value: number) => number): string[] {
  const paths: string[] = []; let path = '', segment: string | undefined;
  for (const point of points) {
    if (!Number.isFinite(point.x) || point.y === null || !Number.isFinite(point.y) || segment !== undefined && point.segment !== undefined && segment !== point.segment) {
      if (path) paths.push(path); path = '';
    }
    if (Number.isFinite(point.x) && point.y !== null && Number.isFinite(point.y)) path += `${path ? ' L' : 'M'}${x(point.x).toFixed(2)},${y(point.y).toFixed(2)}`;
    segment = point.segment;
  }
  if (path) paths.push(path);
  return paths;
}

export function sampleScientificPlotPoints(points: readonly ScientificPlotPoint[], budget = 1200): readonly ScientificPlotPoint[] {
  if (points.length <= budget) return points;
  const width = Math.ceil(points.length / Math.max(1, Math.floor(budget / 6))), sampled: ScientificPlotPoint[] = [];
  for (let start = 0; start < points.length; start += width) {
    const end = Math.min(points.length, start + width) - 1;
    let min = start, max = start, gap = -1, boundary = -1;
    for (let i = start; i <= end; i++) {
      if (i > start && points[i].segment !== points[i - 1].segment) boundary = i;
      const value = points[i].y;
      if (value === null || !Number.isFinite(value) || !Number.isFinite(points[i].x)) { if (gap < 0) gap = i; }
      else {
        if (points[min].y === null || !Number.isFinite(points[min].y) || value < points[min].y!) min = i;
        if (points[max].y === null || !Number.isFinite(points[max].y) || value > points[max].y!) max = i;
      }
    }
    if (gap >= 0 || boundary >= 0) {
      // Conservative unknown bin: do not join extrema across any hidden gap/boundary.
      sampled.push(points[start], { x: points[start].x, y: null }, points[end]);
    } else for (const i of [...new Set([start, min, max, end])].sort((a, b) => a - b)) sampled.push(points[i]);
  }
  return sampled;
}

export function zoomPlotViewport(viewport: ScientificPlotViewport, start: { x: number; y: number }, end: { x: number; y: number },
  bounds: { left: number; right: number; top: number; bottom: number }, reverseX = false, reverseY = false): ScientificPlotViewport | null {
  const fraction = (value: number, low: number, high: number) => Math.max(0, Math.min(1, (value - low) / (high - low)));
  const atX = (value: number) => { const f = fraction(value, bounds.left, bounds.right); return viewport.x[0] + (reverseX ? 1 - f : f) * (viewport.x[1] - viewport.x[0]); };
  const atY = (value: number) => { const f = fraction(value, bounds.top, bounds.bottom); return viewport.y[0] + (reverseY ? f : 1 - f) * (viewport.y[1] - viewport.y[0]); };
  const x = [atX(start.x), atX(end.x)].sort((a, b) => a - b) as [number, number];
  const y = [atY(start.y), atY(end.y)].sort((a, b) => a - b) as [number, number];
  const next = { x, y }; return validPlotViewport(next) ? next : null;
}
