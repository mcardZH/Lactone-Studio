import type { Vector3 } from '../../../core/types';
import type { VibrationVectorAppearance } from '../../../results/surface-appearance-presets';
import { includeRenderPoint, type RenderBounds } from './depth-envelope';
import { createShapeLayer } from './shape-layer';
import type { NativeCoordinateRange, retainNativeCoordinateUpload } from './native-coordinate-upload';
import { retainNativeShapeRoot } from './shape-resource-lifecycle';

type Point = { x: number; y: number; z: number };
export type NativeBatchRod = { start: Point; end: Point; radius: number; color: any; fromCap?: number; toCap?: number };
export type NativeBatchSphere = { center: Point; radius: number; color: any };
export type NativeBatchArrow = { start: Point; displacement: Vector3 } & VibrationVectorAppearance;

type Group = {
  vertices: number;
  faceidx: number;
  lineidx: number;
  vertexArray: Float32Array;
  normalArray: Float32Array;
  colorArray: Float32Array;
  faceArray: Uint16Array;
  lineArray: Uint16Array;
};
type RodTemplate = {
  local: Float64Array;
  normals: Float64Array;
  endpoint: Uint8Array;
  colored: Uint8Array;
  faces: Uint16Array;
  lines: Uint16Array;
  reservedVertices: number;
};
type RodPlacement = {
  radius: number; color: string | number; fromCap: number; toCap: number;
  group: number; first: number; template: RodTemplate;
};
const GROUP_VERTICES = 65535;
const coordinates = ({ x, y, z }: Point): Vector3 => [x, y, z];

/** Capture the locked tessellator's local vertex/normal data in double
 * precision. Moving the two canonical endpoints by different amounts reveals
 * which endpoint owns each vertex, including duplicated cap rings. */
function nativeRodTemplate(mol: any, radius: number, fromCap: number, toCap: number): RodTemplate | undefined {
  const sample = (start: number, end: number) => {
    let group: (Omit<Group, 'vertexArray' | 'normalArray'> & { vertexArray: Float64Array; normalArray: Float64Array }) | undefined;
    const geometry = { updateGeoGroup(vertices: number) {
      group = { vertices: 0, faceidx: 0, lineidx: 0,
        vertexArray: new Float64Array(vertices * 3), normalArray: new Float64Array(vertices * 3),
        colorArray: new Float32Array(vertices * 3), faceArray: new Uint16Array(vertices * 6), lineArray: new Uint16Array(vertices * 12) };
      return group;
    } };
    mol.GLDraw.drawCylinder(geometry, { x: 0, y: start, z: 0 }, { x: 0, y: end, z: 0 }, radius, { r: 1, g: 1, b: 1 }, fromCap, toCap);
    return group;
  };
  let first: ReturnType<typeof sample>, second: ReturnType<typeof sample>;
  try { first = sample(0, 2); second = sample(-1, 0); }
  catch { return; } // Native drawing has already succeeded for the actual rod.
  if (!first || !second || !first.vertices || first.vertices !== second.vertices || first.faceidx !== second.faceidx || first.lineidx !== second.lineidx) return;
  const local = new Float64Array(first.vertices * 3), endpoint = new Uint8Array(first.vertices), colored = new Uint8Array(first.vertices);
  for (let index = 0; index < endpoint.length; index++) {
    const offset = index * 3;
    const delta = first.vertexArray[offset + 1] - second.vertexArray[offset + 1];
    const owner = Math.abs(delta - 1) < 1e-12 ? 1 : Math.abs(delta - 2) < 1e-12 ? 2 : 0;
    for (let axis = 0; axis < 3; axis++) {
      const i = offset + axis;
      if (!Number.isFinite(first.vertexArray[i]) || !Number.isFinite(second.vertexArray[i]) || !Number.isFinite(first.normalArray[i])
        || first.normalArray[i] !== second.normalArray[i] || (axis !== 1 && first.vertexArray[i] !== second.vertexArray[i])
        || (!owner && (first.vertexArray[i] || second.vertexArray[i] || first.normalArray[i]))) return;
      local[i] = (owner === 2 ? second : first).vertexArray[i];
    }
    endpoint[index] = owner;
    const color = first.colorArray[offset];
    if ((color !== 0 && color !== 1) || first.colorArray[offset + 1] !== color || first.colorArray[offset + 2] !== color
      || second.colorArray[offset] !== color || second.colorArray[offset + 1] !== color || second.colorArray[offset + 2] !== color) return;
    colored[index] = color;
  }
  const faces = first.faceArray.slice(0, first.faceidx);
  const lines = first.lineArray.slice(0, first.lineidx);
  if (faces.some((index, i) => !endpoint[index] || index !== second.faceArray[i]) ||
      lines.some((index, i) => !endpoint[index] || index !== second.lineArray[i])) return;
  return { local, normals: first.normalArray, endpoint, colored, faces, lines, reservedVertices: first.vertexArray.length / 3 };
}

