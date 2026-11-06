import type { Structure, Vector3 } from '../types';
import { cellInverse, fractionalToCartesian } from '../periodic';

export interface FinitePeriodicFragment {
  atomIds: string[];
  /** Integer offset of each base atom in one connected, finite realization. */
  images: Record<string, Vector3>;
  positions: Record<string, Vector3>;
}
const zero = (): Vector3 => [0, 0, 0];
export class InfinitePeriodicNetworkError extends Error {
  readonly code = 'infinite-periodic-network';
  constructor() { super('无限周期网络不能作为有限片段移动或整理。'); this.name = 'InfinitePeriodicNetworkError'; }
}

/** A connected base-cell graph is finite iff every cycle has zero net lattice
 * translation. A self-image edge or two paths assigning different translations
 * proves an infinite network; a visited-base-atom walk alone cannot prove it. */
export function resolveFinitePeriodicFragment(structure: Structure, rootAtomId: string): FinitePeriodicFragment {
  const ids = checkedAtomIds(structure);
  const root = ids.indexOf(rootAtomId);
  if (root < 0) throw new Error('有限片段起点已不存在。');
  return resolveFragment(structure, checkedAdjacency(structure), root);
}

function checkedAtomIds(structure: Structure): (string | undefined)[] {
  if (structure.periodicSource) throw new Error('部分周期来源不能证明有限片段。');
  const ids = structure.atoms.map(atom => atom.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('有限片段需要唯一稳定原子身份。');
  return ids;
}

type Adjacency = { index: number; image: Vector3 }[][];
function checkedAdjacency(structure: Structure): Adjacency {
  if (structure.cell) cellInverse(structure.cell);
  if (structure.bonds === undefined) throw new Error('有限片段识别需要明确连接图。');
  const adjacency = structure.atoms.map(() => [] as { index: number; image: Vector3 }[]);
  for (const bond of structure.bonds) {
    if (!Number.isInteger(bond.a) || !Number.isInteger(bond.b) || !adjacency[bond.a] || !adjacency[bond.b]) throw new Error('片段连接引用无效原子。');
    const image = bond.image ?? zero();
    if (image.length !== 3 || image.some((value, axis) => !Number.isSafeInteger(value) || value !== 0 && !structure.cell?.pbc[axis])) throw new Error('片段连接的晶胞镜像无效。');
    adjacency[bond.a].push({ index: bond.b, image });
    adjacency[bond.b].push({ index: bond.a, image: image.map(value => -value || 0) as Vector3 });
  }
  return adjacency;
}

function resolveFragment(structure: Structure, adjacency: Adjacency, root: number): FinitePeriodicFragment {
  const offsets = new Map<number, Vector3>([[root, zero()]]), queue = [root];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor], offset = offsets.get(current)!;
    for (const edge of adjacency[current]) {
      const image = offset.map((value, axis) => value + edge.image[axis]) as Vector3;
      if (!image.every(Number.isSafeInteger)) throw new Error('片段镜像超出整数范围。');
      const previous = offsets.get(edge.index);
      if (previous && previous.some((value, axis) => value !== image[axis])) throw new InfinitePeriodicNetworkError();
      if (!previous) { offsets.set(edge.index, image); queue.push(edge.index); }
    }
  }
  const result: FinitePeriodicFragment = { atomIds: [], images: {}, positions: {} };
  // Keep source atom order without rescanning unrelated components.
  for (const index of [...offsets.keys()].sort((a, b) => a - b)) {
    const atom = structure.atoms[index], image = offsets.get(index)!;
    const shift = structure.cell ? fractionalToCartesian(structure.cell, image, false) : zero();
    const position: Vector3 = [atom.x + shift[0], atom.y + shift[1], atom.z + shift[2]];
    if (!position.every(Number.isFinite)) throw new Error('片段坐标必须有限。');
    result.atomIds.push(atom.id!); result.images[atom.id!] = image; result.positions[atom.id!] = position;
  }
  return result;
}

/** Resolve each component in source-root order with one checked graph. No
 * state survives this call, so edited cells/bonds never reuse stale offsets. */
export function resolveFinitePeriodicFragments(structure: Structure): FinitePeriodicFragment[] {
  if (!structure.atoms.length) return [];
  checkedAtomIds(structure);
  const adjacency = checkedAdjacency(structure), seen = new Set<string>(), fragments: FinitePeriodicFragment[] = [];
  for (let index = 0; index < structure.atoms.length; index++) {
    if (seen.has(structure.atoms[index].id!)) continue;
    const fragment = resolveFragment(structure, adjacency, index);
    for (const id of fragment.atomIds) seen.add(id);
    fragments.push(fragment);
  }
  return fragments;
}

/** Pure display/transform frame. The caller decides whether to keep the cell or
 * explicitly turn it into a finite cluster. Never infers a missing bond graph. */
export function unwrapFinitePeriodicFragments(structure: Structure): { structure: Structure; images: Record<string, Vector3> } {
  const images: Record<string, Vector3> = {}, positions: Record<string, Vector3> = {};
  for (const fragment of resolveFinitePeriodicFragments(structure)) {
    Object.assign(images, fragment.images); Object.assign(positions, fragment.positions);
  }
  const result = structuredClone(structure);
  result.atoms = result.atoms.map(atom => { const point = positions[atom.id!]; return { ...atom, x: point[0], y: point[1], z: point[2] }; });
  result.bonds = result.bonds?.map(bond => ({ ...bond, image: [0, 0, 0] }));
  delete result.molfile;
  return { structure: result, images };
}
