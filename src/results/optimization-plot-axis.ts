import type { ResultFrameSummary, TrajectoryResult } from './contracts';
import type { CoordinateTrace } from './scientific-analysis';
import type { EnergySeries } from './energy';

export function trajectoryPlotKind(result: TrajectoryResult): 'optimization' | 'scan' | 'irc' | 'neb' | 'trajectory' {
  const stage = result.stages?.length === 1 ? result.stages[0] : undefined;
  if (stage) {
    if (['optimization', 'scan-optimization', 'ts-optimization'].includes(stage.kind)) return 'optimization';
    if (stage.kind === 'scan-points') return 'scan';
    if (stage.kind === 'irc') return 'irc';
    if (stage.kind === 'neb-path') return 'neb';
    return 'trajectory';
  }
  if (result.role === 'scan-point-set' || result.scientific?.tasks.includes('scan')) return 'scan';
  if (result.role === 'irc-full' || result.role === 'irc-branch' || result.scientific?.tasks.includes('irc')) return 'irc';
  if (result.role === 'neb-path' || result.scientific?.tasks.includes('neb')) return 'neb';
  return result.kind === 'optimization' ? 'optimization' : 'trajectory';
}

/** No energy-extremum inference. Only a unique printed TS and explicit source branches establish a centered IRC axis. */
export function trajectoryPlotAxis(result: TrajectoryResult, frames: readonly ResultFrameSummary[], override?: CoordinateTrace | null): {
  coordinates: (number | null)[]; label: string; physical: boolean; range?: [number, number]; status?: string;
} {
  const kind = trajectoryPlotKind(result);
  if (kind === 'scan' && override) {
    const values = new Map(override.points.map(point => [point.frameIndex, point.value]));
    return { coordinates: frames.map(frame => values.get(frame.index) ?? null), label: `${{ B: '键长', A: '键角', D: '二面角' }[override.kind]} / ${override.unit === 'angstrom' ? 'Å' : '°'}`, physical: true };
  }
  const firstCoordinate = frames.find(frame => frame.coordinate)?.coordinate;
  const native = firstCoordinate && firstCoordinate.unit.trim() && frames.every(frame => frame.coordinate && frame.coordinate.label === firstCoordinate.label && frame.coordinate.unit === firstCoordinate.unit && Number.isFinite(frame.coordinate.value));
  if (kind === 'irc') {
    const ts = frames.filter(frame => frame.pathDirection === 'ts');
    const branchKnown = ts.length === 1 && frames.every(frame => frame.pathDirection === 'ts' || frame.pathDirection === 'forward' || frame.pathDirection === 'reverse');
    if (branchKnown) {
      let coordinates: number[];
      let label: string;
      if (native) {
        const center = ts[0].coordinate!.value;
        coordinates = frames.map(frame => frame.coordinate!.value - center); label = `${firstCoordinate.label} / ${firstCoordinate.unit}`;
        // Printed coordinates must actually distinguish the two branches. Do not repair inconsistent signs by guessing.
        const reverse = frames.filter(frame => frame.pathDirection === 'reverse').map(frame => frame.coordinate!.value - center), forward = frames.filter(frame => frame.pathDirection === 'forward').map(frame => frame.coordinate!.value - center);
        if (reverse.some(value => value > 0) || forward.some(value => value < 0)) return { coordinates: frames.map((_, i) => i + 1), label: '来源结构帧序号', physical: false, status: 'IRC来源坐标与分支对应不一致，保留原序帧。' };
      } else {
        const numbered = frames.filter(frame => frame.pathDirection !== 'ts').every(frame => frame.pathNode !== undefined && Number.isFinite(frame.pathNode) && frame.pathNode! > 0);
        if (!numbered) return { coordinates: frames.map((_, i) => i + 1), label: '来源结构帧序号', physical: false, status: 'IRC缺少可靠的逐帧分支步数。' };
        coordinates = frames.map(frame => frame.pathDirection === 'ts' ? 0 : frame.pathDirection === 'reverse' ? -frame.pathNode! : frame.pathNode!); label = '相对 TS 的分支步数';
      }
      const extent = Math.max(...coordinates.map(Math.abs)) || 1;
      const reverseMissing = !frames.some(frame => frame.pathDirection === 'reverse'), forwardMissing = !frames.some(frame => frame.pathDirection === 'forward');
      return { coordinates, label, physical: Boolean(native), range: [-extent, extent], ...(reverseMissing || forwardMissing ? { status: `IRC${reverseMissing ? '反向' : '正向'}分支缺失。` } : {}) };
    }
    return { coordinates: frames.map((_, i) => i + 1), label: '来源结构帧序号', physical: false, status: 'IRC未确认唯一 TS 或分支归属，保留原序帧。' };
  }
  if (kind === 'scan' && native) return { coordinates: frames.map(frame => frame.coordinate!.value), label: `${firstCoordinate.label} / ${firstCoordinate.unit}`, physical: true };
  if (kind === 'optimization') { const steps = optimizationStepCoordinates(frames); return { coordinates: steps.coordinates, label: steps.printedSteps ? '优化步' : '结构帧序号（非物理时间）', physical: false }; }
  return { coordinates: frames.map((_, i) => i + 1), label: kind === 'scan' ? '扫描点序号' : kind === 'neb' ? '路径 image 序号' : '结构帧序号（非物理时间）', physical: false };
}

