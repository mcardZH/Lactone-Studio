import type { Atom, PeriodicCell, Structure, Vector3 } from '../types';
import type { ModelDocument, StructureTransformCandidate } from './contracts';
import { builderPosition, builderRotate, builderUnit, builderVector } from '../builder-geometry';
import { cartesianToFractional, cellInverse, fractionalToCartesian, canonicalPeriodicBond } from '../periodic';
import { reindexStructureAtoms } from './graph-reindex';
import { subsetStructure } from './graph';
import { unwrapFinitePeriodicFragments } from './periodic-modeling';
import weights from '../../data/atomic-weights.json';

type Scope = { atomIds?: string[] };
type Matrix3 = [Vector3, Vector3, Vector3];
export type StructureTransformEdit =
  | ({ type: 'translate'; delta: Vector3 } & Scope)
  | ({ type: 'center'; mode: 'geometry' | 'mass'; target?: Vector3 } & Scope)
  | ({ type: 'rotate'; axis: Vector3; degrees: number; pivot?: Vector3 } & Scope)
  | ({ type: 'matrix'; matrix: Matrix3; pivot?: Vector3 } & Scope)
  | ({ type: 'align'; from: Vector3; to: Vector3; pivot?: Vector3 } & Scope)
  | ({ type: 'principal-axes'; massWeighted?: boolean; pivot?: Vector3 } & Scope)
  | ({ type: 'mirror'; normal: Vector3; pivot?: Vector3 } & Scope)
  | ({ type: 'invert'; pivot?: Vector3 } & Scope)
  | ({ type: 'scale'; factors: number | Vector3; pivot?: Vector3 } & Scope)
  | { type: 'crop'; min: Vector3; max: Vector3; space?: 'cartesian' | 'fractional' }
  | { type: 'reorder'; atomIds: string[] }
  | { type: 'wrap' }
  | { type: 'finite-cluster'; keepCell?: boolean }
  | { type: 'cell'; cell: PeriodicCell; keep: 'cartesian' | 'fractional' }
  | { type: 'axes'; order: [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2]; signs?: Vector3 }
  | { type: 'supercell'; repeat: Vector3 }
  | { type: 'vacuum'; axis: 0 | 1 | 2; vacuum: number; center: boolean };

const { add, sub, scale, dot, cross } = builderVector;
const IDENTITY: Matrix3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const validVector = (v: unknown): v is Vector3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const checkVector = (v: unknown): Vector3 => { if (!validVector(v)) throw new Error('变换向量必须包含三个有限值。'); return v; };
const multiply = (matrix: Matrix3, point: Vector3): Vector3 => matrix.map(row => dot(row, point)) as Vector3;
const mass = (atom: Atom): number => {
  const value = (weights.weights as Record<string, number>)[atom.element];
  if (!Number.isFinite(value) || value <= 0) throw new Error(`元素 ${atom.element} 缺少明确原子质量。`);
  return value;
};
function centroid(atoms: Atom[], weighted = false): Vector3 {
  if (!atoms.length) throw new Error('请指定至少一个原子。');
  let total = 0;
  const sum = atoms.reduce<Vector3>((result, atom) => { const w = weighted ? mass(atom) : 1; total += w; return add(result, scale(builderPosition(atom), w)); }, [0, 0, 0]);
  return scale(sum, 1 / total);
}
function selected(structure: Structure, ids?: string[]): Set<string> {
  const values = ids ?? structure.atoms.map(atom => atom.id!);
  const valid = new Set(structure.atoms.map(atom => atom.id!));
  if (!values.length || values.some(id => !valid.has(id)) || new Set(values).size !== values.length) throw new Error('变换范围含无效、重复或缺失原子。');
  return new Set(values);
}
function assertRotation(matrix: Matrix3) {
  if (!Array.isArray(matrix) || matrix.length !== 3 || matrix.some(row => !validVector(row))) throw new Error('旋转矩阵必须为有限3×3矩阵。');
  if (matrix.some((row, i) => matrix.some((other, j) => Math.abs(dot(row, other) - (i === j ? 1 : 0)) > 1e-8)) || Math.abs(dot(matrix[0], cross(matrix[1], matrix[2])) - 1) > 1e-8) throw new Error('旋转矩阵必须正交且行列式为+1。');
}
/** Jacobi eigenvectors of the real symmetric covariance matrix, sorted by
 * decreasing spread. Degenerate axes remain an orientation choice, not a
 * unique physical direction. The returned frame is always right handed. */
