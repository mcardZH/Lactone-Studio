/** 3Dmol's public view stores a model-to-screen quaternion at indices 4–7.
 * Premultiplication applies a rotation about fixed SCREEN axes, regardless of
 * the previous pose. Screen right/up/toward-user correspond to GL x/y/z;
 * the user's left/toward-user/up axes are consequently -x/z/y.
 * A left drag turns toward-user into left; a downward drag turns it downward.
 * Use one axis-angle increment so diagonal paths have no Euler-order bias. */
export function rotateScreenView(view: number[], dx: number, dy: number): number[] {
  const result = [...view], length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || view.length < 8 || !view.every(Number.isFinite)) throw new Error('视角增量无效。');
  if (!length) return result;
  const norm = Math.hypot(...view.slice(4, 8));
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('视角四元数无效。');
  const [x, y, z, w] = view.slice(4, 8).map(v => v / norm);
  const angle = length * .4 * Math.PI / 180, s = Math.sin(angle / 2) / length;
  const a = dy * s, b = dx * s, d = Math.cos(angle / 2);
  const next = [d * x + a * w + b * z, d * y + b * w - a * z, d * z + a * y - b * x, d * w - a * x - b * y];
  const n = Math.hypot(...next);
  result.splice(4, 4, ...next.map(v => v / n));
  return result;
}
import type { Vector3 } from '../../../core/types';
import { add, cross, dot, rotateVector, subtract } from './geometry';
import type { ViewFrame } from './view-frame';
export { cellViewFrame, principalInertiaFrame, type CellViewPreset, type InertiaViewFrame, type ViewFrame } from './view-frame';

/** Preserve the displayed pivot exactly while applying a screen-axis rotation.
 * 3Dmol renders q * (raw + modelTranslation); compensate the translation so
 * q' * (pivot + translation') == q * (pivot + translation). Zoom and any
 * additional public view pan entries are retained. No raw XYZ is changed. */
export function rotateObjectView(view: number[], dx: number, dy: number, pivot: Vector3): number[] {
  if (pivot.length !== 3 || !pivot.every(Number.isFinite) || !view.slice(0, 3).every(Number.isFinite)) throw new Error('观察旋转中心无效。');
  const next = rotateScreenView(view, dx, dy);
  const oldQ = view.slice(4, 8), norm = Math.hypot(...oldQ);
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('视角四元数无效。');
  if (!dx && !dy) return next;
  const displayed = rotateVector(add(pivot, view.slice(0, 3) as Vector3), oldQ.map(v => v / norm));
  const q = next.slice(4, 8), inverse = q.map((v, i) => i < 3 ? -v : v);
  next.splice(0, 3, ...subtract(rotateVector(displayed, inverse), pivot));
  return next;
}

export type ScreenViewDirection = 'left' | 'right' | 'up' | 'down';
/** One exact 45° screen-axis increment. No accumulated angle cap or Euler
 * reset; q and -q are equivalent after eight equal increments. Drag remains
 * on the smooth pixel-based rotateObjectView route. */
export function rotateObjectViewStep(view: number[], direction: ScreenViewDirection, pivot: Vector3): number[] {
  const steps: Record<ScreenViewDirection, [number, number]> = { left: [-112.5, 0], right: [112.5, 0], up: [0, -112.5], down: [0, 112.5] };
  const delta = steps[direction];
  if (!delta) throw new Error('观察旋转方向无效。');
  return rotateObjectView(view, ...delta, pivot);
}

function normalizedViewQuaternion(view: number[]): number[] {
  if (view.length < 8 || !view.every(Number.isFinite)) throw new Error('视角状态无效。');
  const q = view.slice(4, 8), n = Math.hypot(...q);
  if (!Number.isFinite(n) || n < 1e-12) throw new Error('视角四元数无效。');
  return q.map(v => v / n);
}

/** Absolute orientation about the existing displayed pivot. The frame and
 * pivot must both be in displayed coordinates, after any observation-frame
 * transform. All other view fields (zoom and optional scene-pan) are retained.
 * Translation is compensated to keep the pivot at the same SCREEN position. */
export function orientObjectView(view: number[], frame: ViewFrame, pivot: Vector3): number[] {
  const previous = normalizedViewQuaternion(view), rows = [frame.right, frame.up, frame.toward];
  if (pivot.length !== 3 || !pivot.every(Number.isFinite) || rows.some(v => v.length !== 3 || !v.every(Number.isFinite) || Math.abs(Math.hypot(...v) - 1) > 1e-8)
    || Math.abs(dot(rows[0], rows[1])) > 1e-8 || Math.abs(dot(rows[0], rows[2])) > 1e-8 || Math.abs(dot(rows[1], rows[2])) > 1e-8
    || dot(cross(rows[0], rows[1]), rows[2]) < 1 - 1e-8) throw new Error('观察坐标框架无效。');
  // Proper rotation matrix rows are the model-space screen basis vectors.
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = rows, trace = xx + yy + zz;
  let q: number[];
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1); q = [(zy - yz) / s, (xz - zx) / s, (yx - xy) / s, s / 4];
  } else if (xx >= yy && xx >= zz) {
    const s = 2 * Math.sqrt(1 + xx - yy - zz); q = [s / 4, (xy + yx) / s, (xz + zx) / s, (zy - yz) / s];
  } else if (yy >= zz) {
    const s = 2 * Math.sqrt(1 + yy - xx - zz); q = [(xy + yx) / s, s / 4, (yz + zy) / s, (xz - zx) / s];
  } else {
    const s = 2 * Math.sqrt(1 + zz - xx - yy); q = [(xz + zx) / s, (yz + zy) / s, s / 4, (yx - xy) / s];
  }
  const norm = Math.hypot(...q); q = q.map(v => v / norm);
  const displayed = rotateVector(add(pivot, view.slice(0, 3) as Vector3), previous);
  const inverse = q.map((v, i) => i < 3 ? -v : v);
  const next = [...view];
  next.splice(0, 3, ...subtract(rotateVector(displayed, inverse), pivot)); next.splice(4, 4, ...q);
  return next;
}

export interface PhysicalAxisProjection { axis: 'X' | 'Y' | 'Z'; x: number; y: number; depth: number }
/** Orthographic screen-widget directions of the actual physical XYZ axes.
 * HTML y is downward; positive depth faces the observer. Include the current
 * rigid observation rotation, never its translation. No physical XYZ edits,
 * normalization of projected 2D length, perspective or cell deformation. */
export function projectPhysicalAxes(view: number[], displayRotation: [Vector3, Vector3, Vector3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]): PhysicalAxisProjection[] {
  const q = normalizedViewQuaternion(view);
  if (displayRotation.some(v => v.length !== 3 || !v.every(Number.isFinite) || Math.abs(Math.hypot(...v) - 1) > 1e-8)
    || Math.abs(dot(displayRotation[0], displayRotation[1])) > 1e-8 || Math.abs(dot(displayRotation[0], displayRotation[2])) > 1e-8 || Math.abs(dot(displayRotation[1], displayRotation[2])) > 1e-8
    || dot(cross(displayRotation[0], displayRotation[1]), displayRotation[2]) < 1 - 1e-8) throw new Error('物理坐标轴观察变换无效。');
  return (['X', 'Y', 'Z'] as const).map((axis, i) => {
    const v = rotateVector(displayRotation.map(row => row[i]) as Vector3, q);
    return { axis, x: v[0], y: -v[1], depth: v[2] };
  });
}
