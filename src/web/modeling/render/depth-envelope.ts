import type {Vector3} from '../../../core/types';
import {rotateVector} from './geometry';
export interface RenderBounds {min:Vector3;max:Vector3}
export function includeRenderPoint(bounds:RenderBounds|null,point:Vector3,radius=0):RenderBounds|null{
  if(![...point,radius].every(Number.isFinite)||radius<0)return bounds;
  if(!bounds)return{min:point.map(v=>v-radius) as Vector3,max:point.map(v=>v+radius) as Vector3};
  for(let axis=0;axis<3;axis++){bounds.min[axis]=Math.min(bounds.min[axis],point[axis]-radius);bounds.max[axis]=Math.max(bounds.max[axis],point[axis]+radius);}return bounds;
}
export function unionRenderBounds(...items:(RenderBounds|null|undefined)[]):RenderBounds|null{
  let result:RenderBounds|null=null;for(const item of items)if(item){result=includeRenderPoint(result,item.min);result=includeRenderPoint(result,item.max);}return result;
}
/** Slab coordinates are relative to the locked camera's rotation-group center.
 * Only depth changes: the public eight-value view and model are untouched. */
export function renderDepthSlab(bounds:RenderBounds|null,view:readonly number[]):{near:number;far:number}|null{
  if(!bounds||view.length<8||!view.every(Number.isFinite))return null;
  const norm=Math.hypot(...view.slice(4,8));if(norm<1e-12)return null;
  const q=view.slice(4,8).map(v=>v/norm);let near=Infinity,far=-Infinity;
  for(let corner=0;corner<8;corner++){const p=[0,1,2].map(axis=>(corner&(1<<axis)?bounds.max[axis]:bounds.min[axis])+view[axis]) as Vector3,depth=-rotateVector(p,q)[2];near=Math.min(near,depth);far=Math.max(far,depth);}
  const margin=Math.max(.25,(far-near)*.025);return{near:near-margin,far:far+margin};
}
/** GLViewer.show is the locked shared presentation seam for rotate, zoom,
 * resize, draw and export. Update its slab after native pose changes and before
 * its one real depth pass; do not issue another render or change camera zoom. */
export function retainViewerDepthEnvelope(viewer:any,read:()=>RenderBounds|null){
  const original=viewer.show,descriptor=Object.getOwnPropertyDescriptor(viewer,'show');
  if(typeof original!=='function'||typeof viewer.setSlab!=='function')return{dispose(){}};
  const show=function(this:any,...args:any[]){if(this===viewer){const slab=renderDepthSlab(read(),viewer.getView());if(slab)viewer.setSlab(slab.near,slab.far);}return original.apply(this,args);};
  viewer.show=show;let disposed=false;
  return{dispose(){if(disposed)return;disposed=true;if(viewer.show===show){if(descriptor)Object.defineProperty(viewer,'show',descriptor);else delete viewer.show;}}};
}