function writeRodPose(row: NativeBatchRod, placement: RodPlacement, target: Group) {
  const { start, end } = row;
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  // Match GLDraw.getRotationMatrix, including its near-axis branch and the
  // Float32 matrix coefficients used by the locked native tessellator.
  const xy = Math.hypot(dx, dy), sinA = xy < .0001 ? 0 : -dx / xy, cosA = xy < .0001 ? 1 : dy / xy;
  const along = -sinA * dx + cosA * dy, yz = Math.hypot(along, dz);
  const sinB = yz < .0001 ? 0 : dz / yz, cosB = yz < .0001 ? 1 : along / yz;
  const xx = Math.fround(cosA), yx = Math.fround(sinA);
  const xyAxis = Math.fround(-sinA * cosB), yy = Math.fround(cosA * cosB), zy = Math.fround(sinB);
  const xz = Math.fround(sinA * sinB), yzAxis = Math.fround(-cosA * sinB), zz = Math.fround(cosB);
  const { local, normals, endpoint } = placement.template;
  const { vertexArray, normalArray } = target;
  for (let index = 0; index < endpoint.length; index++) {
    const owner = endpoint[index];
    if (!owner) continue;
    const center = owner === 1 ? start : end, offset = index * 3, dest = (placement.first + index) * 3;
    const x = local[offset], y = local[offset + 1], z = local[offset + 2];
    vertexArray[dest] = (xx * x + xyAxis * y + xz * z) + center.x;
    vertexArray[dest + 1] = (yx * x + yy * y + yzAxis * z) + center.y;
    vertexArray[dest + 2] = (zy * y + zz * z) + center.z;
    const nx = normals[offset], ny = normals[offset + 1], nz = normals[offset + 2];
    normalArray[dest] = xx * nx + xyAxis * ny + xz * nz;
    normalArray[dest + 1] = yx * nx + yy * ny + yzAxis * nz;
    normalArray[dest + 2] = zy * ny + zz * nz;
  }
}

function appendRodTemplate(row: NativeBatchRod, placement: RodPlacement, target: Group, color: { r: number; g: number; b: number }) {
  const { template, first } = placement;
  writeRodPose(row, placement, target);
  for (let index = 0; index < template.colored.length; index++) {
    if (!template.colored[index]) continue;
    const offset = (first + index) * 3;
    target.colorArray[offset] = color.r;
    target.colorArray[offset + 1] = color.g;
    target.colorArray[offset + 2] = color.b;
  }
  for (const index of template.faces) target.faceArray[target.faceidx++] = index + first;
  for (const index of template.lines) target.lineArray[target.lineidx++] = index + first;
  target.vertices += template.endpoint.length;
}

export function nativePrimitiveBatchesAvailable(viewer: any, mol: any): boolean {
  return typeof viewer.addShape === 'function' && typeof mol.GLShape?.drawArrow === 'function' &&
    typeof mol.GLDraw?.drawCylinder === 'function' && typeof mol.GLDraw?.drawSphere === 'function' &&
    typeof mol.CC?.color === 'function';
}

/** Batches opaque meshes built by the locked 3Dmol tessellators. The scene
 * continues to own the original bond/atom hit geometry independently. Scratch
 * buffers are private until the caller publishes a complete display frame. */
function replaceGroupArray<T extends Float32Array | Uint16Array>(target: T, source: T, used: number): T {
  if (target.length !== used) return source.slice(0, used) as T;
  target.set(source.subarray(0, used));
  return target;
}

