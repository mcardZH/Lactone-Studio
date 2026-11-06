import type { Vector3 } from '../../../core/types';
import type { SurfaceScalarField } from '../../../results/surface-contracts';

/** The locked 3Dmol full marching-cubes topology; scalar values stay ours. */
export interface SurfaceMeshTopology { edgeTable2: ArrayLike<number>; triTable2: readonly (readonly number[])[] }
export interface SurfaceMesh {
  vertices: Vector3[]; faces: number[]; values: number[] | null; crossingCells: number;
}
export interface SurfaceMeshAdmission {
  cell?: (cell: Vector3) => boolean;
  /** Only explicitly restricted interaction fields may omit an entire cell
   * when an independently positioned mapping stencil is outside its domain. */
  invalidSample?: 'skip-cell';
}
const EDGES = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [3, 7], [2, 6]] as const;
const corner = (cell: Vector3, code: number): Vector3 => [cell[0] + ((code & 4) >> 2), cell[1] + ((code & 2) >> 1), cell[2] + (code & 1)];

/** Positions and mapping samples are computed before display transforms and
 * Float32 upload. No binary endpoint approximation or vertex-moving smoothing.
 * Interior defaults to above for every signed level; callers explicitly choose
 * below when the scalar's scientific definition requires a low-valued interior. */
export function createSurfaceMesh(shape: Pick<SurfaceScalarField, 'grid' | 'values'>, isovalue: number, topology: SurfaceMeshTopology,
  sample?: (position: Vector3, crossingCell: Vector3) => number | null, inside: 'above' | 'below' = 'above',
  admission?: SurfaceMeshAdmission, classification?: Uint8Array): SurfaceMesh {
  if (topology?.edgeTable2?.length !== 256 || topology?.triTable2?.length !== 256) throw new Error('缺少锁定的分子表面三角拓扑。');
  if (!Number.isFinite(isovalue)) throw new Error('标量表面等值须为有限数。');
  if (inside !== 'above' && inside !== 'below') throw new Error('标量表面内部定义无效。');
  const grid = shape.grid, [nx, ny, nz] = grid.dimensions, scalar = shape.values;
  if(classification&&classification.length!==(nx-1)*(ny-1)*(nz-1))throw new Error('等值面单元分类与网格不一致。');
  const [axisA, axisB, axisC] = grid.axes;
  // An affine reflection flips triangle winding, not the scalar's interior.
  const reverseWinding = axisA[0] * (axisB[1] * axisC[2] - axisB[2] * axisC[1])
    - axisA[1] * (axisB[0] * axisC[2] - axisB[2] * axisC[0]) + axisA[2] * (axisB[0] * axisC[1] - axisB[1] * axisC[0]) < 0;
  const vertices: Vector3[] = [], faces: number[] = [], values: number[] | null = sample ? [] : null;
  const shared = new Map<string, number>(); let crossingCells = 0;
  const index = (p: Vector3) => (p[0] * ny + p[1]) * nz + p[2];
  const offsets = [0, 1, nz, nz + 1, ny * nz, ny * nz + 1, ny * nz + nz, ny * nz + nz + 1];
  let cellOrdinal=0;
  for (let x = 0; x < nx - 1; x++) for (let y = 0; y < ny - 1; y++) for (let z = 0; z < nz - 1; z++) {
    const classified=classification?.[cellOrdinal++];
    // An explicitly restricted method field admits complete cells only. Never
    // inspect sentinel values or turn a validity-mask boundary into a cap.
    if (admission?.cell && !admission.cell([x, y, z])) continue;
    const base = (x * ny + y) * nz + z;
    // The scalar's sign does not define its interior. Density retains native
    // min < iso <= max admission; signed MO phases explicitly choose below
    // when appropriate, without negating/copying the source field.
    let code = classified ?? 0;
    if(classified===undefined)for (let p = 0; p < 8; p++) if (inside === 'below' ? scalar[base + offsets[p]] <= isovalue : scalar[base + offsets[p]] >= isovalue) code |= 1 << p;
    if (code === 0 || code === 255) continue;
    const cell: Vector3 = [x, y, z], corners = Array.from({ length: 8 }, (_, p) => corner(cell, p));
    const edgeBits = topology.edgeTable2[code], intersections: number[] = [];
    const candidates: {edge:number;key:string;position:Vector3;value:number|undefined}[]=[];
    let rejected=false;
    for (let e = 0; e < EDGES.length; e++) {
      if (!(edgeBits & (1 << e))) continue;
      const [ca, cb] = EDGES[e], a = corners[ca], b = corners[cb], ia = index(a), ib = index(b), va = scalar[ia], vb = scalar[ib];
      const fraction = (isovalue - va) / (vb - va);
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error('标量穿越边无法可靠线性求交。');
      const key = fraction === 0 ? `n${ia}` : fraction === 1 ? `n${ib}` : `${Math.min(ia, ib)}:${Math.max(ia, ib)}`;
      const vertex = shared.get(key);
      const local = a.map((v, axis) => v + fraction * (b[axis] - v)) as Vector3;
      const position = vertex===undefined ? grid.origin.map((v, axis) => v + grid.axes.reduce((sum, step, i) => sum + step[axis] * local[i], 0)) as Vector3 : vertices[vertex];
      // Shared positions still sample every later cell's own strict stencil.
      const value = sample?.(position, cell);
      if(value===null&&admission?.invalidSample==='skip-cell'){rejected=true;break;}
      if (sample && !Number.isFinite(value)) throw new Error('表面映射采样没有可靠有限值。');
      candidates.push({edge:e,key,position,value:value??undefined});
    }
    // No orphan vertices, face fragments, or mask-boundary caps: a cell is
    // committed only after every crossing sample is admitted.
    if(rejected)continue;
    crossingCells++;
    for(const candidate of candidates){
      let vertex=shared.get(candidate.key);
      if(vertex===undefined){vertex=vertices.length;shared.set(candidate.key,vertex);vertices.push(candidate.position);if(values)values.push(candidate.value!);}
      intersections[candidate.edge]=vertex;
    }
    const triangles = topology.triTable2[code];
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [intersections[triangles[t]], intersections[triangles[t + 1]], intersections[triangles[t + 2]]];
      if (![a, b, c].every(Number.isInteger)) throw new Error('分子表面三角拓扑与穿越边不一致。');
      // Exact-isovalue grid nodes can collapse multiple intersected edges.
      if (a !== b && b !== c && a !== c) faces.push(a, reverseWinding ? c : b, reverseWinding ? b : c);
    }
  }
  return { vertices, faces, values, crossingCells };
}

