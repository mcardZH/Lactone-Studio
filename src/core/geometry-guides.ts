import type { Atom, Structure, Vector3 } from './types';
import { coordinateValue } from './tasks';

export type PickerKind = 'atoms' | 'B' | 'A' | 'D';
export interface CoordinateGuide { type: 'B' | 'A' | 'D'; atoms: number[]; images?:Vector3[] }
export interface GuidePoint { x: number; y: number; z: number }
export interface GeometryGuide { paths: GuidePoint[][]; value: number | null; label: string; error?: string }
export const coordinateSize = (kind: PickerKind) => kind === 'B' ? 2 : kind === 'A' ? 3 : kind === 'D' ? 4 : Infinity;

/** The last distinct indices are retained in click/input order, all zero based. */
export function pickerSelection(indices: number[], kind: PickerKind, count: number): number[] {
  const valid: number[] = [];
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) continue;
    const previous = valid.indexOf(index);
    if (previous >= 0) valid.splice(previous, 1);
    valid.push(index);
  }
  return valid.slice(-coordinateSize(kind));
}

/** Coordinate and ordered atom identity guard: replaced structures never reuse open-dialog numbers. */
export function pickerStructureIdentity(structure: Structure): string {
  return JSON.stringify([structure.id, structure.atoms.map(atom => [atom.id, atom.element, atom.x, atom.y, atom.z])]);
}

const add = (a: GuidePoint, b: GuidePoint): GuidePoint => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: GuidePoint, b: GuidePoint): GuidePoint => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: GuidePoint, n: number): GuidePoint => ({ x: a.x * n, y: a.y * n, z: a.z * n });
const dot = (a: GuidePoint, b: GuidePoint) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a: GuidePoint) => Math.hypot(a.x, a.y, a.z);
const cross = (a: GuidePoint, b: GuidePoint): GuidePoint => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit = (a: GuidePoint) => scale(a, 1 / length(a));
const clearance = (a: Atom) => a.element === 'H' ? .24 : .39;
const trimmed = (a: Atom, b: Atom): GuidePoint[] => {
  const vector = sub(b, a), distance = length(vector);
  if (distance < 1e-10) return [];
  return [add(a, scale(vector, Math.min(clearance(a) / distance, .32))), add(b, scale(vector, -Math.min(clearance(b) / distance, .32)))];
};
function arc(center: GuidePoint, first: GuidePoint, second: GuidePoint, radius: number, signedAngle?: number): GuidePoint[] {
  const u = unit(first), v = unit(second), cosine = Math.max(-1, Math.min(1, dot(u, v)));
  const angle = signedAngle ?? Math.acos(cosine);
  let side = sub(v, scale(u, cosine));
  if (length(side) < 1e-9) {
    const reference = Math.abs(u.z) < .8 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    side = cross(reference, u);
  }
  side = unit(side);
  // The side direction already points toward the second vector for negative torsions.
  const magnitude = Math.abs(angle);
  return Array.from({ length: 33 }, (_, i) => add(center, scale(add(scale(u, Math.cos(magnitude * i / 32)), scale(side, Math.sin(magnitude * i / 32))), radius)));
}

/** Native model-space paths follow the viewer camera and never alter input coordinates. */
export function geometryGuide(atoms: Atom[], guide: CoordinateGuide): GeometryGuide {
  const indices = guide.atoms;
  const prefix = `${guide.type} ${indices.map(index => index + 1).join(' ')}`;
  if (indices.length !== coordinateSize(guide.type)) return { paths: [], value: null, label: `${prefix} · 请选择${coordinateSize(guide.type)}个原子` };
  if (new Set(indices).size !== indices.length || indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= atoms.length)) return { paths: [], value: null, label: prefix, error: '请选择范围内互不重复的原子。' };
  if (indices.some(index => ![atoms[index].x, atoms[index].y, atoms[index].z].every(Number.isFinite))) return { paths: [], value: null, label: prefix, error: '所选原子坐标不是有限数值，无法测量。' };
  try {
    const value = coordinateValue({ type: guide.type, atoms: indices.map(index => index + 1), steps: 1, increment: null }, atoms);
    const p = indices.map(index => atoms[index]);
    const label = `${prefix} = ${value.toFixed(guide.type === 'B' ? 3 : 2)}${guide.type === 'B' ? ' Å' : '°'}`;
    const paths: GuidePoint[][] = [];
    if (guide.type === 'B') {
      if (value < 1e-10) return { paths: [], value: null, label: prefix, error: '键长含重叠原子，无法显示辅助线。' };
      const direction = unit(sub(p[1], p[0]));
      const reference = Math.abs(direction.z) < .8 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
      const offset = scale(unit(cross(direction, reference)), .55);
      const start = add(p[0], offset), end = add(p[1], offset);
      paths.push([start, end], [add(p[0], scale(offset, .75)), start], [add(p[1], scale(offset, .75)), end]);
    } else if (guide.type === 'A') {
      paths.push(trimmed(p[0], p[1]), trimmed(p[1], p[2]));
      paths.push(arc(p[1], sub(p[0], p[1]), sub(p[2], p[1]), Math.max(.4, Math.min(.85, length(sub(p[0], p[1])) * .48, length(sub(p[2], p[1])) * .48))));
    } else {
      paths.push(trimmed(p[0], p[1]), trimmed(p[1], p[2]), trimmed(p[2], p[3]));
      const axis = unit(sub(p[2], p[1])), center = scale(add(p[1], p[2]), .5);
      const first = sub(sub(p[0], p[1]), scale(axis, dot(sub(p[0], p[1]), axis)));
      const second = sub(sub(p[3], p[2]), scale(axis, dot(sub(p[3], p[2]), axis)));
      const radius = Math.min(.8, Math.max(.45, Math.min(length(first), length(second)) * .5));
      const ray1 = add(center, scale(unit(first), radius)), ray2 = add(center, scale(unit(second), radius));
      paths.push([center, ray1], [center, ray2], [add(p[1], scale(unit(first), radius)), ray1], [add(p[2], scale(unit(second), radius)), ray2]);
      paths.push(arc(center, first, second, radius, value * Math.PI / 180));
    }
    return { paths: paths.filter(path => path.length > 1), value, label };
  } catch (error) {
    return { paths: [], value: null, label: prefix, error: error instanceof Error ? error.message : '无法定义此内坐标。' };
  }
}
