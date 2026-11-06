import type { Structure, Vector3 } from '../../core/types';
import type { StructureTransformCandidate } from '../../core/modeling/contracts';
import type { CrystalResult } from '../../modeling/crystal-contracts';
import { orientObjectView } from './render/camera';
import { inverseRotate, rotate, type Rotation } from './render/alignment';
import { add, coordinates, cross, dot, rotateVector, subtract } from './render/geometry';
import type { TransformPreviewGuides } from './render/transform-guides';

function checkedRotation(value: readonly (readonly number[])[]): Rotation {
  if (value.length !== 3 || value.some(row => row.length !== 3 || !row.every(Number.isFinite))) throw new Error('切面旋转矩阵无效。');
  const rows = value.map(row => [...row]) as Rotation;
  if (rows.some(row => Math.abs(dot(row, row) - 1) > 1e-8)
    || Math.abs(dot(rows[0], rows[1])) > 1e-8 || Math.abs(dot(rows[0], rows[2])) > 1e-8 || Math.abs(dot(rows[1], rows[2])) > 1e-8
    || dot(cross(rows[0], rows[1]), rows[2]) < 1 - 1e-8) throw new Error('切面旋转必须为刚性正旋转。');
  return rows;
}

/** Transfer physical orientation only. Target zoom/pan and displayed pivot stay local. */
export function transferSlabCameraView(sourceView: number[], targetView: number[], sourceToCandidateRotation: readonly (readonly number[])[], from: 'source' | 'candidate', targetPivot: Vector3): number[] {
  const rotation = checkedRotation(sourceToCandidateRotation);
  if (sourceView.length < 8 || !sourceView.every(Number.isFinite)) throw new Error('切面联动视角无效。');
  const norm = Math.hypot(...sourceView.slice(4, 8));
  if (norm < 1e-12) throw new Error('切面联动四元数无效。');
  const q = sourceView.slice(4, 8).map(value => value / norm);
  const columns = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vector3[]).map(axis => rotateVector(axis, q));
  const rows = [0, 1, 2].map(i => columns.map(column => column[i]) as Vector3);
  // Qcandidate = Qsource R^T; Qsource = Qcandidate R.
  const mapped = rows.map(row => from === 'source' ? rotate(rotation, row) : inverseRotate(rotation, row));
  return orientObjectView(targetView, { right: mapped[0], up: mapped[1], toward: mapped[2] }, targetPivot);
}

/** Recover the exact native rigid translation from stable atom/image identities.
 * Raw source XYZ already includes its cell origin; add lattice images once only. */
export function candidateSlabGuides(source: Structure, candidate: StructureTransformCandidate, sourceGuides: TransformPreviewGuides, details: NonNullable<CrystalResult['details']>): TransformPreviewGuides {
  if (!source.cell || !details.rotation) throw new Error('切面辅助线缺少真实源晶胞或旋转映射。');
  const rotation = checkedRotation(details.rotation), sourceAtoms = new Map(source.atoms.map(atom => [atom.id, atom]));
  const mappings = new Map(candidate.atomMapping.map(row => [row.atomId, row]));
  let translation: Vector3 | undefined;
  for (const atom of candidate.structure.atoms) {
    const mapping = mappings.get(atom.id!), original = mapping && sourceAtoms.get(mapping.sourceAtomId);
    if (!mapping || !original || mapping.image.length !== 3 || !mapping.image.every(Number.isSafeInteger)) throw new Error('切面辅助线原子映射不完整。');
    const latticeOffset = [0, 1, 2].map(i => source.cell!.vectors.reduce((sum, vector, axis) => sum + vector[i] * mapping.image[axis], 0)) as Vector3;
    const next = subtract(coordinates(atom), rotate(rotation, add(coordinates(original), latticeOffset)));
    if (translation && Math.hypot(...subtract(next, translation)) > 1e-6) throw new Error('切面候选不是共同刚体映射，不能猜测切割边界。');
    translation ??= next;
  }
  if (!translation) throw new Error('切面候选没有可映射的完整原子。');
  if (sourceGuides.box) throw new Error('切面辅助线应使用真实平面，不接受轴对齐盒代替切割边界。');
  const point = (value: Vector3) => add(rotate(rotation, value), translation!);
  const repeat = details.repeat ?? [1, 1];
  if (repeat.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('切面辅助线的面内复制倍数无效。');
  const sizeScale = Math.max(...repeat);
  const dimIds = sourceGuides.dimAtomIds && new Set(sourceGuides.dimAtomIds);
  return {
    ...(dimIds ? { dimAtomIds: candidate.atomMapping.filter(row => dimIds.has(row.sourceAtomId)).map(row => row.atomId) } : {}),
    ...(sourceGuides.planes ? { planes: sourceGuides.planes.map(plane => ({ ...plane, center: point(plane.center), normal: rotate(rotation, plane.normal), size: (plane.size ?? 6) * sizeScale })) } : {}),
    ...(sourceGuides.vectors ? { vectors: sourceGuides.vectors.map(vector => ({ origin: point(vector.origin), vector: rotate(rotation, vector.vector) })) } : {}),
    ...(sourceGuides.points ? { points: sourceGuides.points.map(value => ({ position: point(value.position) })) } : {}),
  };
}