function principalMatrix(atoms: Atom[], weighted: boolean): Matrix3 {
  const center = centroid(atoms, weighted), a: Matrix3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = structuredClone(IDENTITY);
  for (const atom of atoms) { const p = sub(builderPosition(atom), center), w = weighted ? mass(atom) : 1; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += w * p[i] * p[j]; }
  for (let iteration = 0; iteration < 40; iteration++) {
    let p = 0, q = 1; for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) < 1e-12) break;
    const angle = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(angle), s = Math.sin(angle);
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    for (let k = 0; k < 3; k++) if (k !== p && k !== q) { const akp = a[k][p], akq = a[k][q]; a[k][p] = a[p][k] = c * akp - s * akq; a[k][q] = a[q][k] = s * akp + c * akq; }
    a[p][p] = c * c * app - 2 * c * s * apq + s * s * aqq; a[q][q] = s * s * app + 2 * c * s * apq + c * c * aqq; a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) { const vp = v[k][p], vq = v[k][q]; v[k][p] = c * vp - s * vq; v[k][q] = s * vp + c * vq; }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]), matrix = order.map(index => [v[0][index], v[1][index], v[2][index]]) as Matrix3;
  for (const row of matrix) { const dominant = row.reduce((best, value, i) => Math.abs(value) > Math.abs(row[best]) ? i : best, 0); if (row[dominant] < 0) for (let i = 0; i < 3; i++) row[i] *= -1; }
  matrix[2] = cross(matrix[0], matrix[1]); assertRotation(matrix); return matrix;
}
function transformAtoms(structure: Structure, ids: Set<string>, fn: (point: Vector3) => Vector3) {
  structure.atoms = structure.atoms.map(atom => { if (!ids.has(atom.id!)) return atom; const p = fn(builderPosition(atom)); checkVector(p); return { ...atom, x: p[0], y: p[1], z: p[2] }; });
}

/** Build a complete preview from one immutable Store snapshot. No mutations,
 * runtime work, guessed bonds, freeze changes or implicit Store transactions. */
