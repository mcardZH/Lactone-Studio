import type {PeriodicCell,Vector3} from '../../../core/types';
import {add,cross,dot,scale,subtract} from './geometry';

export interface RenderPlane {normal:Vector3;offset:number}
export interface CylinderMesh {vertices:Vector3[];normals:Vector3[];faces:number[];capPlanes:RenderPlane[]}
interface Vertex {p:Vector3;n:Vector3}
const unit=(v:Vector3):Vector3=>scale(v,1/Math.hypot(...v));
const basis=(normal:Vector3):[Vector3,Vector3]=>{const u=unit(cross(normal,Math.abs(normal[2])<.8?[0,0,1]:[0,1,0]));return[u,cross(normal,u)];};
/** Cartesian half-spaces of only the declared clipping axes, including skew
 * reciprocal normals. Complete atoms and untouched faces are never clipped. */
export function cellRenderPlanes(cell:PeriodicCell):RenderPlane[]{
  const [a,b,c]=cell.vectors,volume=dot(a,cross(b,c)),origin=cell.origin??[0,0,0];
  if(!Number.isFinite(volume)||Math.abs(volume)<1e-12)throw new Error('晶胞截端需要有限非退化晶胞。');
  const reciprocal=[scale(cross(b,c),1/volume),scale(cross(c,a),1/volume),scale(cross(a,b),1/volume)],planes:RenderPlane[]=[];
  for(let axis=0;axis<3;axis++)if(cell.pbc[axis]){const length=Math.hypot(...reciprocal[axis]),normal=scale(reciprocal[axis],1/length),base=dot(normal,origin);
    planes.push({normal:scale(normal,-1),offset:-base},{normal,offset:base+1/length});}
  return planes;
}
export function needsObliqueCellCap(start:Vector3,end:Vector3,sourceStart:Vector3,sourceEnd:Vector3,planes:readonly RenderPlane[]):boolean{
  const axis=unit(subtract(end,start)),cutStart=Math.hypot(...subtract(start,sourceStart))>1e-8,cutEnd=Math.hypot(...subtract(end,sourceEnd))>1e-8;
  return planes.some(plane=>Math.abs(dot(plane.normal,axis))<1-1e-8&&(cutStart&&Math.abs(dot(plane.normal,start)-plane.offset)<1e-7||cutEnd&&Math.abs(dot(plane.normal,end)-plane.offset)<1e-7));
}
function clipFaces(input:Vertex[][],plane:RenderPlane):{faces:Vertex[][];capped:boolean}{
  const output:Vertex[][]=[],cuts:Vector3[]=[],epsilon=1e-9;
  for(const face of input){const result:Vertex[]=[];
    for(let i=0;i<face.length;i++){const current=face[i],next=face[(i+1)%face.length],a=dot(plane.normal,current.p)-plane.offset,b=dot(plane.normal,next.p)-plane.offset;
      if(a<=epsilon)result.push(current);
      if(a< -epsilon&&b>epsilon||a>epsilon&&b< -epsilon){const fraction=a/(a-b),p=add(current.p,scale(subtract(next.p,current.p),fraction)),mixed=add(current.n,scale(subtract(next.n,current.n),fraction)),n=unit(mixed);
        result.push({p,n});if(!cuts.some(point=>Math.hypot(...subtract(point,p))<epsilon))cuts.push(p);}
      else if(Math.abs(a)<=epsilon&&b>epsilon&&!cuts.some(point=>Math.hypot(...subtract(point,current.p))<epsilon))cuts.push(current.p);
    }
    if(result.length>=3)output.push(result);
  }
  if(cuts.length<3)return{faces:output,capped:false};
  const center=scale(cuts.reduce((sum,p)=>add(sum,p),[0,0,0] as Vector3),1/cuts.length),[u,v]=basis(plane.normal);
  cuts.sort((a,b)=>Math.atan2(dot(subtract(a,center),v),dot(subtract(a,center),u))-Math.atan2(dot(subtract(b,center),v),dot(subtract(b,center),u)));
  output.push(cuts.map(p=>({p,n:plane.normal})));return{faces:output,capped:true};
}
/** A closed convex cylinder clipped in Cartesian space. Caps lie on the real
 * cell planes, including multi-axis corners; they are not perpendicular disks
 * added to an already shortened centerline. No atom or graph data are used. */
export function clippedCellCylinder(start:Vector3,end:Vector3,radius:number,planes:readonly RenderPlane[],sides=24):CylinderMesh{
  const delta=subtract(end,start),length=Math.hypot(...delta);
  if(![...start,...end,radius].every(Number.isFinite)||length<1e-10||radius<=0||!Number.isSafeInteger(sides)||sides<8||sides>128)throw new Error('晶胞截端圆柱几何无效。');
  const axis=scale(delta,1/length),[u,v]=basis(axis),radials=Array.from({length:sides},(_,i)=>add(scale(u,Math.cos(2*Math.PI*i/sides)),scale(v,Math.sin(2*Math.PI*i/sides))));
  const ring=(center:Vector3,normal?:Vector3)=>radials.map(n=>({p:add(center,scale(n,radius)),n:normal??n})),first=ring(start),last=ring(end);
  let polygons:Vertex[][]=radials.map((_,i)=>[first[i],first[(i+1)%sides],last[(i+1)%sides],last[i]]);
  polygons.push(ring(start,scale(axis,-1)).reverse(),ring(end,axis));const capPlanes:RenderPlane[]=[];
  for(const plane of planes){const clipped=clipFaces(polygons,plane);polygons=clipped.faces;if(clipped.capped)capPlanes.push(plane);if(!polygons.length)break;}
  const vertices:Vector3[]=[],normals:Vector3[]=[],faces:number[]=[];
  for(const polygon of polygons)for(let i=1;i+1<polygon.length;i++){
    const triangle=[polygon[0],polygon[i],polygon[i+1]];
    if(Math.hypot(...cross(subtract(triangle[1].p,triangle[0].p),subtract(triangle[2].p,triangle[0].p)))<1e-14)continue;
    const index=vertices.length;for(const vertex of triangle){vertices.push(vertex.p);normals.push(vertex.n);}faces.push(index,index+1,index+2);
  }
  return{vertices,normals,faces,capPlanes};
}
