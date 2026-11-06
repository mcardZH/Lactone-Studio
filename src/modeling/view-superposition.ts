import type { Atom, Vector3 } from '../core/types';

export type SuperpositionAtom = Pick<Atom, 'id' | 'element' | 'x' | 'y' | 'z'>;
export interface AtomPair { movingAtomId: string; referenceAtomId: string }
export interface ViewRigidTransform { rotation: [Vector3, Vector3, Vector3]; translation: Vector3; anchorIds: string[] }
export interface ViewSuperpositionIssue { code: string; message: string }
export interface ViewSuperpositionDiagnostics {
  pairCount: number;
  mappingMode: 'explicit' | 'index';
  movingRank: 0 | 1 | 2 | 3;
  referenceRank: 0 | 1 | 2 | 3;
  rotationAmbiguous: boolean;
  fallback: 'none' | 'closest-to-identity' | 'canonical-axis';
  scope: 'display-only';
  warnings: string[];
}
export type ViewSuperpositionResult =
  | { ok: true; transform: ViewRigidTransform; rmsd: number; diagnostics: ViewSuperpositionDiagnostics; issues: [] }
  | { ok: false; transform: null; rmsd: null; diagnostics: null; issues: ViewSuperpositionIssue[] };
export interface ViewSuperpositionRequest {
  movingAtoms: readonly SuperpositionAtom[];
  referenceAtoms: readonly SuperpositionAtom[];
  /** Omit for the initial index correspondence. Neither route proves chemistry. */
  pairs?: readonly AtomPair[];
  /** Must be explicitly true even for a default index+element correspondence. */
  mappingConfirmed: boolean;
}
export const VIEW_SUPERPOSITION_ATOM_LIMIT = Number.MAX_SAFE_INTEGER;
const xyz = (a: SuperpositionAtom): Vector3 => [a.x, a.y, a.z];
const add = (a: Vector3, b: Vector3): Vector3 => a.map((v, i) => v + b[i]) as Vector3;
const sub = (a: Vector3, b: Vector3): Vector3 => a.map((v, i) => v - b[i]) as Vector3;
const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const rotate = (r: [Vector3, Vector3, Vector3], p: Vector3): Vector3 => r.map(row => dot(row, p)) as Vector3;
const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const failure = (code: string, message: string): ViewSuperpositionResult => ({ ok: false, transform: null, rmsd: null, diagnostics: null, issues: [{ code, message }] });

/** Initial suggestion only. Empty output means no complete index suggestion is
 * available; fitting still validates every ID/element and requires confirmation. */
export function suggestSequentialAtomPairs(moving: readonly SuperpositionAtom[], reference: readonly SuperpositionAtom[]): AtomPair[] {
  if (!moving.length || moving.length !== reference.length || moving.length > VIEW_SUPERPOSITION_ATOM_LIMIT
    || moving.some((a, i) => !a.id || !reference[i].id || a.element !== reference[i].element)) return [];
  return moving.map((a, i) => ({ movingAtomId: a.id!, referenceAtomId: reference[i].id! }));
}

function centered(points: Vector3[]) {
  const anchor = points[0], offsets = points.map(p => sub(p, anchor));
  const average = offsets.reduce<Vector3>((sum, p) => add(sum, p.map(v => v / points.length) as Vector3), [0, 0, 0]);
  const local = offsets.map(p => sub(p, average));
  return { center: add(anchor, average), local, size: local.reduce((size, p) => Math.max(size, Math.hypot(...p)), 0) };
}
function rank(local: Vector3[], size: number): 0 | 1 | 2 | 3 {
  if (!size) return 0;
  const points = local.map(p => p.map(v => v / size) as Vector3);
  const axis = unit(points.reduce((best, p) => dot(p, p) > dot(best, best) ? p : best)) as Vector3;
  const normal = points.map(p => cross(axis, p)).reduce((best, p) => dot(p, p) > dot(best, best) ? p : best);
  if (Math.hypot(...normal) <= 1e-10) return 1;
  const n = unit(normal) as Vector3;
  return points.every(p => Math.abs(dot(n, p)) <= 1e-10) ? 2 : 3;
}

