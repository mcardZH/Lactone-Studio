import type { PeriodicCell, Structure, Vector3 } from '../../../core/types';
import { fractionalToCartesian } from '../../../core/periodic';
import { add, cross, scale } from './geometry';

/** Display geometry supplied by the transform owner, in physical Cartesian Å.
 * A fractional crop is resolved only against its explicit reference cell. */
export interface TransformPreviewGuides {
  /** Display-only source snapshot in the same physical frame as the result. */
  referenceStructure?: Structure;
  dimAtomIds?: readonly string[];
  planes?: readonly { center: Vector3; normal: Vector3; size?: number }[];
  vectors?: readonly { origin: Vector3; vector: Vector3 }[];
  points?: readonly { position: Vector3 }[];
  box?: { min: Vector3; max: Vector3; space: 'cartesian' | 'fractional' };
}
export type TransformGuidePrimitive = { kind: 'point'; position: Vector3 } | { kind: 'line' | 'vector'; start: Vector3; end: Vector3 };
const finite=(value:readonly number[])=>value.length===3&&value.every(Number.isFinite);
export function transformGuidePrimitives(guides?:TransformPreviewGuides,cell?:PeriodicCell):TransformGuidePrimitive[]{
  const result:TransformGuidePrimitive[]=[];
  for(const {position} of guides?.points??[])if(finite(position))result.push({kind:'point',position});
  for(const {origin,vector} of guides?.vectors??[])if(finite(origin)&&finite(vector)&&Math.hypot(...vector)>1e-12)result.push({kind:'vector',start:origin,end:add(origin,vector)});
  for(const {center,normal,size=6} of guides?.planes??[]){
    const length=Math.hypot(...normal);if(!finite(center)||!finite(normal)||length<1e-12||!Number.isFinite(size)||size<=0)continue;
    const n=scale(normal,1/length),seed:Vector3=Math.abs(n[0])<.8?[1,0,0]:[0,1,0];
    const first=cross(n,seed),u=scale(first,size/2/Math.hypot(...first)),v=scale(cross(n,u),1);
    const corners=[[1,1],[-1,1],[-1,-1],[1,-1]].map(([a,b])=>add(center,add(scale(u,a),scale(v,b))));
    for(let i=0;i<4;i++)result.push({kind:'line',start:corners[i],end:corners[(i+1)%4]});
    // A planar grid keeps the cut's position and normal visible without an
    // opaque face or diagonals that can be mistaken for molecular bonds.
    for(let i=1;i<6;i++){
      const t=-1+i/3;
      result.push({kind:'line',start:add(center,add(scale(u,t),scale(v,-1))),end:add(center,add(scale(u,t),v))},
        {kind:'line',start:add(center,add(scale(v,t),scale(u,-1))),end:add(center,add(scale(v,t),u))});
    }
  }
  const box=guides?.box;
  if(box&&finite(box.min)&&finite(box.max)&&box.min.every((value,index)=>value<=box.max[index])&&(box.space==='cartesian'||cell)){
    const corners=Array.from({length:8},(_,i)=>[0,1,2].map(axis=>i&(1<<axis)?box.max[axis]:box.min[axis]) as Vector3);
    const points=box.space==='fractional'?corners.map(value=>fractionalToCartesian(cell!,value)):corners;
    for(let i=0;i<8;i++)for(let axis=0;axis<3;axis++)if(!(i&(1<<axis)))result.push({kind:'line',start:points[i],end:points[i|(1<<axis)]});
  }
  return result;
}