export function createNativePrimitiveBatch(viewer: any, mol: any, uploads?: ReturnType<typeof retainNativeCoordinateUpload>) {
  const layer = createShapeLayer(viewer);
  const scratch: Group[] = [];
  let used = 0;
  let handle: any;
  let finishKey = '';
  let publishedBounds: RenderBounds | null = null;
  let rodLayout: { key: string; rows: readonly NativeBatchRod[]; placements: RodPlacement[]; groups: Group[] } | undefined;
  let rodTemplates = new Map<string, RodTemplate | undefined>();
  let arrowLayout: {
    rows: readonly NativeBatchArrow[];
    offsets: { group: number; first: number }[];
    origins: Float32Array[];
  } | undefined;
  const noPicking = { cylinder: { push() {} }, sphere: { push() {} }, triangle: { push() {} } };

  function scratchGeometry() {
    used = 0;
    return { updateGeoGroup(vertices: number) {
      const last = scratch[used - 1];
      if (last && last.vertices + vertices <= GROUP_VERTICES) return last;
      const group = scratch[used] ??= {
        vertices: 0, faceidx: 0, lineidx: 0,
        vertexArray: new Float32Array(GROUP_VERTICES * 3),
        normalArray: new Float32Array(GROUP_VERTICES * 3),
        colorArray: new Float32Array(GROUP_VERTICES * 3),
        faceArray: new Uint16Array(GROUP_VERTICES * 6),
        // The locked sphere/arrow generators can write more than six wire
        // indices per vertex even when the eventual material is solid.
        lineArray: new Uint16Array(GROUP_VERTICES * 12),
      };
      group.vertexArray.fill(0, 0, group.vertices * 3);
      group.normalArray.fill(0, 0, group.vertices * 3);
      group.colorArray.fill(0, 0, group.vertices * 3);
      group.vertices = group.faceidx = group.lineidx = 0;
      used++;
      return group;
    } };
  }

  function bounds(shape: any, next: RenderBounds | null) {
    publishedBounds = next;
    if (!next) return;
    const { min, max } = next;
    const half = max.map((value, axis) => (value - min[axis]) * .5) as Vector3;
    shape.boundingSphere.center.set(min[0] + half[0], min[1] + half[1], min[2] + half[2]);
    shape.boundingSphere.radius = Math.hypot(...half);
  }

  function publish(groups: readonly Group[], nextBounds: RenderBounds | null, key: string, decorate?: (shape: any) => void, retainRodGroups = false) {
    if (!groups.length) {
      layer.clear();
      handle = undefined;
      publishedBounds = null;
      scratch.length = 0;
      return;
    }
    const previous = handle?.geo.geometryGroups as Group[] | undefined;
    const sameGroups = key === finishKey && previous?.length === groups.length;
    const canReuse = sameGroups && (retainRodGroups || groups.every((group, index) => {
      const target = previous[index];
      return group.vertices === target.vertices && group.faceidx === target.faceidx && group.lineidx === target.lineidx;
    }));
    if (canReuse && previous) {
      for (const [index, source] of groups.entries()) {
        const target = previous[index];
        target.vertices = source.vertices;
        target.faceidx = source.faceidx;
        target.lineidx = source.lineidx;
        target.vertexArray = replaceGroupArray(target.vertexArray, source.vertexArray, source.vertices * 3);
        target.normalArray = replaceGroupArray(target.normalArray, source.normalArray, source.vertices * 3);
        target.colorArray = replaceGroupArray(target.colorArray, source.colorArray, source.vertices * 3);
        target.faceArray = replaceGroupArray(target.faceArray, source.faceArray, source.faceidx);
        target.lineArray = replaceGroupArray(target.lineArray, source.lineArray, source.lineidx);
      }
      handle.geo.verticesNeedUpdate = true;
      handle.geo.normalsNeedUpdate = true;
      handle.geo.colorsNeedUpdate = true;
      handle.geo.elementsNeedUpdate = true;
    } else {
      const shape = viewer.addShape({ clickable: false, hoverable: false });
      try {
        // The native material must consume the per-vertex color array.
        delete shape.color;
        for (const source of groups) {
          const target = shape.geo.addGeoGroup();
          target.vertices = source.vertices;
          target.faceidx = source.faceidx;
          target.lineidx = source.lineidx;
          target.vertexArray = source.vertexArray.slice(0, source.vertices * 3);
          target.normalArray = source.normalArray.slice(0, source.vertices * 3);
          target.colorArray = source.colorArray.slice(0, source.vertices * 3);
          target.faceArray = source.faceArray.slice(0, source.faceidx);
          target.lineArray = source.lineArray.slice(0, source.lineidx);
        }
        decorate?.(shape);
        retainNativeShapeRoot(shape);
        bounds(shape, nextBounds);
        layer.keep(shape);
      } catch (error) {
        if (layer.has(shape)) layer.remove([shape]); else viewer.removeShape(shape);
        throw error;
      }
      if (handle) layer.remove([handle]);
      handle = shape;
      finishKey = key;
    }
    bounds(handle, nextBounds);
  }

  return {
    *prepareRods(rows: readonly NativeBatchRod[], key: string, decorate: (shape: any) => void) {
      let nextBounds: RenderBounds | null = null;
      const previous = rodLayout;
      const isStable = previous?.key === key && previous.placements.length === rows.length && rows.every((row, index) => {
        const placement = previous.placements[index];
        return placement.radius === row.radius && placement.color === row.color
          && placement.fromCap === (row.fromCap ?? 0) && placement.toCap === (row.toCap ?? 0);
      });
      if (isStable) {
        const changed: RodPlacement[] = [];
        for (const [index, row] of rows.entries()) {
          const placement = previous.placements[index], old = previous.rows[index];
          if (row.start.x !== old.start.x || row.start.y !== old.start.y || row.start.z !== old.start.z ||
              row.end.x !== old.end.x || row.end.y !== old.end.y || row.end.z !== old.end.z) {
            writeRodPose(row, placement, previous.groups[placement.group]);
            changed.push(placement);
          }
          nextBounds = includeRenderPoint(nextBounds, coordinates(row.start), row.radius);
          nextBounds = includeRenderPoint(nextBounds, coordinates(row.end), row.radius);
          yield;
        }
        return () => {
          const targets = handle.geo.geometryGroups as Group[];
          if (changed.length) {
            const ranges = new Map<number, NativeCoordinateRange>();
            for (const placement of changed) {
              const target = targets[placement.group], source = previous.groups[placement.group];
              const start = placement.first * 3, end = start + placement.template.endpoint.length * 3;
              // Staged pose work can be cancelled. Only commit rows written
              // by this preparation, even when a GPU upload spans more rows.
              target.vertexArray.set(source.vertexArray.subarray(start, end), start);
              target.normalArray.set(source.normalArray.subarray(start, end), start);
              const range = ranges.get(placement.group);
              if (range) { range.start = Math.min(start, range.start); range.end = Math.max(end, range.end); }
              else ranges.set(placement.group, { start, end });
            }
            const poseResident = uploads && targets.every((target, index) =>
              uploads.mark(handle.geo, target, true, ranges.get(index) ?? { start: 0, end: 0 }));
            handle.geo.verticesNeedUpdate = true;
            if (!poseResident) handle.geo.normalsNeedUpdate = true;
          }
          previous.rows = rows;
          bounds(handle, nextBounds);
        };
      }
      rodLayout = undefined;
      const geometry = scratchGeometry(), templates = new Map<string, RodTemplate | undefined>(), placements: RodPlacement[] = [];
      for (const row of rows) {
        const fromCap = row.fromCap ?? 0, toCap = row.toCap ?? 0;
        const color = mol.CC.color(row.color);
        const templateKey = (typeof row.color === 'string' || typeof row.color === 'number') &&
          [0, 1, 2].includes(fromCap) && [0, 1, 2].includes(toCap) ? [row.radius, fromCap, toCap].join(':') : undefined;
        const retained = templateKey === undefined ? undefined : rodTemplates.get(templateKey);
        if (templateKey !== undefined && retained && color && [color.r, color.g, color.b].every(Number.isFinite)) {
          const group = geometry.updateGeoGroup(retained.reservedVertices);
          const placement = { radius: row.radius, color: row.color, fromCap, toCap, group: used - 1, first: group.vertices, template: retained };
          appendRodTemplate(row, placement, group, color);
          placements.push(placement);
          templates.set(templateKey, retained);
        } else {
          const last = scratch[used - 1], first = last?.vertices ?? 0, firstFace = last?.faceidx ?? 0;
          mol.GLDraw.drawCylinder(geometry, row.start, row.end, row.radius, color, fromCap, toCap);
          if (templateKey !== undefined) {
            if (!templates.has(templateKey)) {
              const template = rodTemplates.has(templateKey) ? retained : nativeRodTemplate(mol, row.radius, fromCap, toCap);
              templates.set(templateKey, template);
            }
            const template = templates.get(templateKey), group = scratch[used - 1];
            const offset = group === last ? first : 0, faceOffset = group === last ? firstFace : 0;
            if (group && template && group.vertices - offset === template.endpoint.length && group.faceidx - faceOffset === template.faces.length) {
              placements.push({ radius: row.radius, color: row.color, fromCap, toCap, group: used - 1, first: offset, template });
            }
          }
        }
        nextBounds = includeRenderPoint(nextBounds, coordinates(row.start), row.radius);
        nextBounds = includeRenderPoint(nextBounds, coordinates(row.end), row.radius);
        yield;
      }
      const groups = scratch.slice(0, used);
      return () => {
        publish(groups, nextBounds, key, decorate, true);
        rodLayout = rows.length && placements.length === rows.length ? { key, rows, placements, groups } : undefined;
        rodTemplates = templates;
        arrowLayout = undefined;
      };
    },
    *prepareSpheres(rows: readonly NativeBatchSphere[], key: string, decorate: (shape: any) => void) {
      rodLayout = undefined;
      const geometry = scratchGeometry();
      let nextBounds: RenderBounds | null = null;
      for (const row of rows) {
        mol.GLDraw.drawSphere(geometry, row.center, row.radius, mol.CC.color(row.color));
        nextBounds = includeRenderPoint(nextBounds, coordinates(row.center), row.radius);
        yield;
      }
      const groups = scratch.slice(0, used);
      return () => { publish(groups, nextBounds, key, decorate); arrowLayout = undefined; };
    },
    prepareArrows(rows: readonly NativeBatchArrow[]) {
      if (!rows.length) return () => { publish([], null, ''); arrowLayout = undefined; rodLayout = undefined; };
      let nextBounds: RenderBounds | null = null;
      for (const row of rows) {
        const { x, y, z } = row.start, [dx, dy, dz] = row.displacement;
        nextBounds = includeRenderPoint(nextBounds, [x, y, z], row.radius);
        nextBounds = includeRenderPoint(nextBounds, [x + dx, y + dy, z + dz], row.radius * row.radiusRatio);
      }
      const stable = arrowLayout && arrowLayout.rows.length === rows.length && rows.every((row, index) => {
        const previous = arrowLayout!.rows[index];
        return row.color === previous.color && row.radius === previous.radius && row.radiusRatio === previous.radiusRatio &&
          row.mid === previous.mid && row.displacement.every((value, axis) => value === previous.displacement[axis]);
      });
      if (stable) return () => {
        const { offsets, origins, rows: base } = arrowLayout!;
        const groups = handle.geo.geometryGroups as Group[];
        let changed = false;
        for (const [index, row] of rows.entries()) {
          const start = row.start, original = base[index].start;
          const dx = start.x - original.x, dy = start.y - original.y, dz = start.z - original.z;
          const { group, first } = offsets[index], source = origins[group], target = groups[group].vertexArray;
          // Native GLShape.drawArrow contributes 51 vertices per arrow.
          for (let offset = first; offset < first + 153; offset += 3) {
            changed ||= target[offset] !== Math.fround(source[offset] + dx) ||
              target[offset + 1] !== Math.fround(source[offset + 1] + dy) || target[offset + 2] !== Math.fround(source[offset + 2] + dz);
            target[offset] = source[offset] + dx;
            target[offset + 1] = source[offset + 1] + dy;
            target[offset + 2] = source[offset + 2] + dz;
          }
        }
        if (changed) handle.geo.verticesNeedUpdate = true;
        bounds(handle, nextBounds);
      };
      rodLayout = undefined;
      const geometry = scratchGeometry(), offsets: NonNullable<typeof arrowLayout>['offsets'] = [];
      for (const row of rows) {
        const group = geometry.updateGeoGroup(51), first = group.vertices * 3;
        const { x, y, z } = row.start, [dx, dy, dz] = row.displacement;
        const start = new mol.Vector3(x, y, z), end = new mol.Vector3(x + dx, y + dy, z + dz);
        mol.GLShape.drawArrow({ intersectionShape: noPicking }, geometry, { ...row, start, end });
        const color = mol.CC.color(row.color);
        for (let offset = first; offset < group.vertices * 3; offset += 3) {
          group.colorArray[offset] = color.r;
          group.colorArray[offset + 1] = color.g;
          group.colorArray[offset + 2] = color.b;
        }
        offsets.push({ group: used - 1, first });
      }
      const groups = scratch.slice(0, used);
      return () => {
        publish(groups, nextBounds, '');
        arrowLayout = { rows, offsets, origins: groups.map(group => group.vertexArray.slice(0, group.vertices * 3)) };
        rodLayout = undefined;
      };
    },
    owns: (shape: any) => shape === handle,
    handle: () => handle,
    bounds: () => publishedBounds,
    clear() {
      layer.clear();
      handle = undefined;
      arrowLayout = undefined;
      rodLayout = undefined;
      rodTemplates.clear();
      publishedBounds = null;
      scratch.length = 0;
    },
  };
}