export function prepareStructureTransform(document: ModelDocument, edit: StructureTransformEdit): StructureTransformCandidate {
  const original = document.draft.structure;
  let structure = structuredClone(original);
  let mapping = original.atoms.map(atom => ({ atomId: atom.id!, sourceAtomId: atom.id!, image: [0, 0, 0] as Vector3 }));
  let latticeImageBasis = structuredClone(IDENTITY);
  const directionTransforms: NonNullable<StructureTransformCandidate['directionTransforms']> = {};
  if (original.periodicSource && ['wrap', 'finite-cluster', 'cell', 'axes', 'supercell'].includes(edit.type)) throw new Error('完整晶胞缺失，不能进行此周期变换。');
  if (edit.type === 'reorder') structure = reindexStructureAtoms(structure, edit.atomIds);
  else if (edit.type === 'crop') {
    checkVector(edit.min); checkVector(edit.max); if (edit.min.some((value, i) => value > edit.max[i])) throw new Error('裁剪下界不能大于上界。');
    if (edit.space === 'fractional' && !structure.cell) throw new Error('分数坐标裁剪需要完整晶胞。');
    const inverse = edit.space === 'fractional' ? cellInverse(structure.cell!) : null;
    const ids = structure.atoms.filter(atom => {
      const point = builderPosition(atom), p = inverse ? cartesianToFractional(structure.cell!, point) : point;
      return p.every((value, i) => {
        // Closed fractional bounds must survive the subtraction, inverse and
        // dot-product roundoff of a Cartesian source. This is a machine-error
        // bound at the current coordinate/cell scale, not a geometric padding.
        const origin = structure.cell?.origin ?? [0, 0, 0];
        const error = inverse ? 32 * Number.EPSILON * (Math.abs(value) + Math.abs(edit.min[i]) + Math.abs(edit.max[i])
          + inverse[i].reduce((sum, coefficient, k) => sum + Math.abs(coefficient) * (Math.abs(point[k]) + Math.abs(origin[k])
            + structure.cell!.vectors.reduce((size, axis, j) => size + Math.abs(axis[k] * p[j]), 0)), 0)) : 0;
        return value >= edit.min[i] - error && value <= edit.max[i] + error;
      });
    }).map(atom => atom.id!);
    if (!ids.length) throw new Error('裁剪后没有原子；未生成空模型。');
    const retained = new Set(ids);
    structure = subsetStructure(structure, ids); mapping = mapping.filter(entry => retained.has(entry.atomId));
    if (ids.length !== original.atoms.length) { structure.charge = null; structure.multiplicity = null; }
  } else if (edit.type === 'wrap') {
    if (!structure.cell) throw new Error('回卷需要完整晶胞。');
    const cell = structure.cell;
    const byId = new Map<string | undefined, Atom>();
    for (const atom of structure.atoms) if (!byId.has(atom.id)) byId.set(atom.id, atom);
    mapping = mapping.map(entry => { const atom = byId.get(entry.atomId)!, f = cartesianToFractional(cell, builderPosition(atom)); return { ...entry, image: f.map((value, axis) => cell.pbc[axis] ? -Math.floor(value) || 0 : 0) as Vector3 }; });
    const shifts = new Map(mapping.map(entry => [entry.atomId, entry.image]));
    structure.atoms = structure.atoms.map(atom => { const p = add(builderPosition(atom), fractionalToCartesian(cell, shifts.get(atom.id!)!, false)); return { ...atom, x: p[0], y: p[1], z: p[2] }; });
    structure.bonds = structure.bonds?.map(bond => ({ ...bond, image: (bond.image ?? [0, 0, 0]).map((value, axis) => value + shifts.get(structure.atoms[bond.a].id!)![axis] - shifts.get(structure.atoms[bond.b].id!)![axis]) as Vector3 }));
  } else if (edit.type === 'finite-cluster') {
    const unwrapped = unwrapFinitePeriodicFragments(structure); structure = unwrapped.structure;
    mapping = mapping.map(entry => ({ ...entry, image: unwrapped.images[entry.atomId] }));
    if (!edit.keepCell) delete structure.cell;
  } else if (edit.type === 'vacuum') {
    if (!structure.cell || ![0, 1, 2].includes(edit.axis) || !Number.isFinite(edit.vacuum) || edit.vacuum < 0 || typeof edit.center !== 'boolean') throw new Error('真空需要完整晶胞、轴与非负有限厚度。');
    const cell = structure.cell, other = [0, 1, 2].filter(axis => axis !== edit.axis), normal0 = builderUnit(cross(cell.vectors[other[0]], cell.vectors[other[1]]));
    const normal = dot(normal0, cell.vectors[edit.axis]) < 0 ? scale(normal0, -1) : normal0;
    if (!structure.atoms.length) throw new Error('真空操作需要原子。');
    const projections = structure.atoms.map(atom => dot(sub(builderPosition(atom), cell.origin ?? [0, 0, 0]), normal)), low = Math.min(...projections), high = Math.max(...projections), height = high - low + edit.vacuum;
    if (height < 1e-8) throw new Error('目标晶胞法向高度不能为零。');
    cell.vectors[edit.axis] = add(cell.vectors[edit.axis], scale(normal, height - dot(cell.vectors[edit.axis], normal)));
    if (edit.center) transformAtoms(structure, selected(structure), point => add(point, scale(normal, edit.vacuum / 2 - low)));
    cellInverse(cell);
  } else if (edit.type === 'cell') {
    cellInverse(edit.cell); if (!['cartesian', 'fractional'].includes(edit.keep)) throw new Error('请明确保持笛卡尔或分数坐标。');
    if (edit.keep === 'fractional') {
      if (!original.cell) throw new Error('保持分数坐标需要原始完整晶胞。');
      const fn = (point: Vector3) => fractionalToCartesian(edit.cell, cartesianToFractional(original.cell!, point));
      transformAtoms(structure, selected(structure), fn);
      const origin = fn([0, 0, 0]), columns = IDENTITY.map(axis => sub(fn(axis), origin));
      const matrix = IDENTITY.map((_, row) => columns.map(column => column[row])) as Matrix3;
      for (const atom of structure.atoms) directionTransforms[atom.id!] = matrix;
    }
    structure.cell = structuredClone(edit.cell);
  } else if (edit.type === 'axes') {
    if (!structure.cell || edit.order.length !== 3 || new Set(edit.order).size !== 3 || edit.order.some(axis => ![0, 1, 2].includes(axis))) throw new Error('晶胞轴变换需要三个轴的完整排列。');
    const signs = edit.signs ?? [1, 1, 1]; if (!validVector(signs) || signs.some(value => value !== 1 && value !== -1)) throw new Error('晶胞轴方向只能为+1或-1。');
    const old = structure.cell;
    structure.cell = { ...old, vectors: edit.order.map((axis, i) => scale(old.vectors[axis], signs[i])) as Matrix3, pbc: edit.order.map(axis => old.pbc[axis]) as [boolean, boolean, boolean] };
    latticeImageBasis = IDENTITY.map((_, sourceAxis) => edit.order.map((axis, targetAxis) => sourceAxis === axis ? signs[targetAxis] : 0)) as Matrix3;
    structure.bonds = structure.bonds?.map(bond => ({ ...bond, image: edit.order.map((axis, i) => (bond.image?.[axis] ?? 0) * signs[i] || 0) as Vector3 }));
  } else if (edit.type === 'supercell') {
    if (!structure.cell || !validVector(edit.repeat) || edit.repeat.some((value, axis) => !Number.isSafeInteger(value) || value < 1 || value > 1 && !structure.cell!.pbc[axis])) throw new Error('扩胞需要有效周期轴上的正整数重复数。');
    const count = edit.repeat.reduce((a, b) => a * b, 1); if (!Number.isSafeInteger(count * original.atoms.length)) throw new Error('扩胞原子数超出可精确表示的整数范围。');
    const cell = structure.cell, atoms: Atom[] = [], copies: Vector3[] = [], index = new Map<string, number>(), usedIds = new Set<string>(); mapping = [];
    const key = (source: string, image: Vector3) => JSON.stringify([source, image]);
    for (let a = 0; a < edit.repeat[0]; a++) for (let b = 0; b < edit.repeat[1]; b++) for (let c = 0; c < edit.repeat[2]; c++) {
      const image: Vector3 = [a, b, c]; copies.push(image); const shift = fractionalToCartesian(cell, image, false);
      for (const atom of original.atoms) {
        const id = image.some(Boolean) ? `${atom.id}@${a},${b},${c}` : atom.id!;
        if (usedIds.has(id)) throw new Error('扩胞派生原子ID与现有身份冲突。');
        usedIds.add(id);
        index.set(key(atom.id!, image), atoms.length); atoms.push({ ...atom, id, x: atom.x + shift[0], y: atom.y + shift[1], z: atom.z + shift[2] }); mapping.push({ atomId: id, sourceAtomId: atom.id!, image });
      }
    }
    const bonds = [], seen = new Set<string>();
    for (const copy of copies) for (const bond of original.bonds ?? []) {
      const target = copy.map((value, axis) => value + (bond.image?.[axis] ?? 0)) as Vector3;
      const image = target.map((value, axis) => Math.floor(value / edit.repeat[axis]) || 0) as Vector3;
      const within = target.map((value, axis) => ((value % edit.repeat[axis]) + edit.repeat[axis]) % edit.repeat[axis]) as Vector3;
      const a = index.get(key(original.atoms[bond.a].id!, copy))!, b = index.get(key(original.atoms[bond.b].id!, within))!, canonical = canonicalPeriodicBond(a, b, image);
      if (!seen.has(canonical.key)) { seen.add(canonical.key); bonds.push({ ...bond, a: canonical.a, b: canonical.b, image: canonical.image }); }
    }
    structure.atoms = atoms; structure.bonds = bonds;
    structure.cell = { ...cell, vectors: cell.vectors.map((vector, axis) => scale(vector, edit.repeat[axis])) as Matrix3 };
    latticeImageBasis = IDENTITY.map((vector, axis) => scale(vector, 1 / edit.repeat[axis])) as Matrix3;
    // Electron counts of a copied unrestricted cell are not inferred.
    if (count > 1) { structure.charge = null; structure.multiplicity = null; }
  } else {
    const scope = selected(structure, 'atomIds' in edit ? edit.atomIds : undefined), atoms = structure.atoms.filter(atom => scope.has(atom.id!));
    const pivot = 'pivot' in edit && edit.pivot !== undefined ? checkVector(edit.pivot) : centroid(atoms);
    let fn: (point: Vector3) => Vector3;
    if (edit.type === 'translate') { const delta = checkVector(edit.delta); fn = point => add(point, delta); }
    else if (edit.type === 'center') { if (!['geometry', 'mass'].includes(edit.mode)) throw new Error('未知居中方式。'); const delta = sub(checkVector(edit.target ?? [0, 0, 0]), centroid(atoms, edit.mode === 'mass')); fn = point => add(point, delta); }
    else if (edit.type === 'rotate') { checkVector(edit.axis); if (!Number.isFinite(edit.degrees)) throw new Error('旋转角必须有限。'); builderUnit(edit.axis); fn = point => builderRotate(point, pivot, edit.axis, edit.degrees * Math.PI / 180); }
    else if (edit.type === 'matrix') { assertRotation(edit.matrix); fn = point => add(pivot, multiply(edit.matrix, sub(point, pivot))); }
    else if (edit.type === 'align') {
      const from = builderUnit(checkVector(edit.from)), to = builderUnit(checkVector(edit.to)), cosine = Math.max(-1, Math.min(1, dot(from, to))), axis = cross(from, to);
      if (Math.hypot(...axis) < 1e-10) { if (cosine > 0) fn = point => point; else { const helper: Vector3 = Math.abs(from[0]) < .8 ? [1, 0, 0] : [0, 1, 0], normal = cross(from, helper); fn = point => builderRotate(point, pivot, normal, Math.PI); } }
      else fn = point => builderRotate(point, pivot, axis, Math.acos(cosine));
    } else if (edit.type === 'principal-axes') { const matrix = principalMatrix(atoms, edit.massWeighted ?? false); fn = point => add(pivot, multiply(matrix, sub(point, pivot))); }
    else if (edit.type === 'mirror') { const normal = builderUnit(checkVector(edit.normal)); fn = point => sub(point, scale(normal, 2 * dot(sub(point, pivot), normal))); }
    else if (edit.type === 'invert') fn = point => sub(scale(pivot, 2), point);
    else if (edit.type === 'scale') { const factors = typeof edit.factors === 'number' ? [edit.factors, edit.factors, edit.factors] as Vector3 : checkVector(edit.factors); if (factors.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('缩放比例必须为正有限值。'); fn = point => add(pivot, sub(point, pivot).map((value, axis) => value * factors[axis]) as Vector3); }
    else throw new Error('未知原生几何操作。');
    const base = fn([0, 0, 0]), columns = IDENTITY.map(axis => sub(fn(axis), base)), matrix = IDENTITY.map((_, row) => columns.map(column => column[row])) as Matrix3;
    for (const id of scope) directionTransforms[id] = matrix;
    if (structure.cell && scope.size === structure.atoms.length && !['translate', 'center'].includes(edit.type)) {
      structure.cell = { ...structure.cell, vectors: structure.cell.vectors.map(axis => multiply(matrix, axis)) as Matrix3, origin: fn(structure.cell.origin ?? [0, 0, 0]) };
    }
    transformAtoms(structure, scope, fn);
  }
  delete structure.molfile; delete structure.preparation;
  return { documentId: document.id, expectedRevision: document.revision, operation: edit.type, structure, atomMapping: mapping, latticeImageBasis, directionTransforms };
}
