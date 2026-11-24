import type { Vector3 } from '../../../core/types';
import {rotate,transformPoint} from './alignment';
import {createScalarGradientNormals} from './field-gradient-normals';
import type {RenderWork} from './render-work';
import {createSignedSurfaceMeshesWork,createSurfaceMeshWork,type BoundaryVertex,type SurfaceMesh,type SurfaceMeshAdmission,type SurfaceMeshSlab,type SurfaceMeshTopology} from './surface-mesh';
import type {MeshPreparation} from './surface-mesh-preparation';
import type {PackedChunk} from './surface-mesh-transfer';

type Sample = (point:Vector3,cell:Vector3)=>number|null;
type DisplaySlab={mesh:SurfaceMesh;world:Float64Array;normals:Float64Array;gradient:Uint8Array;boundary:Map<string,number>};

function* displaySlab(mesh:SurfaceMesh,request:MeshPreparation,sign:number,normalAt:ReturnType<typeof createScalarGradientNormals>,
  next:ReadonlyMap<string,BoundaryVertex>,previous:DisplaySlab|undefined):RenderWork<DisplaySlab|null>{
  const size=mesh.vertices.length,world=new Float64Array(size*3),normals=new Float64Array(size*3),gradient=new Uint8Array(size);
  const boundary=new Map<string,number>(),joins=new Map<number,number>();
  const outward=request.kind==='surface'&&request.inside==='below'||sign<0?1:-1;
  let hasFallback=false;
  for(let i=0;i<size;i++){
    if((i&1023)===0)yield;
    const point=mesh.vertices[i],key=mesh.keys![i],at=i*3;
    world.set(transformPoint(request.pose,[point[0]*request.factor,point[1]*request.factor,point[2]*request.factor]),at);
    const source=normalAt(point,outward),direction=source?rotate(request.pose.rotation,source):null;
    const length=direction?Math.hypot(...direction):0;
    const valid=Number.isFinite(length)&&length>0;
    const prior=previous?.boundary.get(key);
    if(valid){
      gradient[i]=1;normals[at]=direction![0]/length;normals[at+1]=direction![1]/length;normals[at+2]=direction![2]/length;
    }else{
      hasFallback=true;
      if(next.has(key))boundary.set(key,i);
      if(prior!==undefined){
        joins.set(i,prior);
        const before=prior*3,old=previous!.normals;
        normals[at]=old[before];normals[at+1]=old[before+1];normals[at+2]=old[before+2];
      }
    }
    if(prior!==undefined&&valid)return null;
  }
  if(hasFallback)for(let i=0;i<mesh.faces.length;i+=3){
    if(i%3072===0)yield;
    const a=mesh.faces[i]*3,b=mesh.faces[i+1]*3,c=mesh.faces[i+2]*3;
    const ux=world[b]-world[a],uy=world[b+1]-world[a+1],uz=world[b+2]-world[a+2];
    const vx=world[c]-world[a],vy=world[c+1]-world[a+1],vz=world[c+2]-world[a+2];
    const x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx;
    if(!gradient[mesh.faces[i]]){normals[a]+=x;normals[a+1]+=y;normals[a+2]+=z;}
    if(!gradient[mesh.faces[i+1]]){normals[b]+=x;normals[b+1]+=y;normals[b+2]+=z;}
    if(!gradient[mesh.faces[i+2]]){normals[c]+=x;normals[c+1]+=y;normals[c+2]+=z;}
  }
  for(const [i,j] of joins){
    const from=i*3,to=j*3,old=previous!.normals;
    old[to]=normals[from];old[to+1]=normals[from+1];old[to+2]=normals[from+2];
  }
  return{mesh,world,normals,gradient,boundary};
}