/** Complete source-stage rows; a display viewport never participates in this projection. */
export function trajectoryEnergyPlotText(series: EnergySeries, axis: ReturnType<typeof trajectoryPlotAxis>, scan: boolean): string {
  return [scan ? `帧\t${axis.label}\t${series.relative ? 'ΔE' : 'E'} / ${series.unit}` : `帧\t${series.relative ? 'ΔE' : 'E'} / ${series.unit}`,
    ...series.points.map((point, index) => [point.index + 1, ...(scan ? [axis.coordinates[index] ?? ''] : []), point.value ?? ''].join('\t'))].join('\n') + '\n';
}

export function normalizedPlotWidth(width: number, previous: number): number {
  return Number.isFinite(width) && width >= 1 ? Math.round(width) : previous;
}

/** Width affects only horizontal geometry. The data region retains its readable height. */
export function optimizationPlotLayout(responsive: boolean, width: number, title: string) {
  if (!responsive) return { width: 900, height: 330, left: 110, right: 860, top: 100, bottom: 245, titleLines: [title] };
  width = normalizedPlotWidth(width, 320);
  const titleLines: string[] = []; let line = '', used = 0;
  for (const character of title) {
    const size = character.charCodeAt(0) > 255 ? 14 : 8;
    if (line && used + size > width - 24) { titleLines.push(line); line = ''; used = 0; }
    line += character; used += size;
  }
  titleLines.push(line);
  const top = 46 + titleLines.length * 18, bottom = top + 180;
  return { width, height: bottom + 56, left: Math.min(96, width * .36), right: width - 16, top, bottom, titleLines };
}

/** Preserve printed optimization steps; missing steps fall back to the explicit frame axis. */
export function optimizationStepCoordinates(frames: readonly ResultFrameSummary[]): { coordinates: number[]; printedSteps: boolean } {
  const printedSteps = frames.length > 0 && frames.every(frame => frame.sourceStep !== null && Number.isFinite(frame.sourceStep));
  return { printedSteps, coordinates: frames.map(frame => printedSteps ? frame.sourceStep! : frame.index + 1) };
}

/** Includes geometry frames with missing energy. Ties deterministically choose the earlier source frame. */
export function nearestPlotFrame(frames: readonly ResultFrameSummary[], coordinates: readonly number[], coordinate: number): number | null {
  if (!Number.isFinite(coordinate)) return null;
  let chosen: number | null = null, distance = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const nextDistance = Math.abs(coordinates[i] - coordinate);
    if (nextDistance < distance) { chosen = frames[i].index; distance = nextDistance; }
  }
  return chosen;
}

/** SVG viewBox conversion follows the clicked SVG's own document, including a detached tab. */
export function plotClientX(svg: SVGSVGElement, clientX: number, clientY: number): number | null {
  return plotClientPoint(svg, clientX, clientY)?.x ?? null;
}

export function plotClientPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const matrix = svg.getScreenCTM?.();
  if (matrix && svg.createSVGPoint) {
    const point = svg.createSVGPoint(); point.x = clientX; point.y = clientY;
    return point.matrixTransform(matrix.inverse());
  }
  const bounds = svg.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  // Default xMidYMid meet letterboxes the viewBox when a CSS max-height constrains it.
  const view = svg.viewBox?.baseVal;
  const width = view?.width || 900, height = view?.height || 330;
  const scale = Math.min(bounds.width / width, bounds.height / height);
  return { x: (view?.x ?? 0) + (clientX - bounds.left - (bounds.width - width * scale) / 2) / scale,
    y: (view?.y ?? 0) + (clientY - (bounds.top ?? 0) - (bounds.height - height * scale) / 2) / scale };
}
