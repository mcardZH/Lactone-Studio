import type { PeriodicCell, Vector3 } from '../types';
import { cellEditorEdges, type CellEditorEdge } from './cell-editor';
import { fractionalToCartesian } from '../periodic';

export type CellPresentationRole = 'current' | 'checkpoint' | 'preview' | 'grid';
export interface CellPresentationEdge extends CellEditorEdge { role: CellPresentationRole; dashed: boolean }
export interface CellPresentationOptions {
  current?: PeriodicCell;
  checkpoint?: PeriodicCell;
  preview?: PeriodicCell;
  /** Only supply when a documented expansion identifies its source unit cell. */
  supercell?: { source: PeriodicCell; repeat: Vector3 };
}

/** Recover only a proven axis-aligned integer expansion, not a guessed lattice. */
export function inheritedSupercellGrid(source?: PeriodicCell, current?: PeriodicCell): CellPresentationOptions['supercell'] {
  if (!source || !current || (source.origin ?? [0, 0, 0]).some((x, i) => Math.abs(x - (current.origin ?? [0, 0, 0])[i]) > 1e-7)) return;
  const repeat = source.vectors.map((vector, axis) => {
    const length2 = vector.reduce((sum, x) => sum + x * x, 0);
    const ratio = current.vectors[axis].reduce((sum, x, i) => sum + x * vector[i], 0) / length2;
    const count = Math.round(ratio);
    return count > 0 && Number.isFinite(ratio) && Math.abs(ratio - count) < 1e-7 && vector.every((x, i) => Math.abs(x * count - current.vectors[axis][i]) < 1e-7) ? count : NaN;
  }) as Vector3;
  return repeat.every(Number.isSafeInteger) ? { source, repeat } : undefined;
}

/** Shared renderer/export geometry. Physical axis identity survives any camera angle. */
export function cellPresentationEdges(options: CellPresentationOptions): CellPresentationEdge[] {
  const result: CellPresentationEdge[] = [], seen = new Set<string>();
  const pointKey = (point: Vector3) => point.map(value => value.toFixed(8)).join(',');
  const add = (edge: CellEditorEdge, role: CellPresentationRole) => {
    const key = [pointKey(edge.start), pointKey(edge.end)].sort().join('|');
    // Prefer current/preview to a coincident checkpoint, avoiding depth flicker.
    if (seen.has(key)) return;
    seen.add(key); result.push({ ...edge, key: `${role}:${edge.key}`, role, dashed: role !== 'current' });
  };
  for (const role of ['current', 'preview', 'checkpoint'] as const) {
    const cell = options[role]; if (cell) cellEditorEdges(cell).forEach(edge => add(edge, role));
  }
  const grid = options.supercell;
  if (grid && grid.repeat.every(value => Number.isSafeInteger(value) && value > 0)) {
    for (let i = 0; i < grid.repeat[0]; i++) for (let j = 0; j < grid.repeat[1]; j++) for (let k = 0; k < grid.repeat[2]; k++) {
      const offset = fractionalToCartesian(grid.source, [i, j, k]);
      const cell: PeriodicCell = { ...grid.source, origin: offset };
      // fractionalToCartesian already includes the actual source origin.
      cellEditorEdges(cell).forEach(edge => add({ ...edge, key: `${i},${j},${k}:${edge.key}` }, 'grid'));
    }
  }
  return result;
}