function meshChunkWriter(sign:number,request:MeshPreparation) {
  const chunks:PackedChunk[]=[], indices=new Map<string,number>();
  let vertices=new Float64Array(96),normals=new Float64Array(96), faces=new Uint16Array(192),faceCount=0;
  let samples=request.kind==='surface'&&request.mapping?new Float64Array(32):undefined;
  let sourcePositions=samples&&request.kind==='surface'&&request.positions?new Float64Array(96):undefined;
  function flush() {
    const count=indices.size;
    if(count)chunks.push({sign,vertices:vertices.slice(0,count*3),normals:normals.slice(0,count*3),faces:faces.slice(0,faceCount),
      ...(samples?{samples:samples.slice(0,count)}:{}),...(sourcePositions?{sourcePositions:sourcePositions.slice(0,count*3)}:{})});
    indices.clear();faceCount=0;
  }
  function grow(values:Float64Array,n:number) {
    const target=new Float64Array(n);target.set(values);return target;
  }
  return {
    *append({mesh,world,normals:sourceNormals,gradient}:DisplaySlab):RenderWork<void>{
      for(let face=0;face<mesh.faces.length;face+=3){
        if(face%3072===0)yield;
        if(indices.size>=63000)flush();
        if(faceCount+3>faces.length){const next=new Uint16Array(faces.length*2);next.set(faces);faces=next;}
        for(let corner=0;corner<3;corner++){
          const ordinal=mesh.faces[face+corner],key=mesh.keys![ordinal];
          let index=indices.get(key);
          if(index===undefined){
            const point=mesh.vertices[ordinal];
            index=indices.size;indices.set(key,index);
            if(index*3===vertices.length){
              vertices=grow(vertices,Math.min(63003*3,vertices.length*2));normals=grow(normals,vertices.length);
              if(samples)samples=grow(samples,vertices.length/3);
              if(sourcePositions)sourcePositions=grow(sourcePositions,vertices.length);
            }
            const offset=index*3,source=ordinal*3;
            vertices[offset]=world[source];vertices[offset+1]=world[source+1];vertices[offset+2]=world[source+2];
            const x=sourceNormals[source],y=sourceNormals[source+1],z=sourceNormals[source+2];
            const length=gradient[ordinal]?1:Math.hypot(x,y,z);
            normals[offset]=length?x/length:x;normals[offset+1]=length?y/length:y;normals[offset+2]=length?z/length:z;
            if(samples)samples[index]=mesh.values![ordinal];
            if(sourcePositions){sourcePositions[offset]=point[0]*request.factor;sourcePositions[offset+1]=point[1]*request.factor;sourcePositions[offset+2]=point[2]*request.factor;}
          }
          faces[faceCount++]=index;
        }
      }
    },
    finish(){flush();return chunks;},
  };
}

/** Each x slab owns all its cells in global traversal order. The authoritative
 * field is borrowed without a numeric copy. Crossing nodes read both leaf
 * planes; scalar gradient stencils use one extra node on either side, and the
 * mapping sampler independently consults its own complete physical stencil.
 * Frontier values retain the earliest valid global owner's exact colour sample.
 * Indeterminate gradients use the original world-space face-area sums. Hold
 * the prior slab until its shared frontier vertices receive the next slab's
 * contributions in global order, then emit with the completed seam normals. */
export function* packSurfaceSlabs(request:MeshPreparation,topology:SurfaceMeshTopology,sample?:Sample,admission?:SurfaceMeshAdmission):RenderWork<PackedChunk[]|null>{
  const {shape,isovalue}=request,[nx,ny,nz]=shape.grid.dimensions;
  const signs=request.kind==='surface'?[1]:request.phase==='negative'?[-1]:request.phase==='positive'?[1]:[1,-1];
  const writers=signs.map(sign=>({sign,write:meshChunkWriter(sign,request),prior:new Map<string,BoundaryVertex>(),previous:undefined as DisplaySlab|undefined}));
  const slabDepth=Math.max(1,Math.floor(65536/Math.max(1,(ny-1)*(nz-1))));
  for(let first=0;first<nx-1;first+=slabDepth){
    const end=Math.min(first+slabDepth,nx-1),slabs=writers.map(phase=>({first,end,prior:phase.prior,next:new Map<string,BoundaryVertex>()}));
    const meshFor=(sign:number,slab:SurfaceMeshSlab)=>createSurfaceMeshWork(shape,sign*isovalue,topology,sample,
      request.kind==='surface'?request.inside:sign>0?'above':'below',admission,undefined,slab);
    const meshes=writers.length===2 ? yield* createSignedSurfaceMeshesWork(shape,isovalue,topology,[slabs[0],slabs[1]])
      :[{sign:writers[0].sign,mesh:yield* meshFor(writers[0].sign,slabs[0])}];
    const normalAt=createScalarGradientNormals(shape);
    for(let i=0;i<writers.length;i++){
      const writer=writers[i],slab=yield* displaySlab(meshes[i].mesh,request,writer.sign,normalAt,slabs[i].next,writer.previous);
      if(!slab)return null;
      if(writer.previous)yield* writer.write.append(writer.previous);
      writer.prior=slabs[i].next;writer.previous=slab;
    }
    yield;
  }
  for(const writer of writers)if(writer.previous)yield* writer.write.append(writer.previous);
  return writers.flatMap(row=>row.write.finish());
}