/** Same Horn symmetric-quaternion/Jacobi method as the existing observation
 * alignment, but all confirmed pairs (including H) participate equally. This
 * standalone application module does not import the renderer or auto-trim.
 * Resolving the maximum eigenspace against identity gives a repeatable proper
 * minimum-angle solution for free rotations; an exact pi tie uses w,x,y,z. */
function optimalQuaternion(input: number[][]) {
  const a = input.map(row => [...row]), v = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => Number(i === j)));
  const magnitude = Math.max(...a.flat().map(Math.abs));
  for (let step = 0; step < 96 && magnitude; step++) {
    let p = 0, q = 1;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) <= magnitude * 1e-14) break;
    const angle = .5 * Math.atan2(2*a[p][q], a[q][q]-a[p][p]), c = Math.cos(angle), s = Math.sin(angle);
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    for (let k = 0; k < 4; k++) if (k !== p && k !== q) { const x = a[k][p], y = a[k][q]; a[k][p] = a[p][k] = c*x-s*y; a[k][q] = a[q][k] = s*x+c*y; }
    a[p][p] = c*c*app-2*c*s*apq+s*s*aqq; a[q][q] = s*s*app+2*c*s*apq+c*c*aqq; a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 4; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c*x-s*y; v[k][q] = s*x+c*y; }
  }
  const values = a.map((row, i) => row[i]), max = Math.max(...values);
  const tied = values.flatMap((value, i) => max-value <= Math.max(magnitude, Number.MIN_VALUE)*1e-11 ? [i] : []);
  // Project identity quaternion into the optimal eigenspace, then the next
  // canonical quaternion axes if a 180° solution is perpendicular to identity.
  let projection: number[] = [], chosenAxis = 0;
  for (; chosenAxis < 4; chosenAxis++) {
    projection = v.map(row => tied.reduce((sum, i) => sum + row[i]*v[chosenAxis][i], 0));
    if (Math.hypot(...projection) > 1e-10) break;
  }
  return { quaternion: unit(projection), ambiguous: tied.length > 1,
    fallback: (tied.length === 1 ? 'none' : chosenAxis === 0 ? 'closest-to-identity' : 'canonical-axis') as ViewSuperpositionDiagnostics['fallback'] };
}
function quaternionRotation(q: number[]): [Vector3, Vector3, Vector3] {
  const [w, x, y, z] = q;
  return [[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]];
}

/** Equal-weight least-squares DISPLAY fit of moving into reference coordinates.
 * R is orthonormal with det +1: no reflection, scaling, atom permutation or
 * physical-coordinate write occurs. A low RMSD establishes geometric agreement
 * under the confirmed pairs, never a reaction atom-map or chemical identity. */
