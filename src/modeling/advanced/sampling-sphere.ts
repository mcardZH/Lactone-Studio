import type { Vector3 } from '../../core/types';

export interface EnclosingSphere { centerAngstrom: Vector3; radiusAngstrom: number }
export interface SamplingSphereIdentity { sourceDocumentId: string; sourceRevision: number }
export interface SamplingSphereDraft extends EnclosingSphere, SamplingSphereIdentity {
  minimumRadiusAngstrom: number;
  marginAngstrom: number;
  previewEnabled: boolean;
}
export type SamplingSphereViewportDraft = Omit<SamplingSphereDraft, 'marginAngstrom'> & { disabled?: boolean };
export interface SamplingSphereRadiusChange extends SamplingSphereIdentity { radiusAngstrom: number }
type Point = readonly [number, number, number];
type Ball = { center: Vector3; radius: number };
const tolerance = 64 * Number.EPSILON;
const sub = (a: Point, b: Point): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point, b: Point): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const distance = (a: Point, b: Point) => Math.hypot(...sub(a, b));
const contains = (ball: Ball, point: Point) => distance(ball.center, point) <= ball.radius + tolerance * Math.max(1, ball.radius);

function through(points: Point[]): Ball | null {
  const origin = points[0];
  if (points.length === 1) return { center: [...origin], radius: 0 };
  if (points.length === 2) {
    const center = origin.map((v, i) => (v + points[1][i]) / 2) as Vector3;
    return { center, radius: distance(center, origin) };
  }
  const a = sub(points[1], origin), b = sub(points[2], origin);
  let offset: Vector3;
  if (points.length === 3) {
    const normal = cross(a, b), normal2 = dot(normal, normal);
    if (normal2 <= Number.EPSILON ** 2 * dot(a, a) * dot(b, b)) return null;
    const ba = cross(b, normal), na = cross(normal, a);
    offset = ba.map((v, i) => (v * dot(a, a) + na[i] * dot(b, b)) / (2 * normal2)) as Vector3;
  } else {
    const c = sub(points[3], origin);
    const bc = cross(b, c), ca = cross(c, a), ab = cross(a, b);
    const determinant = dot(a, bc);
    if (Math.abs(determinant) <= Number.EPSILON * Math.sqrt(dot(a, a) * dot(b, b) * dot(c, c))) return null;
    offset = bc.map((v, i) => (dot(a, a) * v + dot(b, b) * ca[i] + dot(c, c) * ab[i]) / (2 * determinant)) as Vector3;
  }
  const center = origin.map((v, i) => v + offset[i]) as Vector3;
  const radius = distance(center, origin);
  return Number.isFinite(radius) && center.every(Number.isFinite) ? { center, radius } : null;
}

/** A support set has at most four points. Enumerating its sub-balls also handles
 * obtuse, collinear, coplanar and duplicate support without perturbing atoms. */
function supportBall(points: Point[]): Ball {
  if (!points.length) return { center: [0, 0, 0], radius: -1 };
  let best: Ball | null = null;
  for (let mask = 1; mask < 1 << points.length; mask++) {
    const candidate = through(points.filter((_, i) => mask & (1 << i)));
    if (candidate && (!best || candidate.radius < best.radius) && points.every(point => contains(candidate, point))) best = candidate;
  }
  if (!best) throw new Error('无法确定原子坐标的最小包围球');
  return best;
}

/** Deterministic Welzl minimum enclosing ball, in normalized coordinates.
 * Explicit stack avoids recursion depth depending on the atom count. */
