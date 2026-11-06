import type { Vector3 } from '../../../core/types';
import { rotate, transformPoint, type RigidTransform } from './alignment';
import { point } from './geometry';
import type { SurfaceMesh } from './surface-mesh';

export interface MeshVertexColor { r: number; g: number; b: number }
export interface MeshGeometryChunk {
  vertexArr: { x: number; y: number; z: number }[]; faceArr: number[];
  normalArr: { x: number; y: number; z: number }[]; colorArr?: MeshVertexColor[];
  /** Construction-only correspondence; owners discard after selecting the
   * current chunk's scalar samples, never forward it into native stylespec. */
  sourceIndices?: number[];
}

/** Transform original double vertices, average face normals (not positions),
 * and chunk below locked 3Dmol's 64k split threshold without losing RGB. */
export function meshGeometryChunks(mesh: Pick<SurfaceMesh, 'vertices' | 'faces'>, pose: RigidTransform, factor: number, colors?: readonly MeshVertexColor[], collectSourceIndices = false,
  normalAt?: (sourcePosition: Vector3) => Vector3 | null): MeshGeometryChunk[] {
  if (!mesh.faces.length) return [];
  const vertices = mesh.vertices.map(v => point(transformPoint(pose, v.map(value => value * factor) as Vector3)));
  const normals = vertices.map(() => ({ x: 0, y: 0, z: 0 }));
  for (let i = 0; i < mesh.faces.length; i += 3) {
    const ids = mesh.faces.slice(i, i + 3), [a, b, c] = ids.map(id => vertices[id]);
    const ab = [b.x - a.x, b.y - a.y, b.z - a.z], ac = [c.x - a.x, c.y - a.y, c.z - a.z];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    for (const id of ids) { normals[id].x += n[0]; normals[id].y += n[1]; normals[id].z += n[2]; }
  }
  for (const n of normals) { const length = Math.hypot(n.x, n.y, n.z); if (length) { n.x /= length; n.y /= length; n.z /= length; } }
  if (normalAt) for (let index=0; index<mesh.vertices.length; index++) {
    const source = normalAt(mesh.vertices[index]); if (!source) continue;
    const n = rotate(pose.rotation,source), length = Math.hypot(...n);
    if (n.every(Number.isFinite) && length > 0) normals[index] = { x:n[0]/length, y:n[1]/length, z:n[2]/length };
  }
  const chunks: MeshGeometryChunk[] = [];
  let map = new Map<number, number>(), chunk: MeshGeometryChunk;
  const start = () => { map = new Map(); chunk = { vertexArr: [], faceArr: [], normalArr: [], ...(collectSourceIndices ? { sourceIndices: [] } : {}), ...(colors ? { colorArr: [] } : {}) }; chunks.push(chunk); };
  start();
  for (let i = 0; i < mesh.faces.length; i += 3) {
    if (map.size >= 63000) start();
    for (const id of mesh.faces.slice(i, i + 3)) {
      let local = map.get(id); if (local === undefined) { local = map.size; map.set(id, local); chunk!.vertexArr.push(vertices[id]); chunk!.normalArr.push(normals[id]); chunk!.sourceIndices?.push(id); if (colors) chunk!.colorArr!.push(colors[id]); }
      chunk!.faceArr.push(local);
    }
  }
  return chunks;
}
