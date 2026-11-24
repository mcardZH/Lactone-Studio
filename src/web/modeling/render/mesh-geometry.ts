import type { Vector3 } from '../../../core/types';
import { rotate, transformPoint, type RigidTransform } from './alignment';
import { point } from './geometry';
import type { SurfaceMesh } from './surface-mesh';
import type { PackedChunk } from './surface-mesh-transfer';
import type { RenderWork } from './render-work';

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

/** Same full mesh, transform and accumulation order as meshGeometryChunks.
 * All inter-stage data are typed. Reboxing for the locked public GLShape API
 * is deferred to the individual chunk that is being attached. */
export function* packedMeshGeometry(mesh:SurfaceMesh,pose:RigidTransform,factor:number,sign:number,positions:boolean,
  normalAt?:(point:Vector3)=>Vector3|null):RenderWork<PackedChunk[]> {
  if(!mesh.faces.length)return [];
  const world=new Float64Array(mesh.vertices.length*3), normals=new Float64Array(world.length);
  for(let i=0;i<mesh.vertices.length;i++){
    if((i&1023)===0)yield;
    const v=mesh.vertices[i];world.set(transformPoint(pose,[v[0]*factor,v[1]*factor,v[2]*factor]),i*3);
  }
  for(let i=0;i<mesh.faces.length;i+=3){
    if((i&3071)===0)yield;
    const a=mesh.faces[i]*3,b=mesh.faces[i+1]*3,c=mesh.faces[i+2]*3;
    const ux=world[b]-world[a],uy=world[b+1]-world[a+1],uz=world[b+2]-world[a+2];
    const vx=world[c]-world[a],vy=world[c+1]-world[a+1],vz=world[c+2]-world[a+2];
    const x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx;
    normals[a]+=x;normals[a+1]+=y;normals[a+2]+=z;
    normals[b]+=x;normals[b+1]+=y;normals[b+2]+=z;
    normals[c]+=x;normals[c+1]+=y;normals[c+2]+=z;
  }
  for(let i=0;i<mesh.vertices.length;i++){
    if((i&1023)===0)yield;
    const at=i*3, length=Math.hypot(normals[at],normals[at+1],normals[at+2]);
    if(length){normals[at]/=length;normals[at+1]/=length;normals[at+2]/=length;}
    const source=normalAt?.(mesh.vertices[i]);
    if(!source)continue;
    const n=rotate(pose.rotation,source), scale=Math.hypot(...n);
    if(n.every(Number.isFinite)&&scale>0){normals[at]=n[0]/scale;normals[at+1]=n[1]/scale;normals[at+2]=n[2]/scale;}
  }

  const capacity=Math.min(63003,mesh.vertices.length),vertexBuffer=new Float64Array(capacity*3),normalBuffer=new Float64Array(capacity*3);
  const samples=mesh.values?new Float64Array(capacity):undefined;
  const sourcePositions=mesh.values&&positions?new Float64Array(capacity*3):undefined;
  let faceBuffer=new Uint16Array(Math.min(mesh.faces.length,capacity*6)), faces=0;
  const chunks:PackedChunk[]=[],mapping=new Map<number,number>();
  function flush() {
    const length=mapping.size;
    if(!length)return;
    chunks.push({sign,vertices:vertexBuffer.slice(0,length*3),normals:normalBuffer.slice(0,length*3),faces:faceBuffer.slice(0,faces),
      ...(samples?{samples:samples.slice(0,length)}:{}),...(sourcePositions?{sourcePositions:sourcePositions.slice(0,length*3)}:{})});
    faces=0;mapping.clear();
  }
  for(let i=0;i<mesh.faces.length;i+=3){
    if((i&3071)===0)yield;
    if(mapping.size>=63000)flush();
    if(faces+3>faceBuffer.length){const grown=new Uint16Array(faceBuffer.length*2);grown.set(faceBuffer);faceBuffer=grown;}
    for(let corner=0;corner<3;corner++){
      const index=mesh.faces[i+corner];let local=mapping.get(index);
      if(local===undefined){
        local=mapping.size;mapping.set(index,local);
        const from=index*3,to=local*3;
        vertexBuffer[to]=world[from];vertexBuffer[to+1]=world[from+1];vertexBuffer[to+2]=world[from+2];
        normalBuffer[to]=normals[from];normalBuffer[to+1]=normals[from+1];normalBuffer[to+2]=normals[from+2];
        if(samples)samples[local]=mesh.values![index];
        if(sourcePositions){
          const v=mesh.vertices[index];sourcePositions[to]=v[0]*factor;sourcePositions[to+1]=v[1]*factor;sourcePositions[to+2]=v[2]*factor;
        }
      }
      faceBuffer[faces++]=local;
    }
  }
  flush();return chunks;
}