/** Both orbital signs inspect the same source values once. The ordinary mesh
 * builder still owns exact intersections, topology, ordering and normals. */
export function createSignedSurfaceMeshes(shape: Pick<SurfaceScalarField,'grid'|'values'>, isovalue:number, topology:SurfaceMeshTopology) {
  if(!Number.isFinite(isovalue)||isovalue<=0)throw new Error('轨道等值必须为正有限值。');
  const [nx,ny,nz]=shape.grid.dimensions,count=(nx-1)*(ny-1)*(nz-1),positive=new Uint8Array(count),negative=new Uint8Array(count);
  const offsets=[0,1,nz,nz+1,ny*nz,ny*nz+1,ny*nz+nz,ny*nz+nz+1];let cell=0;
  for(let x=0;x<nx-1;x++)for(let y=0;y<ny-1;y++)for(let z=0;z<nz-1;z++){
    const base=(x*ny+y)*nz+z;let pcode=0,ncode=0;
    for(let p=0;p<8;p++){const value=shape.values[base+offsets[p]];if(value>=isovalue)pcode|=1<<p;if(value<=-isovalue)ncode|=1<<p;}
    positive[cell]=pcode;negative[cell++]=ncode;
  }
  return [{sign:1,mesh:createSurfaceMesh(shape,isovalue,topology,undefined,'above',undefined,positive)},
    {sign:-1,mesh:createSurfaceMesh(shape,-isovalue,topology,undefined,'below',undefined,negative)}];
}
