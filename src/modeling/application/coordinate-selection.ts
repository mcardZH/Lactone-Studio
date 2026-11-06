import type { Structure } from '../../core/types';
import { inputSelectionIndices } from '../../core/input-selection';
import { coordinateValue } from '../../core/tasks';

/** Confirm an ordered capture against the current structure without repairing it. */
export function confirmCoordinateSelection(structure: Structure, atomIds: readonly string[]) {
  if (structure.dimension === 2) throw new Error('内坐标需要真实三维结构，二维画布不能代替。');
  const indices = inputSelectionIndices(structure, atomIds);
  const type = ({ 2: 'B', 3: 'A', 4: 'D' } as const)[indices.length as 2 | 3 | 4];
  if (!type) throw new Error('请依次选择2、3或4个不同原子，确认后确定键长、键角或二面角。');
  const atoms = indices.map(index => index + 1);
  if (indices.some(index => ![structure.atoms[index].x, structure.atoms[index].y, structure.atoms[index].z].every(Number.isFinite))) throw new Error('内坐标原子需要有限的三维坐标。');
  const value = coordinateValue({ type, atoms, action: 'freeze', steps: 1, increment: null }, structure.atoms);
  if (!Number.isFinite(value) || (type === 'B' && value < 1e-12)) throw new Error('重叠原子不能可靠定义键长。');
  return { type, atoms, atomIds: [...atomIds], value, unit: type === 'B' ? 'Å' : '°' };
}

/** Gaussian stores increments; the starting geometry is an additional point. */
export function gaussianScanRange(start: number, increments: number, increment: number) {
  if (![start, increment].every(Number.isFinite) || increment === 0 || !Number.isSafeInteger(increments) || increments < 1 || increments > 10000) return null;
  const end = start + increments * increment;
  return Number.isFinite(end) ? { start, end, increment, increments, points: increments + 1 } : null;
}

/** ORCA stores total points. Explicit lists never acquire a fabricated fixed increment. */
export function orcaScanRange(coordinate: { start?: number; end?: number; steps?: number; values?: number[] }) {
  if (coordinate.values !== undefined) {
    const values = coordinate.values;
    if (values.length < 2 || !values.every(Number.isFinite)) return null;
    return { start: values[0], end: values[values.length - 1], points: values.length, increment: null, explicit: true };
  }
  const { start, end, steps } = coordinate;
  if (start === undefined || end === undefined || steps === undefined || ![start, end].every(Number.isFinite) || start === end || !Number.isSafeInteger(steps) || steps < 2) return null;
  return { start, end, points: steps, increment: (end - start) / (steps - 1), explicit: false };
}

/** Increment counts for Gaussian; ORCA serializes the additional initial point. */
export function recommendedScan(type: 'B' | 'A' | 'D', start: number) {
  const increments = type === 'B' ? 20 : 10;
  let increment = type === 'B' ? .1 : type === 'A' ? 5 : 18;
  if (type === 'A' && start + increments * increment >= 180) increment = -increment;
  if (!Number.isFinite(start) || type === 'A' && (start <= 0 || start >= 180)) return null;
  return { start, end: start + increments * increment, increments, increment, points: increments + 1 };
}
