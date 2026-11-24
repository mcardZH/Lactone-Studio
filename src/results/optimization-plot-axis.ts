import type { ResultFrameSummary, TrajectoryResult } from './contracts';
import type { CoordinateTrace } from './scientific-analysis';
import type { EnergySeries } from './energy';
import { decimalEnergyValue } from './numeric-format';

export type TrajectoryPlotResult = Pick<TrajectoryResult, 'id' | 'jobIndex' | 'frames' | 'source' | 'kind' | 'stages' | 'role' | 'scientific'>;

export const internalCoordinateName = { B: 'Bond Length', A: 'Bond Angle', D: 'Dihedral Angle' } as const;
export const plotCoordinateUnit = (unit: string) => unit === 'angstrom' ? 'Å' : unit === 'degree' ? '°' : unit;
export const plotSourceFrameIndex = (frame: ResultFrameSummary) => frame.sourceFrameIndex ?? frame.index;

export interface TrajectoryPlotSourceAxis {
  label: string;
  unit?: string;
  coordinates: readonly (number | null)[];
}

interface TrajectoryPlotAxis {
  coordinates: (number | null)[];
  label: string;
  unit?: string;
  physical: boolean;
  range?: [number, number];
  status?: string;
}

export function trajectoryPlotKind(result: TrajectoryPlotResult): 'optimization' | 'scan' | 'irc' | 'neb' | 'trajectory' {
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
export function trajectoryPlotAxis(result: TrajectoryPlotResult, frames: readonly ResultFrameSummary[], override?: CoordinateTrace | null): TrajectoryPlotAxis {
  const kind = trajectoryPlotKind(result);
  if (kind === 'scan' && override) {
    const values = new Map(override.points.map(point => [point.frameIndex, point.value]));
    const unit = plotCoordinateUnit(override.unit);
    return { coordinates: frames.map(frame => values.get(frame.index) ?? null), label: `${internalCoordinateName[override.kind]} (${unit})`, unit, physical: true };
  }
  const firstCoordinate = frames.find(frame => frame.coordinate)?.coordinate;
  const consistent = firstCoordinate && firstCoordinate.unit.trim() && frames.every(frame => !frame.coordinate
    || frame.coordinate.unit === firstCoordinate.unit && (kind === 'irc' || frame.coordinate.label === firstCoordinate.label));
  const coordinateValue = (frame: ResultFrameSummary) => frame.coordinate && Number.isFinite(frame.coordinate.value) ? frame.coordinate.value : null;
  if (kind === 'irc') {
    const ts = frames.filter(frame => frame.pathDirection === 'ts');
    const branchKnown = ts.length === 1 && frames.every(frame => frame.pathDirection === 'ts' || frame.pathDirection === 'forward' || frame.pathDirection === 'reverse');
    if (branchKnown) {
      let coordinates: (number | null)[];
      let label: string, unit: string | undefined;
      const center = coordinateValue(ts[0]);
      const native = consistent && center !== null && firstCoordinate.unit !== 'step';
      if (native) {
        unit = plotCoordinateUnit(firstCoordinate.unit);
        coordinates = frames.map(frame => {
          const value = coordinateValue(frame);
          return value === null ? null : value - center;
        });
        label = `IRC Coordinate (${unit})`;
        // Printed coordinates must actually distinguish the two branches. Do not repair inconsistent signs by guessing.
        if (coordinates.some((value, index) => value !== null &&
          (frames[index].pathDirection === 'reverse' && value > 0 || frames[index].pathDirection === 'forward' && value < 0))) {
          return { coordinates: frames.map((_, i) => i + 1), label: 'Source Frame', physical: false, status: 'IRC 来源坐标与分支对应不一致，保留原序帧。' };
        }
      } else {
        const numbered = frames.filter(frame => frame.pathDirection !== 'ts').every(frame => frame.pathNode !== undefined && Number.isFinite(frame.pathNode) && frame.pathNode! > 0);
        if (!numbered) return { coordinates: frames.map((_, i) => i + 1), label: 'Source Frame', physical: false, status: 'IRC 缺少可靠的逐帧分支步数。' };
        coordinates = frames.map(frame => frame.pathDirection === 'ts' ? 0 : frame.pathDirection === 'reverse' ? -frame.pathNode! : frame.pathNode!); label = 'IRC Branch Step from TS';
      }
      const extent = coordinates.reduce<number>((bound, value) => Math.max(bound, Math.abs(value ?? 0)), 0) || 1;
      const reverseMissing = !frames.some(frame => frame.pathDirection === 'reverse'), forwardMissing = !frames.some(frame => frame.pathDirection === 'forward');
      return { coordinates, label, unit, physical: Boolean(native), range: [-extent, extent], ...(reverseMissing || forwardMissing ? { status: `IRC${reverseMissing ? '反向' : '正向'}分支缺失。` } : {}) };
    }
    if (consistent && firstCoordinate.unit !== 'step' && frames.some(frame => coordinateValue(frame) !== null)) {
      const unit = plotCoordinateUnit(firstCoordinate.unit);
      return { coordinates: frames.map(coordinateValue), label: `IRC Coordinate (${unit})`, unit, physical: true };
    }
    return { coordinates: frames.map((_, i) => i + 1), label: 'Source Frame', physical: false, status: 'IRC 未确认唯一 TS 或分支归属，保留原序帧。' };
  }
  if (kind === 'scan' && consistent && frames.some(frame => coordinateValue(frame) !== null)) {
    const unit = plotCoordinateUnit(firstCoordinate.unit);
    const name = result.scientific?.scanCoordinates?.length === 1
      ? { bond: 'Bond Length', angle: 'Bond Angle', dihedral: 'Dihedral Angle' }[result.scientific.scanCoordinates[0].kind]
      : /^[\x20-\x7e]+$/.test(firstCoordinate.label) ? firstCoordinate.label : 'Scan Coordinate';
    return { coordinates: frames.map(coordinateValue), label: `${name} (${unit})`, unit, physical: true };
  }
  if (kind === 'optimization') { const steps = optimizationStepCoordinates(frames); return { coordinates: steps.coordinates, label: steps.printedSteps ? 'Optimization Step' : 'Frame Index', physical: false }; }
  if (kind === 'neb' && frames.some(frame => frame.sourcePathImage !== undefined || frame.pathImage !== undefined)) {
    return { coordinates: frames.map(frame => frame.sourcePathImage ?? frame.pathImage ?? null), label: 'Image Index', physical: false };
  }
  return { coordinates: frames.map((frame, i) => kind === 'scan' ? frame.pathNode ?? i + 1 : i + 1),
    label: kind === 'scan' ? 'Scan Point' : kind === 'neb' ? 'Image Index' : 'Frame Index', physical: false };
}

/** Supplied coordinates belong to the unprojected source, including when an
 * IRC stage reorders the reverse branch. Planned positions never become frames. */
export function trajectoryDisplayAxis(result: TrajectoryPlotResult, frames: readonly ResultFrameSummary[], options: {
  supplied?: TrajectoryPlotSourceAxis; coordinateTrace?: CoordinateTrace | null;
  scanOrdinal?: boolean; scanPointNumbers?: boolean; symmetricIrc?: boolean;
}): TrajectoryPlotAxis {
  if (options.supplied) {
    const source = options.supplied;
    const coordinates = frames.map(frame => source.coordinates[plotSourceFrameIndex(frame)] ?? null);
    let extent = 0;
    if (options.symmetricIrc) {
      for (const value of coordinates) if (value !== null && Number.isFinite(value)) extent = Math.max(extent, Math.abs(value));
    }
    return { ...source, coordinates, physical: Boolean(source.unit), range: extent > 0 ? [-extent, extent] : undefined };
  }
  const axis = trajectoryPlotAxis(result, frames, options.coordinateTrace);
  if (trajectoryPlotKind(result) !== 'scan' || !options.scanOrdinal && !(options.scanPointNumbers && !axis.physical)) return axis;
  return {
    coordinates: frames.map((frame, index) => options.scanPointNumbers && frame.sourceStep !== null ? frame.sourceStep + 1 : frame.pathNode ?? index + 1),
    label: 'Scan Point', physical: false,
  };
}

/** Complete source-stage rows; a display viewport never participates in this projection. */
export function trajectoryEnergyPlotText(series: EnergySeries, axis: TrajectoryPlotAxis, scan: boolean): string {
  return [scan ? `帧\t${axis.label}\t${series.relative ? 'ΔE' : 'E'} / ${series.unit}` : `帧\t${series.relative ? 'ΔE' : 'E'} / ${series.unit}`,
    ...series.points.map((point, index) => [point.index + 1, ...(scan ? [axis.coordinates[index] ?? ''] : []), point.value == null?'':decimalEnergyValue(point.value)].join('\t'))].join('\n') + '\n';
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
