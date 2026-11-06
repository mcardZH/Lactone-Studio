import type { Atom, Bond, Structure, Vector3 } from '../../../core/types';
import type { DisplaySettings } from '../../../modeling/contracts';
import { cartesianToFractional, fractionalToCartesian } from '../../../core/periodic';
import { add, coordinates, cross, dot, scale, subtract } from './geometry';
import {finishRenderWork,type RenderWork} from './render-work';

export const DEFAULT_PERIODIC_DISPLAY = { boundaryStyle: 'stubs' as const, outerColor: '#9a6b88', images: false, rangeAngstrom: 0, showCrossBoxBonds:true };
export const periodicDisplaySettings = (display: DisplaySettings) => ({ ...DEFAULT_PERIODIC_DISPLAY, ...display.periodicDisplay });
export interface PeriodicDisplayInstance { sourceIndex: number; image: Vector3; position: Vector3; base: boolean }
export interface PeriodicDisplayConnection { start: Vector3; end: Vector3; shift: Vector3; full: boolean; base: boolean; sourceIndex: number }
export interface PeriodicDisplayConnectionContext {
  readonly structure: Structure; readonly positions: readonly Atom[]; readonly instances: readonly PeriodicDisplayInstance[]; readonly display: DisplaySettings;
  readonly cell: Structure['cell'];
  readonly visible: ReadonlySet<string>; readonly occupied: ReadonlySet<string>;
  readonly bySource: ReadonlyMap<number, readonly { instance: PeriodicDisplayInstance; ordinal: number }[]>;
}
const ZERO: Vector3 = [0, 0, 0];
const imageKey = (index: number, image: Vector3) => `${index}:${image.join(',')}`;
const positionKey = (position: Vector3) => position.map(v => Math.abs(v)>Number.MAX_VALUE/1e7?`raw:${v}`:String(Math.round(v * 1e7))).join(',');
const isZero = (image: Vector3) => image.every(n => n === 0);

/** One immutable draw/frame inventory, never a cache across source/cell changes. */
export function preparePeriodicDisplayConnections(structure: Structure, positions: readonly Atom[], instances: readonly PeriodicDisplayInstance[], display: DisplaySettings): PeriodicDisplayConnectionContext {
  return finishRenderWork(preparePeriodicDisplayConnectionsWork(structure,positions,instances,display));
}
export function* preparePeriodicDisplayConnectionsWork(structure: Structure, positions: readonly Atom[], instances: readonly PeriodicDisplayInstance[], display: DisplaySettings):RenderWork<PeriodicDisplayConnectionContext> {
  const bySource = new Map<number, { instance: PeriodicDisplayInstance; ordinal: number }[]>();
  const visible=new Set<string>(),occupied=new Set<string>();
  for (const [ordinal,instance] of instances.entries()) {
    yield;visible.add(imageKey(instance.sourceIndex,instance.image));occupied.add(positionKey(instance.position));
    const group = bySource.get(instance.sourceIndex);
    if (group) group.push({ instance, ordinal }); else bySource.set(instance.sourceIndex, [{ instance, ordinal }]);
  }
  return { structure, positions, instances, display, cell: structure.cell, bySource,
    visible,occupied };
}

function* endpointInstances(context: PeriodicDisplayConnectionContext, a: number, b: number):Generator<PeriodicDisplayInstance> {
  const first = context.bySource.get(a) ?? [], second = a === b ? [] : context.bySource.get(b) ?? [];
  let i = 0, j = 0;
  // Preserve the original global traversal, including interleaved mirror rows.
  while (i < first.length || j < second.length) {
    if (j === second.length || i < first.length && first[i].ordinal < second[j].ordinal) yield first[i++].instance;
    else yield second[j++].instance;
  }
}

/** A presentation inventory only. Neither atoms nor graph identities are added
 * to Structure. Closed fractional faces give FCC's 4 source atoms 14 spheres.
 * Positive distance expands each real face by its Cartesian perpendicular Å. */
