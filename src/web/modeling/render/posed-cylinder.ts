import type { Vector3 } from '../../../core/types';
import { add, coordinates, scale, subtract } from './geometry';

type Matrix = [Vector3,Vector3,Vector3];
type Pose = { start:Vector3; end:Vector3; length:number; basis:Matrix };
type Rod = {start:{x:number;y:number;z:number};end:{x:number;y:number;z:number};fromCap:number;toCap:number;radius:number;color?:unknown;opacity?:number;clickable?:boolean;hoverable?:boolean};
type State = {base:Pose;target:Pose;radius:number;root:any;globj:(...args:any[])=>void};
const poses=new WeakMap<object,State>();

// GLDraw uses this axial basis even for circular cross sections. Keep its
// facet orientation as well as the envelope and material through motion.
function cylinderPose(spec:Rod):Pose|undefined{
  if(!spec.start||!spec.end)return undefined;
  const start=coordinates(spec.start),end=coordinates(spec.end),[x,y,z]=subtract(end,start);
  const xy=Math.hypot(x,y),length=Math.hypot(x,y,z);
  if(![...start,...end,length].every(value=>Number.isFinite(Math.fround(value)))||length<.0001)return undefined;
  if(xy<.0001&&x!==0)return undefined; // Native's near-axis fallback may be oblique.
  const sa=xy<.0001?0:-x/xy,ca=xy<.0001?1:y/xy;
  const aligned=-sa*x+ca*y,yz=Math.hypot(aligned,z);
  if(yz<.0001)return undefined;
  const sb=z/yz,cb=aligned/yz;
  return{start,end,length,basis:[[ca,sa,0],[-sa*cb,ca*cb,sb],[sa*sb,-ca*sb,cb]]};
}

function place(state:State,handle:any){
  const {base,target,root}=state;
  const axial=target.length/base.length;
  const row=(i:number):Vector3=>[0,1,2].map(j=>target.basis[0][i]*base.basis[0][j]+axial*target.basis[1][i]*base.basis[1][j]+target.basis[2][i]*base.basis[2][j]) as Vector3;
  const rows=[row(0),row(1),row(2)];
  const translation=target.start.map((value,axis)=>value-rows[axis].reduce((sum,factor,index)=>sum+factor*base.start[index],0));
  if(![...rows.flat(),...translation].every(value=>Number.isFinite(Math.fround(value))))return false;
  root.matrixAutoUpdate=false;
  root.matrix.set(...rows[0],translation[0],...rows[1],translation[1],...rows[2],translation[2],0,0,0,1);
  root.matrixWorldNeedsUpdate=true;
  handle.boundingSphere.center.set(...scale(add(target.start,target.end),.5));
  handle.boundingSphere.radius=Math.hypot(target.length/2,state.radius);
  return true;
}

/** Reuse an opaque, unclipped native flat cylinder. Pick proxies are computed
 * independently from the current endpoints by the adapter. */
export function poseNativeFlatCylinder(handle:any,previous:Rod,next:Rod):boolean{
  if(!handle?.renderedShapeObj?.matrix?.set||!handle.boundingSphere?.center?.set||typeof handle.globj!=='function'||handle.hidden||
    previous.fromCap!==1||previous.toCap!==1||previous.clickable||previous.hoverable||!(previous.radius>0)||previous.opacity!==1)return false;
  const keys=Object.keys(previous) as (keyof Rod)[];
  if(keys.length!==Object.keys(next).length||keys.some(key=>key!=='start'&&key!=='end'&&!Object.is(previous[key],next[key])))return false;
  const target=cylinderPose(next);
  if(!target)return false;
  let state=poses.get(handle);
  if(state){
    if(state.root!==handle.renderedShapeObj)return false;
    const before=state.target;state.target=target;
    if(place(state,handle))return true;
    state.target=before;return false;
  }
  const base=cylinderPose(previous);
  if(!base)return false;
  state={base,target,radius:previous.radius,root:handle.renderedShapeObj,globj:handle.globj};
  if(!place(state,handle))return false;
  const owner=state;
  poses.set(handle,owner);
  handle.globj=function(this:any,group:any,options?:{regen?:boolean}){
    if(this.renderedShapeObj!==owner.root||this.hidden||options?.regen){
      owner.globj.call(this,group,options);
      owner.root=this.renderedShapeObj;
      if(owner.root)place(owner,this);
      return;
    }
    if(owner.root.parent!==group&&!(group.children??[]).includes(owner.root))group.add(owner.root);
  };
  return true;
}
