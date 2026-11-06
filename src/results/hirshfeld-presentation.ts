import type { Structure, Vector3 } from '../core/types';
import type { SurfaceContext } from './surface-contracts';
import type { HirshfeldCluster, HirshfeldSelectedCluster, HirshfeldVertexSample } from './hirshfeld-contracts';
import { validateHirshfeldCluster } from './hirshfeld-field';

export interface HirshfeldContactFocus { insideElement: string; outsideElement: string; merged: boolean }
export const hirshfeldContactKey = (inside: string, outside: string, merged: boolean) => JSON.stringify(merged ? [inside, outside].sort() : [inside, outside]);
export function hirshfeldContactMatches(inside: string, outside: string, focus: HirshfeldContactFocus | null): boolean {
  return !focus || hirshfeldContactKey(inside, outside, focus.merged) === hirshfeldContactKey(focus.insideElement, focus.outsideElement, focus.merged);
}
/** Preserve the complete admitted Cartesian snapshot. A cell/PBC preview cannot
 * be silently converted into a finite environmental cluster. */
export function hirshfeldClusterFromStructure(structure: Structure, context: SurfaceContext): HirshfeldCluster {
  if (structure.dimension === 2 || structure.periodicSource || structure.cell?.pbc.some(Boolean)
    || structure.bonds?.some(bond => bond.image?.some(value => value !== 0))) throw new Error('请提供已准备的完整非周期有限团簇。');
  if (structure.sourceAtomIds && (structure.sourceAtomIds.length !== structure.atoms.length
    || structure.sourceAtomIds.some((id, index) => id !== structure.atoms[index]?.id))) throw new Error('当前结构不是完整的源原子快照。');
  const cluster: HirshfeldCluster = { kind: 'finite-cluster', sourceId: context.sourceId, sourceRevision: context.sourceRevision,
    coordinateUnit: 'angstrom', completeFiniteCluster: true, atoms: structure.atoms.map((atom, index) => ({ sourceIndex: index + 1,
      stableId: atom.id ?? '', element: atom.element, position: [atom.x, atom.y, atom.z] })) };
  validateHirshfeldCluster(cluster); return cluster;
}
export function hirshfeldSelection(cluster: HirshfeldCluster, targetIds: readonly string[]) {
  const selected = new Set(targetIds);
  if (selected.size !== targetIds.length || targetIds.some(id => !cluster.atoms.some(atom => atom.stableId === id))) throw new Error('目标片段包含失效或重复原子。');
  const selection = { targetAtomIndices: cluster.atoms.filter(atom => selected.has(atom.stableId)).map(atom => atom.sourceIndex),
    environmentAtomIndices: cluster.atoms.filter(atom => !selected.has(atom.stableId)).map(atom => atom.sourceIndex) };
  validateHirshfeldCluster(cluster, selection); return selection;
}
export function hirshfeldSampleMatches(sample: HirshfeldVertexSample, cluster: HirshfeldCluster, focus: HirshfeldContactFocus | null): boolean {
  return !focus || sample.insideAtomIndices.some(i => sample.outsideAtomIndices.some(j =>
    hirshfeldContactMatches(cluster.atoms[i - 1].element, cluster.atoms[j - 1].element, focus)));
}
/** Display vertices and native quantitative points have different topology.
 * Classify display positions in source Å space using the same inside/outside
 * nuclei identities; never interpret either mesh's vertex ordinal as the other. */
export function hirshfeldPositionMatches(position: Vector3, source: HirshfeldSelectedCluster, focus: HirshfeldContactFocus | null): boolean {
  if (!focus) return true;
  const nearest = (indices: readonly number[]) => {
    const rows = indices.map(index => { const atom = source.atoms[index - 1]; return { atom,
      distance: Math.hypot(...position.map((value, axis) => value - atom.position[axis])), tolerance: Math.sqrt(3) * (atom.coordinatePrecisionAngstrom ?? 0) }; });
    const min = Math.min(...rows.map(row => row.distance));
    return rows.filter(row => row.distance <= min + row.tolerance + 1e-9).map(row => row.atom.element);
  };
  return nearest(source.targetAtomIndices).some(inside => nearest(source.environmentAtomIndices).some(outside => hirshfeldContactMatches(inside, outside, focus)));
}
/** Exact Euclidean neighbourhood counts over the complete native dataset,
 * including the point itself. Filtering only changes color, never this density.
 * Spatial cells only accelerate the radius query; they are not histogram bins. */