export function periodicDisplayInstances(structure: Structure, positions: readonly Atom[], display: DisplaySettings, hidden: ReadonlySet<string> = new Set()): PeriodicDisplayInstance[] {
  return finishRenderWork(periodicDisplayInstancesWork(structure,positions,display,hidden));
}
export function* periodicDisplayInstancesWork(structure: Structure, positions: readonly Atom[], display: DisplaySettings, hidden: ReadonlySet<string> = new Set()):RenderWork<PeriodicDisplayInstance[]> {
  const instances: PeriodicDisplayInstance[] = [], occupied = new Set<string>();
  for (let index = 0; index < positions.length; index++) if (!hidden.has(positions[index].id!)) {
    yield;
    const position = coordinates(positions[index]);if(!position.every(Number.isFinite))throw new Error('周期显示需要有限坐标。'); instances.push({ sourceIndex: index, image: [...ZERO], position, base: true }); occupied.add(positionKey(position));
  }
  const settings = periodicDisplaySettings(display), cell = structure.cell;
  if(!Number.isFinite(settings.rangeAngstrom)||settings.rangeAngstrom<0)throw new Error('周期镜像外扩距离须为非负有限数值。');
  if (!settings.images || !cell?.pbc.some(Boolean) || !positions.length) return instances;
  const [a, b, c] = cell.vectors, volume = dot(a, cross(b, c));
  if (!Number.isFinite(volume) || Math.abs(volume) < 1e-12) throw new Error('周期镜像需要有效的真实晶胞。');
  const reciprocal = [cross(b, c), cross(c, a), cross(a, b)].map(v => scale(v, 1 / volume));
  const margins = reciprocal.map(v => settings.rangeAngstrom * Math.hypot(...v));
  let candidates = 0;
  for (let index = 0; index < positions.length; index++) {
    if (hidden.has(positions[index].id!)) continue;
    const source = coordinates(positions[index]), f = cartesianToFractional(cell, source);
    const bounds = f.map((value, axis) => cell.pbc[axis] ? [Math.ceil(-margins[axis] - value - 1e-8), Math.floor(1 + margins[axis] - value + 1e-8)] : [0, 0]);
    if(bounds.some(pair=>pair.some(value=>!Number.isSafeInteger(value))))throw new Error('周期镜像整数范围超出可精确表示范围。');
    const count = bounds.reduce((n, [lo, hi]) => n * Math.max(0, hi - lo + 1), 1);
    candidates += count;
    if (!Number.isSafeInteger(candidates)) throw new Error('周期镜像候选数超出可精确表示范围。');
    for (let x = bounds[0][0]; x <= bounds[0][1]; x++) for (let y = bounds[1][0]; y <= bounds[1][1]; y++) for (let z = bounds[2][0]; z <= bounds[2][1]; z++) {
      yield;
      const image: Vector3 = [x, y, z]; if (isZero(image)) continue;
      const position = add(source, fractionalToCartesian(cell, image, false)), key = positionKey(position);
      if (occupied.has(key)) continue;
      if(!position.every(Number.isFinite))throw new Error('周期镜像坐标超出有限范围。');
      occupied.add(key); instances.push({ sourceIndex: index, image, position, base: false });
    }
  }
  return instances;
}

/** Follow exactly the supplied atom-image graph. No distance based bonding,
 * wrapping, topology inference or clipping of cylinders against cell planes. */
export function periodicDisplayConnections(structure: Structure, bond: Bond, positions: readonly Atom[], instances: readonly PeriodicDisplayInstance[], display: DisplaySettings, context?: PeriodicDisplayConnectionContext): PeriodicDisplayConnection[] {
  return finishRenderWork(periodicDisplayConnectionsWork(structure,bond,positions,instances,display,context));
}
export function* periodicDisplayConnectionsWork(structure: Structure, bond: Bond, positions: readonly Atom[], instances: readonly PeriodicDisplayInstance[], display: DisplaySettings, context?: PeriodicDisplayConnectionContext):RenderWork<PeriodicDisplayConnection[]> {
  if (context && (context.structure !== structure || context.cell !== structure.cell || context.positions !== positions || context.instances !== instances || context.display !== display))
    throw new Error('周期显示连接索引不属于本次结构与显示帧。');
  const cell = structure.cell;
  if (!cell || !positions[bond.a] || !positions[bond.b]) return [];
  const image = bond.image ?? ZERO, settings = periodicDisplaySettings(display), visible = context?.visible ?? new Set(instances.map(row => imageKey(row.sourceIndex, row.image))), occupied = context?.occupied ?? new Set(instances.map(row => positionKey(row.position)));
  if(!settings.showCrossBoxBonds && !isZero(image))return [];
  const result: PeriodicDisplayConnection[] = [], seen = new Set<string>();
  const endpoint = (index: number, shift: Vector3) => add(coordinates(positions[index]), fractionalToCartesian(cell, shift, false));
  for (const instance of context ? endpointInstances(context, bond.a, bond.b) : instances) {
    yield;
    if (instance.sourceIndex !== bond.a && instance.sourceIndex !== bond.b) continue;
    for (const reverse of [false, true]) {
      if (instance.sourceIndex !== (reverse ? bond.b : bond.a)) continue;
      const targetIndex = reverse ? bond.a : bond.b, targetImage = add(instance.image, scale(image, reverse ? -1 : 1));
      if(!targetImage.every(Number.isSafeInteger))throw new Error('周期显示连接的镜像整数超出可精确表示范围。');const target = endpoint(targetIndex, targetImage);if(!target.every(Number.isFinite))throw new Error('周期显示连接坐标超出有限范围。');
      const full = visible.has(imageKey(targetIndex, targetImage)) || occupied.has(positionKey(target));
      const shift = reverse ? targetImage : instance.image;
      const identity = full ? [positionKey(instance.position), positionKey(target)].sort().join('|') : `${positionKey(instance.position)}>${positionKey(target)}`;
      if (seen.has(identity)) continue; seen.add(identity);
      const delta = subtract(target, instance.position), length = Math.hypot(...delta); if (length < 1e-10) continue;
      const end = full || settings.boundaryStyle === 'thin' ? target : add(instance.position, scale(delta, .5));
      result.push({ start: full && reverse ? end : instance.position, end: full && reverse ? instance.position : end, shift, full, base: isZero(instance.image) || full && isZero(targetImage), sourceIndex: instance.sourceIndex });
    }
  }
  return result;
}
