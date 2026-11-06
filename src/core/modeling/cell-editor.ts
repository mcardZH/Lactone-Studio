import type { PeriodicCell, Structure, Vector3 } from '../types';
import type { CellCheckpoint, ModelDocument, StructureTransformCandidate } from './contracts';
import { cartesianToFractional, cellInverse, dot3, fractionalToCartesian, norm3 } from '../periodic';
import { clearBondEvidence } from '../bond-semantics';

export type CellAxis = 0 | 1 | 2;
export type CellAtomHandling = 'cartesian' | 'stretch';
export interface AssignCellRequest {
  type: 'assign-cell'; mode: 'lengths' | 'padding'; lengths: Vector3;
  padding: number; shape: 'orthogonal' | 'cube'; center: boolean;
}
export interface EditCellRequest {
  type: 'edit-cell'; lengths: Vector3;
  handling: [CellAtomHandling, CellAtomHandling, CellAtomHandling];
}
export type CellEditorRequest = AssignCellRequest | EditCellRequest;
const axes = [0, 1, 2] as const;
const identity: [Vector3, Vector3, Vector3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export function captureCellCheckpoint(document: ModelDocument): CellCheckpoint {
  const snapshot = structuredClone({ structure: document.draft.structure, assignments: document.draft.assignments,
    auxiliaryRelations: document.auxiliaryRelations, deletedBonds: document.deletedBonds,
    internalCoordinates: document.internalCoordinates, sharedConstraints: document.sharedConstraints,
    coordinateObjects: document.coordinateObjects, gaussianBoundCoordinates: document.gaussianBoundCoordinates,
    attachmentPorts: document.attachmentPorts });
  delete snapshot.structure.preparation; clearBondEvidence(snapshot.structure);
  return snapshot;
}
/** Remove only relationships that require an image. Never make a long finite bond. */
export function removeDocumentCell(document: ModelDocument): ModelDocument {
  const next = structuredClone(document), structure = next.draft.structure;
  const hasImages = (value: { images?: Vector3[]; image?: Vector3 }) => Boolean(value.image?.some(Boolean) || value.images?.some(image => image.some(Boolean)));
  delete structure.cell; delete structure.periodicSource; delete structure.periodicWorkingSource;
  structure.bonds = structure.bonds?.filter(bond => !hasImages(bond)).map(({ image: _image, ...bond }) => ({
    ...bond,
    // A zero-image distance contact stays an unknown-order distance contact.
    // Its old periodic tag would require the image/cell that we just removed.
    ...(bond.perception === 'periodic-distance' ? { perception: 'empirical-distance' as const } : {})
  }));
  clearBondEvidence(structure);
  // Diagnostics are tied to the old periodic neighbor search.
  delete structure.bondPerceptionIssues;
  next.deletedBonds = next.deletedBonds.filter(row => !hasImages(row)).map(({ image: _image, ...row }) => row);
  next.internalCoordinates = next.internalCoordinates?.filter(row => !hasImages(row)).map(({ images: _images, ...row }) => row);
  next.coordinateObjects = next.coordinateObjects?.filter(row => !hasImages(row)).map(({ images: _images, ...row }) => row);
  if (next.sharedConstraints) next.sharedConstraints.coordinates = next.sharedConstraints.coordinates.filter(row => !hasImages(row)).map(({ images: _images, ...row }) => row);
  const objects = new Set(next.coordinateObjects?.map(row => row.id));
  next.gaussianBoundCoordinates = next.gaussianBoundCoordinates?.filter(row => objects.has(row.objectId));
  next.selection.bonds = next.selection.bonds.filter(row => !hasImages(row)).map(({ image: _image, ...row }) => row);
  return next;
}
const positiveLengths = (lengths: Vector3): Vector3 => {
  if (lengths.length !== 3 || lengths.some(value => !Number.isFinite(value) || value <= 0))
    throw new Error('晶胞长度须为三个有限正数。');
  return lengths;
};
export function orthogonalCellFrame(cell: PeriodicCell) {
  cellInverse(cell);
  const lengths = cell.vectors.map(norm3) as Vector3;
  positiveLengths(lengths);
  const directions = cell.vectors.map((vector, axis) => vector.map(value => value / lengths[axis]) as Vector3) as [Vector3, Vector3, Vector3];
  if (axes.some(i => axes.some(j => i !== j && Math.abs(dot3(directions[i], directions[j])) > 1e-8)))
    throw new Error('当前为非正交晶胞；本轮仅支持正交晶胞长度编辑。');
  return { lengths, directions, origin: cell.origin ?? [0, 0, 0] as Vector3 };
}
export function structureCoordinateBounds(structure: Structure) {
  if (!structure.atoms.length) throw new Error('赋予晶胞需要至少一个原子。');
  const min: Vector3 = [Infinity, Infinity, Infinity], max: Vector3 = [-Infinity, -Infinity, -Infinity];
  for (const atom of structure.atoms) {
    const point = [atom.x, atom.y, atom.z];
    if (point.some(value => !Number.isFinite(value))) throw new Error('原子坐标包含非有限数值。');
    axes.forEach(axis => { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); });
  }
  return { min, max, spans: max.map((value, axis) => value - min[axis]) as Vector3,
    center: max.map((value, axis) => (value + min[axis]) / 2) as Vector3 };
}
export function assignedCellLengths(structure: Structure, request: AssignCellRequest): Vector3 {
  if (request.mode === 'lengths') return positiveLengths([...request.lengths] as Vector3);
  if (!Number.isFinite(request.padding) || request.padding < 0) throw new Error('每侧外扩须为有限非负数。');
  const { spans } = structureCoordinateBounds(structure), largest = Math.max(...spans);
  return positiveLengths(spans.map(value => (request.shape === 'cube' ? largest : value) + 2 * request.padding) as Vector3);
}
export function cellOutsideAtomCount(structure: Structure): number {
  if (!structure.cell) return 0;
  return structure.atoms.filter(atom => cartesianToFractional(structure.cell!, [atom.x, atom.y, atom.z])
    .some(value => value < -1e-8 || value > 1 + 1e-8)).length;
}
/** Immutable candidate for the existing derived-document transaction. */
export function prepareCellEditorCandidate(document: ModelDocument, request: CellEditorRequest): StructureTransformCandidate {
  const original = document.draft.structure, structure = structuredClone(original);
  let directionTransforms: StructureTransformCandidate['directionTransforms'];
  if (request.type === 'assign-cell') {
    if (original.cell) throw new Error('当前已有晶胞，请使用编辑晶胞。');
    if (original.periodicSource) throw new Error('当前来源包含不完整周期信息，不能将缺失晶胞方向猜作正交晶胞。');
    const lengths = assignedCellLengths(original, request);
    const { center } = structureCoordinateBounds(original);
    structure.cell = { vectors: [[lengths[0], 0, 0], [0, lengths[1], 0], [0, 0, lengths[2]]],
      pbc: [true, true, true], origin: [0, 0, 0], source: 'user-assigned',
      pbcProvenance: { kind: 'user-confirmed', evidence: '用户显式赋予三维正交晶胞' } };
    cellInverse(structure.cell);
    if (request.center) structure.atoms = structure.atoms.map(atom => ({ ...atom,
      x: atom.x + lengths[0] / 2 - center[0], y: atom.y + lengths[1] / 2 - center[1], z: atom.z + lengths[2] / 2 - center[2] }));
    if (structure.atoms.some(atom => [atom.x, atom.y, atom.z].some(value => !Number.isFinite(value))))
      throw new Error('居中后原子坐标超出有限范围。');
  } else {
    if (!original.cell) throw new Error('编辑晶胞需要已有真实晶胞。');
    const { directions, lengths, origin } = orthogonalCellFrame(original.cell), next = positiveLengths(request.lengths);
    if (request.handling.length !== 3 || request.handling.some(value => !['cartesian', 'stretch'].includes(value)))
      throw new Error('请分别指定三个晶胞轴的原子处理方式。');
    const ratios = next.map((value, axis) => request.handling[axis] === 'stretch' ? value / lengths[axis] : 1);
    const matrix = axes.map(i => axes.map(j => axes.reduce<number>((sum, axis) => sum + ratios[axis] * directions[axis][i] * directions[axis][j], 0)) as Vector3) as [Vector3, Vector3, Vector3];
    // Preserve exact Cartesian positions when no axis stretches.
    if (request.handling.some(value => value === 'stretch')) {
      structure.atoms = structure.atoms.map(atom => {
        const relative = [atom.x - origin[0], atom.y - origin[1], atom.z - origin[2]] as Vector3;
        const point = matrix.map((row, axis) => origin[axis] + dot3(row, relative));
        if (point.some(value => !Number.isFinite(value))) throw new Error('修改后原子坐标超出有限范围。');
        return { ...atom, x: point[0], y: point[1], z: point[2] };
      });
      directionTransforms = Object.fromEntries(structure.atoms.map(atom => [atom.id!, matrix]));
    }
    structure.cell = { ...structuredClone(original.cell), vectors: directions.map((direction, axis) => direction.map(value => value * next[axis]) as Vector3) as [Vector3, Vector3, Vector3] };
    cellInverse(structure.cell);
  }
  delete structure.molfile; delete structure.preparation;
  return { documentId: document.id, expectedRevision: document.revision, operation: request.type,
    structure, atomMapping: original.atoms.map(atom => ({ atomId: atom.id!, sourceAtomId: atom.id!, image: [0, 0, 0] })),
    latticeImageBasis: structuredClone(identity), directionTransforms };
}
export interface CellEditorEdge { key: string; axis: CellAxis; start: Vector3; end: Vector3 }
/** All twelve actual cell edges, grouped by their physical cell-axis direction. */
export function cellEditorEdges(cell: PeriodicCell): CellEditorEdge[] {
  const edges: CellEditorEdge[] = [];
  for (const axis of axes) {
    const other = axes.filter(value => value !== axis);
    for (let bits = 0; bits < 4; bits++) {
      const from: Vector3 = [0, 0, 0]; from[other[0]] = bits & 1 ? 1 : 0; from[other[1]] = bits & 2 ? 1 : 0;
      const to = [...from] as Vector3; to[axis] = 1;
      edges.push({ key: `${axis}-${bits}`, axis, start: fractionalToCartesian(cell, from), end: fractionalToCartesian(cell, to) });
    }
  }
  return edges;
}
/** Projection is supplied by the active renderer; no alternate camera model. */
export function cellLengthFromScreenDrag(initial: number, start: { x: number; y: number }, end: { x: number; y: number }, delta: { x: number; y: number }): number {
  const dx = end.x - start.x, dy = end.y - start.y, square = dx * dx + dy * dy;
  if (!Number.isFinite(square) || square < 1) return initial;
  return Math.max(1e-4, initial * (1 + (delta.x * dx + delta.y * dy) / square));
}
