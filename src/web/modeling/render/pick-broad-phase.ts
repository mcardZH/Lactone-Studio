import type { Vector3 } from '../../../core/types';

type Point = { x: number; y: number; z: number };
type ShapeInventory = {
  sphere?: {center: Point; radius: number}[];
  cylinder?: {c1: Point; c2: Point; radius: number}[];
  line?: unknown[];
  triangle?: {a: Point; b: Point; c: Point}[];
};
type Proxy = { intersectionShape?: ShapeInventory; boundingSphere?: {center: Point; radius: number}; };
type NativeViewer = {
  modelGroup?: {matrixWorld?: {elements: ArrayLike<number>}};
  camera?: unknown;
  raycaster?: {
    setFromCamera(point: Point, camera: unknown): unknown;
    ray: {origin: Point; direction: Point};
  };
};

/** Filter only conservative bounds. 3Dmol still determines the shape hit,
 * distance and tie ordering using its actual camera ray and selection proxies. */
export function createPickBroadPhase<T extends Proxy>() {
  let source: readonly T[] | undefined;
  let boxes: Float64Array<ArrayBufferLike> = new Float64Array();

  function prepare(targets: readonly T[]): void {
    source = targets;
    if (boxes.length < targets.length * 6) boxes = new Float64Array(targets.length * 6);
    let offset = 0;
    function include(point: Point, r = 0) {
      boxes[offset] = Math.min(boxes[offset], point.x - r);
      boxes[offset + 1] = Math.min(boxes[offset + 1], point.y - r);
      boxes[offset + 2] = Math.min(boxes[offset + 2], point.z - r);
      boxes[offset + 3] = Math.max(boxes[offset + 3], point.x + r);
      boxes[offset + 4] = Math.max(boxes[offset + 4], point.y + r);
      boxes[offset + 5] = Math.max(boxes[offset + 5], point.z + r);
    }
    for (const target of targets) {
      boxes.fill(Infinity, offset, offset + 3);
      boxes.fill(-Infinity, offset + 3, offset + 6);
      const shapes = target.intersectionShape;
      if (target.boundingSphere) include(target.boundingSphere.center, target.boundingSphere.radius);
      else if (shapes && !shapes.line?.length) {
        for (const sphere of shapes.sphere ?? []) include(sphere.center, sphere.radius);
        for (const cylinder of shapes.cylinder ?? []) { include(cylinder.c1, cylinder.radius); include(cylinder.c2, cylinder.radius); }
        for (const face of shapes.triangle ?? []) { include(face.a); include(face.b); include(face.c); }
      }
      offset += 6;
    }
  }

  return {
    invalidate() { source = undefined; },
    dispose() { source = undefined; boxes = new Float64Array(); },
    candidates(targets: readonly T[], viewer: NativeViewer, x: number, y: number): readonly T[] {
      if (targets.length < 128) return targets;
      const ray = localPickRay(viewer, x, y);
      if (!ray) return targets;
      if (source !== targets) prepare(targets);
      const selected: T[] = [];
      for (let i = 0; i < targets.length; i++) {
        const offset = i * 6;
        if (!Number.isFinite(boxes[offset]) || intersectsBox(boxes, offset, ray)) selected.push(targets[i]);
      }
      return selected;
    },
  };
}

type LocalRay = { origin: Vector3; direction: Vector3; padding: number };

function localPickRay(viewer: NativeViewer, x: number, y: number): LocalRay | null {
  const raw = viewer.modelGroup?.matrixWorld?.elements;
  const caster = viewer.raycaster;
  if (raw?.length !== 16 || !caster || typeof caster.setFromCamera !== 'function' || !viewer.camera
    || raw[3] !== 0 || raw[7] !== 0 || raw[11] !== 0 || raw[15] !== 1) return null;
  const a: Vector3 = [raw[0], raw[1], raw[2]], b: Vector3 = [raw[4], raw[5], raw[6]], c: Vector3 = [raw[8], raw[9], raw[10]];
  const dot = (u: Vector3, v: Vector3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  if (![dot(a,a)-1, dot(b,b)-1, dot(c,c)-1, dot(a,b), dot(a,c), dot(b,c)].every(n => Math.abs(n) < 1e-6)) return null;
  caster.setFromCamera({x, y, z: -1}, viewer.camera);
  const { origin, direction } = caster.ray;
  const translated: Vector3 = [origin.x - raw[12], origin.y - raw[13], origin.z - raw[14]];
  const vector: Vector3 = [direction.x, direction.y, direction.z];
  if (!translated.every(Number.isFinite) || !vector.every(Number.isFinite) || !vector.some(Boolean)) return null;
  return { origin: [dot(a,translated), dot(b,translated), dot(c,translated)], direction: [dot(a,vector), dot(b,vector), dot(c,vector)],
    padding: 1e-6 * Math.max(1, ...translated.map(Math.abs), Math.abs(raw[12]), Math.abs(raw[13]), Math.abs(raw[14])) };
}

function intersectsBox(boxes: Float64Array<ArrayBufferLike>, offset: number, ray: LocalRay): boolean {
  let near = 0, far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const lower = boxes[offset + axis], upper = boxes[offset + 3 + axis];
    const center = ray.origin[axis], direction = ray.direction[axis];
    // The native rotation matrix has Float32 elements. Widen bounds for the
    // roundoff in its inverse at the current scene and camera scales.
    const padding = ray.padding + 4e-6 * Math.max(Math.abs(lower), Math.abs(upper));
    if (direction === 0) {
      if (center < lower - padding || center > upper + padding) return false;
    } else {
      const lo = (lower - padding - center) / direction, hi = (upper + padding - center) / direction;
      near = Math.max(near, Math.min(lo, hi));
      far = Math.min(far, Math.max(lo, hi));
      if (near > far) return false;
    }
  }
  return true;
}