export function minimumEnclosingSphere(input: readonly Point[]): EnclosingSphere {
  if (!input.length) throw new Error('最小包围球需要至少一个原子');
  if (input.some(point => point.length !== 3 || !point.every(Number.isFinite))) throw new Error('原子坐标必须为有限三维坐标');
  const lo: Vector3 = [Infinity, Infinity, Infinity], hi: Vector3 = [-Infinity, -Infinity, -Infinity];
  for (const point of input) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], point[i]); hi[i] = Math.max(hi[i], point[i]); }
  const origin = lo.map((v, i) => v / 2 + hi[i] / 2) as Vector3;
  const scale = Math.max(...lo.map((v, i) => Math.max(Math.abs(v - origin[i]), Math.abs(hi[i] - origin[i]))));
  if (scale === 0) return { centerAngstrom: [...origin], radiusAngstrom: 0 };
  const points = input.map(point => point.map((v, i) => (v - origin[i]) / scale) as Vector3)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  let seed = 0x6d2b79f5;
  for (let i = points.length - 1; i > 0; i--) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const j = (seed >>> 0) % (i + 1); [points[i], points[j]] = [points[j], points[i]];
  }
  type Frame = { n: number; support: Point[]; phase: 0 | 1 | 2 };
  const stack: Frame[] = [{ n: points.length, support: [], phase: 0 }];
  let ball: Ball = { center: [0, 0, 0], radius: -1 };
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.phase === 0) {
      if (frame.n === 0 || frame.support.length === 4) { ball = supportBall(frame.support); stack.pop(); continue; }
      frame.phase = 1; stack.push({ n: frame.n - 1, support: frame.support, phase: 0 });
    } else if (frame.phase === 1) {
      const point = points[frame.n - 1];
      if (contains(ball, point)) { stack.pop(); continue; }
      frame.phase = 2; stack.push({ n: frame.n - 1, support: [...frame.support, point], phase: 0 });
    } else stack.pop();
  }
  const centerAngstrom = ball.center.map((v, i) => origin[i] + v * scale) as Vector3;
  // Cover final floating-point reconstruction rounding in the source frame.
  let radiusAngstrom = ball.radius * scale;
  for (const point of input) radiusAngstrom = Math.max(radiusAngstrom, distance(point, centerAngstrom));
  if (!centerAngstrom.every(Number.isFinite) || !Number.isFinite(radiusAngstrom)) throw new Error('原子坐标范围过大，无法表示有限包围球');
  return { centerAngstrom, radiusAngstrom };
}

export function createSamplingSphereDraft(sourceDocumentId: string, sourceRevision: number, points: readonly Point[], marginAngstrom = 3): SamplingSphereDraft {
  const sphere = minimumEnclosingSphere(points);
  return withSamplingSphereMargin({ ...sphere, sourceDocumentId, sourceRevision, minimumRadiusAngstrom: sphere.radiusAngstrom,
    marginAngstrom: 0, previewEnabled: true }, marginAngstrom);
}
export function withSamplingSphereMargin(draft: SamplingSphereDraft, marginAngstrom: number): SamplingSphereDraft {
  if (!Number.isFinite(marginAngstrom) || marginAngstrom < 0) throw new Error('外扩距离必须为有限非负数');
  const radiusAngstrom = draft.minimumRadiusAngstrom + marginAngstrom;
  if (!Number.isFinite(radiusAngstrom)) throw new Error('球半径超出有限范围');
  return { ...draft, marginAngstrom, radiusAngstrom };
}
export function withSamplingSphereRadius(draft: SamplingSphereDraft, radiusAngstrom: number): SamplingSphereDraft {
  if (!Number.isFinite(radiusAngstrom) || radiusAngstrom < draft.minimumRadiusAngstrom) throw new Error('球半径不能小于最小包围半径');
  return withSamplingSphereMargin(draft, radiusAngstrom - draft.minimumRadiusAngstrom);
}
export function sameSamplingSphereSource(a: SamplingSphereIdentity, b: SamplingSphereIdentity): boolean {
  return a.sourceDocumentId === b.sourceDocumentId && a.sourceRevision === b.sourceRevision;
}
export function applySamplingSphereRadiusChange(draft: SamplingSphereDraft, change: SamplingSphereRadiusChange): SamplingSphereDraft {
  return sameSamplingSphereSource(draft, change) ? withSamplingSphereRadius(draft, change.radiusAngstrom) : draft;
}

export function samplingSphereRadiusFromDrag(initialRadius: number, minimumRadius: number, center: { x: number; y: number },
  pointerStart: { x: number; y: number }, pointerNow: { x: number; y: number }, pixelsPerAngstrom?: number): number {
  const startDistance = Math.hypot(pointerStart.x - center.x, pointerStart.y - center.y);
  if (![initialRadius, minimumRadius, center.x, center.y, pointerStart.x, pointerStart.y, pointerNow.x, pointerNow.y].every(Number.isFinite) || startDistance < 1) return initialRadius;
  const delta = ((pointerNow.x - pointerStart.x) * (pointerStart.x - center.x) + (pointerNow.y - pointerStart.y) * (pointerStart.y - center.y)) / startDistance;
  const scale = pixelsPerAngstrom ?? (initialRadius > 0 ? startDistance / initialRadius : 1);
  if (!Number.isFinite(scale) || scale <= 0) return initialRadius;
  return Math.max(minimumRadius, initialRadius + delta / scale);
}
