import type { Vector3 } from '../../../core/types';
import type { MeshPreparation, PreparedDisplayMesh } from './surface-mesh-preparation';
import type { SurfaceMeshTopology } from './surface-mesh';

export type MeshParameters =
  | Omit<Extract<MeshPreparation, { kind: 'amplitude' }>, 'shape'>
  | Omit<Extract<MeshPreparation, { kind: 'surface' }>, 'shape' | 'mapping'>;

export type MeshSource = Pick<Extract<MeshPreparation, { kind: 'amplitude' }>, 'shape'>
  | Pick<Extract<MeshPreparation, { kind: 'surface' }>, 'shape' | 'mapping'>;

export interface MeshBuildPacket {
  id: number;
  parameters: MeshParameters;
  source?: MeshSource;
  topology?: SurfaceMeshTopology;
}

export type PackedChunk = {
  sign: number;
  vertices: Float64Array;
  normals: Float64Array;
  faces: Uint32Array | Uint16Array;
  samples?: Float64Array;
  sourcePositions?: Float64Array;
};
export type MeshBuildReply = { id: number; chunks: PackedChunk[] } | { id: number; error: string };

export function meshPacket(id: number, request: MeshPreparation, includeSource: boolean): MeshBuildPacket {
  if (request.kind === 'surface') {
    const { shape, mapping, ...parameters } = request;
    return { id, parameters, ...(includeSource ? { source: { shape, mapping } } : {}) };
  }
  const { shape, ...parameters } = request;
  return { id, parameters, ...(includeSource ? { source: { shape } } : {}) };
}

export function meshRequest(parameters: MeshParameters, source: MeshSource): MeshPreparation {
  if (parameters.kind === 'amplitude') return { ...parameters, shape: source.shape };
  if (!('mapping' in source)) throw new Error('表面网格来源未登记。');
  return { ...parameters, ...source };
}

function packPoints(points: readonly { x: number; y: number; z: number }[]) {
  const values = new Float64Array(points.length * 3);
  points.forEach(({ x, y, z }, index) => {
    const offset = index * 3;
    values[offset] = x;
    values[offset + 1] = y;
    values[offset + 2] = z;
  });
  return values;
}

export function packDisplayMesh(mesh: PreparedDisplayMesh): { chunks: PackedChunk[]; transfer: Transferable[] } {
  const transfer: Transferable[] = [];
  const chunks = mesh.map(({ sign, geometry, samples, sourcePositions }) => {
    const row: PackedChunk = { sign, vertices: packPoints(geometry.vertexArr),
      normals: packPoints(geometry.normalArr), faces: Uint32Array.from(geometry.faceArr) };
    if (samples) row.samples = Float64Array.from(samples);
    if (sourcePositions) {
      row.sourcePositions = new Float64Array(3 * sourcePositions.length);
      sourcePositions.forEach((point, index) => row.sourcePositions!.set(point, index * 3));
    }
    transfer.push(row.vertices.buffer, row.normals.buffer, row.faces.buffer);
    if (row.samples) transfer.push(row.samples.buffer);
    if (row.sourcePositions) transfer.push(row.sourcePositions.buffer);
    return row;
  });
  return { chunks, transfer };
}

function unpackPoints(values: Float64Array) {
  return Array.from({ length: values.length / 3 }, (_, index) => {
    const start = index * 3;
    return { x: values[start], y: values[start + 1], z: values[start + 2] };
  });
}

/** 3Dmol's public addCustom accepts point objects. Adapt just the current
 * native chunk and keep every pending, cached and transferred chunk typed. */
export function nativeMeshChunk({vertices,faces,normals}:PackedChunk) {
  return {vertexArr:unpackPoints(vertices),faceArr:Array.from(faces),normalArr:unpackPoints(normals)};
}

export function packedMeshTransfer(chunks:PackedChunk[]):Transferable[] {
  return chunks.flatMap(row=>[row.vertices.buffer,row.normals.buffer,row.faces.buffer,
    ...(row.samples?[row.samples.buffer]:[]),...(row.sourcePositions?[row.sourcePositions.buffer]:[])] as Transferable[]);
}

export function unpackDisplayMesh(chunks: PackedChunk[]): PreparedDisplayMesh {
  return chunks.map(({ sign, vertices, faces, normals, samples, sourcePositions }) => ({
    sign, geometry: { vertexArr: unpackPoints(vertices), faceArr: Array.from(faces), normalArr: unpackPoints(normals) },
    ...(samples ? { samples: Array.from(samples) } : {}),
    ...(sourcePositions ? { sourcePositions: unpackPoints(sourcePositions).map(({ x, y, z }): Vector3 => [x, y, z]) } : {}),
  }));
}