export function hirshfeldFingerprintDensity(samples: readonly Pick<HirshfeldVertexSample, 'di' | 'de'>[], radiusAngstrom = .02): Float64Array {
  if (!Number.isFinite(radiusAngstrom) || radiusAngstrom <= 0) throw new Error('指纹点密度半径须为正数（Å）。');
  const cells = new Map<string, { x: number; y: number; multiplicity: number; indices: number[] }[]>();
  const identical = new Map<string, { x: number; y: number; multiplicity: number; indices: number[] }>();
  samples.forEach((sample, index) => {
    if (![sample.di, sample.de].every(Number.isFinite)) throw new Error('指纹距离须为有限原生值。');
    if (![sample.di, sample.de].every(value => Number.isSafeInteger(Math.floor(value / radiusAngstrom)))) throw new Error('点密度半径与距离的比例超出可精确表示范围。');
    const key = `${sample.di}:${sample.de}`, present = identical.get(key);
    if (present) { present.multiplicity++; present.indices.push(index); return; }
    const item = { x: sample.di, y: sample.de, multiplicity: 1, indices: [index] }; identical.set(key, item);
    const cell = `${Math.floor(sample.di / radiusAngstrom)}:${Math.floor(sample.de / radiusAngstrom)}`;
    const entries = cells.get(cell) ?? []; entries.push(item); cells.set(cell, entries);
  });
  type Point = { x: number; y: number; multiplicity: number; indices: number[] };
  type Node = { xmin: number; xmax: number; ymin: number; ymax: number; count: number; points?: Point[]; children?: Node[] };
  const tree = (points: Point[], depth = 0): Node => {
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, count = 0;
    for (const point of points) { xmin = Math.min(xmin, point.x); xmax = Math.max(xmax, point.x); ymin = Math.min(ymin, point.y); ymax = Math.max(ymax, point.y); count += point.multiplicity; }
    if (points.length <= 32) return { xmin, xmax, ymin, ymax, count, points };
    const axis = depth % 2 ? 'y' : 'x', sorted = [...points].sort((a, b) => a[axis] - b[axis]), mid = sorted.length >> 1;
    return { xmin, xmax, ymin, ymax, count, children: [tree(sorted.slice(0, mid), depth + 1), tree(sorted.slice(mid), depth + 1)] };
  };
  const result = new Float64Array(samples.length), squared = radiusAngstrom ** 2 * (1 + 8 * Number.EPSILON);
  const dense = new Map<string, Node>();
  for (const [key, points] of cells) if (points.length > 128) dense.set(key, tree(points));
  const countTree = (node: Node, point: Point): number => {
    const dx = Math.max(node.xmin - point.x, 0, point.x - node.xmax), dy = Math.max(node.ymin - point.y, 0, point.y - node.ymax);
    if (dx * dx + dy * dy > squared) return 0;
    const farX = Math.max(Math.abs(point.x - node.xmin), Math.abs(point.x - node.xmax)), farY = Math.max(Math.abs(point.y - node.ymin), Math.abs(point.y - node.ymax));
    if (farX * farX + farY * farY <= squared) return node.count;
    return node.children ? countTree(node.children[0], point) + countTree(node.children[1], point) : node.points!.reduce((sum, other) => sum + ((point.x - other.x) ** 2 + (point.y - other.y) ** 2 <= squared ? other.multiplicity : 0), 0);
  };
  for (const sample of identical.values()) {
    const cx = Math.floor(sample.x / radiusAngstrom), cy = Math.floor(sample.y / radiusAngstrom); let count = 0;
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      const key = `${x}:${y}`, node = dense.get(key);
      if (node) count += countTree(node, sample);
      else for (const other of cells.get(key) ?? []) if ((sample.x - other.x) ** 2 + (sample.y - other.y) ** 2 <= squared) count += other.multiplicity;
    }
    for (const index of sample.indices) result[index] = count;
  }
  return result;
}

export interface HirshfeldFingerprintDisplay { radiusAngstrom: number; densityMin: number; densityMax: number | null; logarithmic: boolean; pointSize: number }
export const initialHirshfeldFingerprintDisplay = (): HirshfeldFingerprintDisplay => ({ radiusAngstrom: .02, densityMin: 1, densityMax: null, logarithmic: false, pointSize: 2 });
/** Directed native contacts first; sample-only open previews retain actual identities. */
export function hirshfeldContactOptions(result: { source: HirshfeldSelectedCluster; vertices: readonly HirshfeldVertexSample[]; contacts: import('./hirshfeld-contracts').HirshfeldContacts | null }, merged = false): HirshfeldContactFocus[] {
  const choices = new Map<string, HirshfeldContactFocus>();
  const put = (insideElement: string, outsideElement: string) => { const key = hirshfeldContactKey(insideElement, outsideElement, merged); if (!choices.has(key)) choices.set(key, { insideElement, outsideElement, merged }); };
  if (result.contacts) for (const row of merged ? result.contacts.mergedRows : result.contacts.directedRows) put(row.insideElement, row.outsideElement);
  else for (const point of result.vertices) for (const inside of point.insideAtomIndices) for (const outside of point.outsideAtomIndices) put(result.source.atoms[inside - 1].element, result.source.atoms[outside - 1].element);
  return [...choices.values()];
}
export const hirshfeldContactLabel = (focus: HirshfeldContactFocus | null) => !focus ? '总图' : focus.merged ? `${focus.insideElement}···${focus.outsideElement}` : `${focus.insideElement}ᵢ···${focus.outsideElement}ₑ`;
