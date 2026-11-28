import type { Vector3 } from '../../../core/types';
import type { SurfaceScalarField } from '../../../results/surface-contracts';
import { createSurfaceFieldSampler } from '../../../results/surface-field';
import type { RigidTransform } from './alignment';
import { createScalarGradientNormals } from './field-gradient-normals';
import { meshGeometryChunks, packedMeshGeometry, type MeshGeometryChunk } from './mesh-geometry';
import { createSignedSurfaceMeshes, createSignedSurfaceMeshesWork, createSurfaceMesh, createSurfaceMeshWork, type SurfaceMeshTopology } from './surface-mesh';
import type { PackedChunk } from './surface-mesh-transfer';
import type { RenderWork } from './render-work';
import { packSurfaceSlabs } from './packed-surface-slabs';

type ScalarGrid = Pick<SurfaceScalarField, 'grid' | 'values'> & Partial<Pick<SurfaceScalarField, 'validDomain'>>;
export type MeshPreparation = { pose: RigidTransform; factor: number; isovalue: number } & (
  { kind: 'amplitude'; shape: ScalarGrid; phase?: 'positive' | 'negative' | 'both' }
  | { kind: 'surface'; shape: SurfaceScalarField; mapping: SurfaceScalarField | null; inside: 'above' | 'below'; restricted: boolean; sameGrid: boolean; positions: boolean; keepUnmappedShape?:boolean });

export type PreparedDisplayMesh = { sign: number; geometry: MeshGeometryChunk; samples?: number[]; sourcePositions?: Vector3[] }[];

function validCell(field: SurfaceScalarField, cell: Vector3) {
  const domain = field.validDomain;
  if (domain.kind === 'unknown') return false;
  if (domain.kind === 'full-grid') return true;
  const [, ny, nz] = field.grid.dimensions;
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    if (domain.mask[((cell[0] + x) * ny + cell[1] + y) * nz + cell[2] + z] !== 1) return false;
  }
  return true;
}

function surfaceSampling(request:Extract<MeshPreparation,{kind:'surface'}>) {
  const { mapping, restricted, sameGrid,keepUnmappedShape } = request;
  const sampler = mapping ? createSurfaceFieldSampler(mapping) : undefined;
  const sample = sampler ? (position: Vector3, cell: Vector3) => {
    const value = sampler(position, sameGrid ? cell : undefined);
    if(value===null&&!restricted&&!keepUnmappedShape)throw new Error('表面着色采样或插值邻点超出有效域，不能将域外填充值当作物理值。');
    return value;
  } : undefined;
  const admission=restricted?{
    cell:(cell:Vector3)=>validCell(request.shape,cell)&&(!mapping||!sameGrid||validCell(mapping,cell)),
    invalidSample:'skip-cell' as const,
  }:keepUnmappedShape?{invalidSample:'keep-shape' as const}:undefined;
  return {sample,admission};
}

export function* preparePackedDisplayMeshWork(request:MeshPreparation,topology:SurfaceMeshTopology):RenderWork<PackedChunk[]> {
  const {shape,isovalue,pose,factor}=request;
  const {sample,admission}=request.kind==='surface'?surfaceSampling(request):{};
  const slabs=yield* packSurfaceSlabs(request,topology,sample,admission);
  if(slabs!==null){
    if(request.kind==='surface'&&!slabs.length)throw new Error('当前标量等值及有效域没有可提交的表面三角形。');
    return slabs;
  }
  const normalAt=createScalarGradientNormals(shape);
  if(request.kind==='amplitude'){
    const sign=request.phase==='negative'?-1:1;
    const meshes=request.phase==='positive'||request.phase==='negative'
      ?[{sign,mesh:yield* createSurfaceMeshWork(shape,sign*isovalue,topology,undefined,sign<0?'below':'above')}]
      :yield* createSignedSurfaceMeshesWork(shape,isovalue,topology);
    const chunks:PackedChunk[]=[];
    for(const phase of meshes)for(const chunk of yield* packedMeshGeometry(phase.mesh,pose,factor,phase.sign,false,
      position=>normalAt(position,phase.sign>0?-1:1)))chunks.push(chunk);
    return chunks;
  }
  const mesh=yield* createSurfaceMeshWork(shape,isovalue,topology,sample,request.inside,admission);
  if(!mesh.faces.length)throw new Error('当前标量等值及有效域没有可提交的表面三角形。');
  return yield* packedMeshGeometry(mesh,pose,factor,1,request.positions,position=>normalAt(position,request.inside==='below'?1:-1));
}

/** Shared scientific builder for the visible Worker and synchronous exports. */
export function prepareDisplayMesh(request: MeshPreparation, topology: SurfaceMeshTopology): PreparedDisplayMesh {
  const { shape, isovalue, pose, factor } = request;
  const normalAt = createScalarGradientNormals(shape);
  if (request.kind === 'amplitude') {
    const sign = request.phase === 'negative' ? -1 : 1;
    const meshes = request.phase === 'positive' || request.phase === 'negative'
      ? [{ sign, mesh: createSurfaceMesh(shape, sign * isovalue, topology, undefined, sign < 0 ? 'below' : 'above') }]
      : createSignedSurfaceMeshes(shape, isovalue, topology);
    return meshes.flatMap(({ sign, mesh }) => meshGeometryChunks(mesh, pose, factor, undefined, false,
      position => normalAt(position, sign > 0 ? -1 : 1)).map(geometry => ({ sign, geometry })));
  }
  const {inside}=request,{sample,admission}=surfaceSampling(request);
  const mesh = createSurfaceMesh(shape, isovalue, topology, sample, inside, admission);
  if (!mesh.faces.length) throw new Error('当前标量等值及有效域没有可提交的表面三角形。');
  return meshGeometryChunks(mesh, pose, factor, undefined, mesh.values !== null, position => normalAt(position, inside === 'below' ? 1 : -1))
    .map(({ sourceIndices, ...geometry }) => ({ sign: 1, geometry,
      ...(mesh.values && sourceIndices ? { samples: sourceIndices.map(index => mesh.values![index]),
        ...(request.positions ? { sourcePositions: sourceIndices.map(index => mesh.vertices[index].map(value => value * factor) as Vector3) } : {}) } : {}),
    }));
}
