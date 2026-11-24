import { cross3, dot3, norm3 } from '../../core/periodic';
import type { PeriodicCell, Vector3 } from '../../core/types';

const CELL_TOLERANCE_ANGSTROM = 1e-8;
type RotationBasis = [Vector3, Vector3, Vector3];

function latticeBasis(cell: PeriodicCell): RotationBasis {
  const axis = (vector: Vector3): Vector3 => {
    const length = norm3(vector);
    return [vector[0] / length, vector[1] / length, vector[2] / length];
  };
  const a = axis(cell.vectors[0]);
  const normal = axis(cross3(a, cell.vectors[1]));
  return [a, cross3(normal, a), normal];
}

/** Derive a proper rigid rotation from the corresponding lattice axes. */
export function pesPathCellAlignment(reference: PeriodicCell, target: PeriodicCell) {
  if (!reference.pbc.every((axis, index) => axis === target.pbc[index]))
    return { issue: '需要相同的固定晶胞和周期方向。' };
  const from = latticeBasis(target), to = latticeBasis(reference);
  const oriented = (vector: Vector3): Vector3 => {
    const [x, y, z] = from.map(axis => dot3(axis, vector));
    return [0, 1, 2].map(i => x * to[0][i] + y * to[1][i] + z * to[2][i]) as Vector3;
  };
  // The legacy Cartesian tolerance is retained for an already aligned cell.
  const sameVectors = (vectors: PeriodicCell['vectors']) => reference.vectors.every((row, i) =>
    row.every((value, j) => Math.abs(value - vectors[i][j]) <= CELL_TOLERANCE_ANGSTROM));
  const alreadyAligned = sameVectors(target.vectors);
  if (!alreadyAligned && !sameVectors(target.vectors.map(oriented) as PeriodicCell['vectors']))
    return { issue: '固定晶胞尺寸或夹角不同，或晶格轴无法通过刚体旋转对齐。' };
  const fromOrigin = target.origin ?? [0, 0, 0], toOrigin = reference.origin ?? [0, 0, 0];
  if (alreadyAligned && fromOrigin.every((value, i) => value === toOrigin[i])) return {};
  return {
    transform: (point: Vector3): Vector3 => {
      const relative: Vector3 = [point[0] - fromOrigin[0], point[1] - fromOrigin[1], point[2] - fromOrigin[2]];
      const aligned = alreadyAligned ? relative : oriented(relative);
      return [aligned[0] + toOrigin[0], aligned[1] + toOrigin[1], aligned[2] + toOrigin[2]];
    },
  };
}
