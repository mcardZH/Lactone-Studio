import { coordinateValue } from '../core/tasks';
import type { Structure } from '../core/types';
import { assertResultNotAborted, type ResultFrameSummary, type TrajectoryResult } from './contracts';
import { convertEnergy, type EnergyUnit } from './energy';
import type { AtomicProperty, OrbitalChannel } from './scientific-contracts';

export interface FrontierOrbitals {
  spin: OrbitalChannel['spin']; unit: EnergyUnit;
  homo: { index: number; energy: number } | null;
  lumo: { index: number; energy: number } | null;
  gap: number | null;
}
/** Frontier energies from printed occupations, not an optical gap or generated orbitals. */
export function frontierOrbitals(channel: OrbitalChannel, unit: EnergyUnit = 'eV'): FrontierOrbitals {
  let homo: FrontierOrbitals['homo'] = null, lumo: FrontierOrbitals['lumo'] = null;
  for (const orbital of channel.orbitals) {
    if (!Number.isSafeInteger(orbital.index) || !Number.isFinite(orbital.occupation) || orbital.occupation < 0) continue;
    const energy = convertEnergy({ value: orbital.energy, unit: channel.unit }, unit);
    if (energy === null) continue;
    if (orbital.occupation > 1e-8) { if (!homo || energy > homo.energy) homo = { index: orbital.index, energy }; }
    else if (!lumo || energy < lumo.energy) lumo = { index: orbital.index, energy };
  }
  return { spin: channel.spin, unit, homo, lumo, gap: homo && lumo ? lumo.energy - homo.energy : null };
}
export function atomicScalars(property: AtomicProperty, structure: Structure, frameIndex: number): { atomIndex: number; value: number }[] {
  if (property.frameIndex !== frameIndex) return [];
  const seen = new Set<number>();
  return property.values.flatMap(row => {
    if (!Number.isSafeInteger(row.atomIndex) || row.atomIndex < 0 || row.atomIndex >= structure.atoms.length || seen.has(row.atomIndex)
      || !Number.isFinite(row.value) || (row.element && row.element !== structure.atoms[row.atomIndex].element)) return [];
    seen.add(row.atomIndex); return [{ atomIndex: row.atomIndex, value: row.value }];
  });
}
export interface CoordinateTrace {
  kind: 'B' | 'A' | 'D'; atomIndices: number[]; unit: 'angstrom' | 'degree';
  points: { frameIndex: number; value: number | null }[];
}
/** Last printed geometry per contiguous native node. This is not a convergence claim. */
export function pathNodeFrames(frames: readonly ResultFrameSummary[]): ResultFrameSummary[] {
  const selected: ResultFrameSummary[] = [];
  let previousKey: string | null = null;
  for (const frame of frames) {
    if (frame.pathNode === undefined) {
      previousKey = null;
      if (frame.pathDirection === 'ts') selected.push(frame);
      continue;
    }
    if (!Number.isSafeInteger(frame.pathNode) || frame.pathNode < 0) throw new Error('路径节点编号无效。');
    const key = `${frame.pathDirection ?? 'unknown'}:${frame.pathNode}`;
    if (key === previousKey) selected[selected.length - 1] = frame;
    else selected.push(frame);
    previousKey = key;
  }
  return selected;
}
/** Explicit user-requested trace: cancellation and inventory checks on every lazy frame. */
export async function traceInternalCoordinate(result: TrajectoryResult, kind: CoordinateTrace['kind'], atomIndices: number[], signal?: AbortSignal): Promise<CoordinateTrace> {
  const count = kind === 'B' ? 2 : kind === 'A' ? 3 : 4;
  if (atomIndices.length !== count || new Set(atomIndices).size !== count || atomIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= result.initialStructure.atoms.length)) throw new Error('内坐标追踪需要有效且不重复的原子序号。');
  const inventory = result.initialStructure.atoms.map(atom => [atom.id, atom.element] as const), points: CoordinateTrace['points'] = [];
  for (let index = 0; index < result.frames.length; index++) {
    assertResultNotAborted(signal);
    const structure = await result.getFrame(index, signal);
    assertResultNotAborted(signal);
    if (structure.atoms.length !== inventory.length || structure.atoms.some((atom, i) => atom.element !== inventory[i][1] || atom.id !== inventory[i][0])) throw new Error('原子库存或顺序改变，不能连接内坐标追踪。');
    let value: number | null = null;
    try {
      const measured = coordinateValue({ type: kind, atoms: atomIndices.map(i => i + 1), steps: 1, increment: null }, structure.atoms);
      if (Number.isFinite(measured)) value = measured;
    } catch { /* Degenerate coordinates remain gaps, not invented zero values. */ }
    points.push({ frameIndex: index, value });
    if (index % 64 === 63) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return { kind, atomIndices: [...atomIndices], unit: kind === 'B' ? 'angstrom' : 'degree', points };
}