export function superposeViewAtoms(request: ViewSuperpositionRequest): ViewSuperpositionResult {
  if (request.mappingConfirmed !== true) return failure('unconfirmed-mapping', '请先确认原子对应；逐序与元素匹配只是初始建议。');
  const { movingAtoms, referenceAtoms } = request;
  if (!movingAtoms.length || !referenceAtoms.length) return failure('empty-atoms', '没有原子，无法显示叠合。');
  for (const [label, atoms] of [['移动结构', movingAtoms], ['参考结构', referenceAtoms]] as const) {
    if (atoms.some(a => typeof a.id !== 'string' || !a.id.trim())) return failure('invalid-atom-id', `${label}缺少有效原子ID。`);
    if (new Set(atoms.map(a => a.id)).size !== atoms.length) return failure('duplicate-atom-id', `${label}含重复原子ID。`);
    if (atoms.some(a => typeof a.element !== 'string' || !a.element.trim())) return failure('invalid-element', `${label}缺少有效元素。`);
    if (atoms.some(a => !xyz(a).every(Number.isFinite))) return failure('nonfinite-coordinates', `${label}含非有限坐标。`);
  }
  if (request.pairs === undefined && movingAtoms.length !== referenceAtoms.length) return failure('index-count-mismatch', '逐序对应要求两侧原子数相同；请提供显式对应。');
  const mappingMode = request.pairs === undefined ? 'index' : 'explicit';
  const pairs = request.pairs ?? movingAtoms.map((a, i) => ({ movingAtomId: a.id!, referenceAtomId: referenceAtoms[i].id! }));
  if (!pairs.length) return failure('empty-correspondence', '原子对应为空，无法显示叠合。');
  const moving = new Map(movingAtoms.map(a => [a.id!, a])), reference = new Map(referenceAtoms.map(a => [a.id!, a]));
  const seenMoving = new Set<string>(), seenReference = new Set<string>();
  for (const pair of pairs) {
    if (!pair || typeof pair.movingAtomId !== 'string' || typeof pair.referenceAtomId !== 'string') return failure('invalid-pair', '原子对应项格式无效。');
    const m = moving.get(pair.movingAtomId), r = reference.get(pair.referenceAtomId);
    if (!m || !r) return failure('missing-pair-atom', '对应的原子ID已不存在，请重新确认。');
    if (seenMoving.has(pair.movingAtomId) || seenReference.has(pair.referenceAtomId)) return failure('non-one-to-one-mapping', '原子对应必须为一对一，不能重复引用。');
    if (m.element !== r.element) return failure('element-mismatch', `对应元素不一致：${m.element} / ${r.element}。`);
    seenMoving.add(pair.movingAtomId); seenReference.add(pair.referenceAtomId);
  }
  const m = centered(pairs.map(pair => xyz(moving.get(pair.movingAtomId)!))), r = centered(pairs.map(pair => xyz(reference.get(pair.referenceAtomId)!)));
  if (![...m.center, ...r.center, m.size, r.size].every(Number.isFinite)) return failure('numeric-range', '坐标范围超出可表示值，无法显示叠合。');
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < pairs.length; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    covariance[i][j] += (m.size ? m.local[k][i]/m.size : 0)*(r.size ? r.local[k][j]/r.size : 0)/pairs.length;
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = covariance;
  const optimum = optimalQuaternion([[xx+yy+zz, yz-zy, zx-xz, xy-yx], [yz-zy, xx-yy-zz, xy+yx, zx+xz], [zx-xz, xy+yx, -xx+yy-zz, yz+zy], [xy-yx, zx+xz, yz+zy, -xx-yy+zz]]);
  const rotation = quaternionRotation(optimum.quaternion), translation = sub(r.center, rotate(rotation, m.center));
  const residuals = m.local.map((p, i) => Math.hypot(...sub(rotate(rotation, p), r.local[i]))), largest = Math.max(...residuals);
  const rmsd = largest ? largest*Math.sqrt(residuals.reduce((sum, value) => sum + (value/largest)**2/pairs.length, 0)) : 0;
  if (![...rotation.flat(), ...translation, rmsd].every(Number.isFinite)) return failure('numeric-range', '叠合结果超出可表示范围。');
  const movingRank = rank(m.local, m.size), referenceRank = rank(r.local, r.size);
  const warnings = ['仅用于显示；几何叠合不证明反应原子映射或化学等价。'];
  if (movingRank !== referenceRank) warnings.push('两侧坐标秩不同，RMSD保留未匹配的形状差异。');
  if (optimum.ambiguous) warnings.push('最优旋转不唯一，已使用确定的自由旋转规则。');
  return { ok: true, transform: { rotation, translation, anchorIds: pairs.map(pair => pair.movingAtomId) }, rmsd,
    diagnostics: { pairCount: pairs.length, mappingMode, movingRank, referenceRank, rotationAmbiguous: optimum.ambiguous, fallback: optimum.fallback, scope: 'display-only', warnings }, issues: [] };
}
