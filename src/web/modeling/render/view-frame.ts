import type { Atom, PeriodicCell, Vector3 } from '../../../core/types';
import { molecularMass } from '../../../core/molecular-mass';
import { add, cross, dot, scale, subtract } from './geometry';

/** Orthonormal model-to-screen basis: toward points at the observer (+GL z). */
export interface ViewFrame { right: Vector3; up: Vector3; toward: Vector3 }
export interface InertiaViewFrame extends ViewFrame {
  center: Vector3;
  /** Principal moments, ascending, in the existing mass table's u·Å² units. */
  moments: [number, number, number];
  degeneracy: 'unique' | 'double' | 'isotropic';
}
export type CellViewPreset = 'a' | 'a*' | 'b' | 'b*' | 'c' | 'c*';
const axes: Vector3[] = [[0, 0, 1], [0, 1, 0], [1, 0, 0]];
const unit = (v: Vector3): Vector3 => {
  const n = Math.hypot(...v);
  if (!Number.isFinite(n) || !n) throw new Error('观察方向无效。');
  return v.map(x => x / n) as Vector3;
};
const perpendicular = (v: Vector3, n: Vector3) => subtract(v, scale(n, dot(v, n)));
function frame(toward: Vector3, preferredUp: Vector3 = [0, 1, 0]): ViewFrame {
  const z = unit(toward);
  let up = perpendicular(unit(preferredUp), z);
  if (Math.hypot(...up) < 1e-10) up = axes.map(a => perpendicular(a, z)).find(a => Math.hypot(...a) > 1e-10)!;
  const right = unit(cross(up, z));
  return { right, up: unit(cross(z, right)), toward: z };
}

/** Symmetric 3×3 Jacobi solve. Scaling occurs before this call so the stopping
 * threshold is relative to the tensor, including small/large structures. */
function eigenSystem(input: number[][]): { value: number; vector: Vector3 }[] {
  const a = input.map(row => [...row]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const magnitude = Math.max(...a.flat().map(Math.abs));
  for (let step = 0; step < 48 && magnitude; step++) {
    let p = 0, q = 1;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) <= magnitude * 1e-14) break;
    const angle = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(angle), s = Math.sin(angle);
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    for (let k = 0; k < 3; k++) if (k !== p && k !== q) {
      const x = a[k][p], y = a[k][q];
      a[k][p] = a[p][k] = c * x - s * y; a[k][q] = a[q][k] = s * x + c * y;
    }
    a[p][p] = c*c*app - 2*c*s*apq + s*s*aqq; a[q][q] = s*s*app + 2*c*s*apq + c*c*aqq; a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c*x - s*y; v[k][q] = s*x + c*y; }
  }
  return a.map((row, i) => ({ value: Math.max(0, row[i]), vector: unit(v.map(r => r[i]) as Vector3) })).sort((x, y) => x.value - y.value);
}

/** Uses existing explicit element masses, without inferring H or isotopes.
 * The maximum INERTIA axis is the minimum spatial second-moment axis.
 * A tied eigenspace selects the first nonzero projection of physical Z,Y,X;
 * a unique axis makes its largest component positive (ties prefer Z,Y,X).
 * Empty input is refused; a point/single atom uses physical Z with Y up. */
export function principalInertiaFrame(atoms: readonly Pick<Atom, 'element' | 'x' | 'y' | 'z'>[]): InertiaViewFrame {
  if (!atoms.length) throw new Error('没有原子，无法设置标准方向。');
  if (atoms.some(a => ![a.x, a.y, a.z].every(Number.isFinite))) throw new Error('原子坐标无效，无法设置标准方向。');
  const massByElement = new Map<string, number>();
  const unknown: string[] = [];
  for (const element of new Set(atoms.map(a => a.element))) {
    const mass = molecularMass([{ element }]);
    if (mass.value === null || !Number.isFinite(mass.value) || mass.value <= 0) unknown.push(element);
    else massByElement.set(element, mass.value);
  }
  if (unknown.length) throw new Error(`缺少元素质量：${unknown.sort().join('、')}；无法设置标准方向。`);
  const masses = atoms.map(a => massByElement.get(a.element)!);
  const total = masses.reduce((sum, m) => sum + m, 0);
  const anchor: Vector3 = [atoms[0].x, atoms[0].y, atoms[0].z];
  const offsets = atoms.map(a => subtract([a.x, a.y, a.z], anchor));
  const offsetCenter = offsets.reduce<Vector3>((sum, r, i) => add(sum, scale(r, masses[i] / total)), [0, 0, 0]);
  const center = add(anchor, offsetCenter), centered = offsets.map(r => subtract(r, offsetCenter));
  const size = centered.reduce((largest, r) => Math.max(largest, Math.hypot(...r)), 0);
  if (!center.every(Number.isFinite) || !Number.isFinite(size)) throw new Error('原子坐标范围无效，无法计算惯量。');
  if (!size) return { ...frame([0, 0, 1]), center, moments: [0, 0, 0], degeneracy: 'isotropic' };
  const tensor = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  centered.forEach((r, k) => {
    const x = r.map(v => v / size) as Vector3, square = dot(x, x), weight = masses[k] / total;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tensor[i][j] += weight * ((i === j ? square : 0) - x[i] * x[j]);
  });
  const eigen = eigenSystem(tensor), max = eigen[2].value;
  const tied = eigen.filter(e => max - e.value <= max * 1e-10);
  let toward: Vector3;
  if (tied.length > 1) {
    toward = axes.map(axis => tied.reduce<Vector3>((sum, e) => add(sum, scale(e.vector, dot(e.vector, axis))), [0, 0, 0])).find(v => Math.hypot(...v) > 1e-10)!;
  } else {
    toward = [...eigen[2].vector];
    const index = [2, 1, 0].reduce((best, i) => Math.abs(toward[i]) > Math.abs(toward[best]) + 1e-14 ? i : best, 2);
    if (toward[index] < 0) toward = scale(toward, -1);
  }
  const moments = eigen.map(e => e.value * size * size * total) as [number, number, number];
  if (!moments.every(Number.isFinite)) throw new Error('惯量范围超出可表示值，无法设置标准方向。');
  return { ...frame(toward), center, moments, degeneracy: tied.length === 3 ? 'isotropic' : tied.length === 2 ? 'double' : 'unique' };
}

/** Direct axes use actual a,b,c; star axes are their positive reciprocal
 * directions (b×c, c×a, a×b divided by signed volume). The frame is a rigid
 * rotation only: it never orthogonalizes, scales or changes the cell itself. */
export function cellViewFrame(cell: PeriodicCell, preset: CellViewPreset): ViewFrame {
  if (!['a', 'a*', 'b', 'b*', 'c', 'c*'].includes(preset)) throw new Error('晶胞观察预设无效。');
  if (cell.vectors.length !== 3 || cell.vectors.some(v => v.length !== 3 || !v.every(Number.isFinite) || !Math.hypot(...v))) throw new Error('晶胞向量无效，无法设置观察方向。');
  const [a, b, c] = cell.vectors.map(unit), volume = dot(a, cross(b, c));
  if (!Number.isFinite(volume) || Math.abs(volume) < 1e-10) throw new Error('晶胞奇异，无法设置观察方向。');
  const index = preset[0] === 'a' ? 0 : preset[0] === 'b' ? 1 : 2;
  const direct = [a, b, c];
  const reciprocal = [cross(b, c), cross(c, a), cross(a, b)].map(v => scale(v, Math.sign(volume)));
  return frame(preset.endsWith('*') ? reciprocal[index] : direct[index], index === 2 ? b : c);
}
