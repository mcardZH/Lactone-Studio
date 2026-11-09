import type {Vector3} from '../../../core/types';
import {validateSamplingSphereDisplay,type SamplingSphereDisplay} from '../../../modeling/view-multiframe';
import {transformPoint,type RigidTransform} from './alignment';
import {point} from './geometry';
import {includeRenderPoint,type RenderBounds} from './depth-envelope';
import {createShapeLayer} from './shape-layer';
import {SAMPLING_SPHERE_APPEARANCE} from './sampling-sphere-preview';

/** One owned native sphere. A prepared wire mesh keeps its material and buffers;
 * radius/centre edits use the existing Object3D transform, not atom/model edits.
 * The narrow wrapper concerns this handle only, never global shape arrays. */
export function createSamplingSphereLayer(viewer:any){
  const owned=createShapeLayer(viewer);
  let handle:any=null,owner:string|null=null,base:SamplingSphereDisplay|null=null,current:SamplingSphereDisplay|null=null;
  let originalGlobj:((...args:any[])=>unknown)|undefined,globjDescriptor:PropertyDescriptor|undefined,wrappedGlobj:any;
  let builds=0,compilations=0,updates=0,fallbacks=0,bounds:RenderBounds|null=null;
  const rootReady=(root:any)=>root&&typeof root.position?.set==='function'&&typeof root.scale?.set==='function'&&typeof root.updateMatrix==='function';
  const transformRoot=(root:any)=>{
    if(!base||!current||!rootReady(root))return false;
    const ratio=current.radiusAngstrom/base.radiusAngstrom;
    const offset=current.centerAngstrom.map((value,axis)=>value-base!.centerAngstrom[axis]*ratio) as Vector3;
    if(!Number.isFinite(ratio)||!offset.every(Number.isFinite))return false;
    root.position.set(...offset);root.scale.set(ratio,ratio,ratio);root.updateMatrix();return true;
  };
  const clear=()=>{
    if(handle&&wrappedGlobj&&handle.globj===wrappedGlobj){if(globjDescriptor)Object.defineProperty(handle,'globj',globjDescriptor);else delete handle.globj;}
    owned.clear();handle=null;base=null;current=null;owner=null;originalGlobj=undefined;wrappedGlobj=undefined;bounds=null;
  };
  const create=(sphere:SamplingSphereDisplay,key:string)=>{
    base={centerAngstrom:[...sphere.centerAngstrom],radiusAngstrom:sphere.radiusAngstrom};current={centerAngstrom:[...sphere.centerAngstrom],radiusAngstrom:sphere.radiusAngstrom};owner=key;
    handle=owned.keep(viewer.addSphere({center:point(sphere.centerAngstrom),radius:sphere.radiusAngstrom,...SAMPLING_SPHERE_APPEARANCE}));builds++;
    if(!handle||typeof handle.globj!=='function')return;
    globjDescriptor=Object.getOwnPropertyDescriptor(handle,'globj');originalGlobj=handle.globj;
    wrappedGlobj=function(this:any,group:any,...args:any[]){
      if(this!==handle)return originalGlobj!.call(this,group,...args);
      let root=this.renderedShapeObj;
      if(!rootReady(root)){
        originalGlobj!.call(this,group,...args);compilations++;root=this.renderedShapeObj;
      }else if(root.parent!==group&&!group.children?.includes(root))group.add(root);
      transformRoot(root);
    };
    handle.globj=wrappedGlobj;
  };
  return {
    sync(sphere:SamplingSphereDisplay|undefined,transform:RigidTransform,key:string):boolean{
      if(!sphere){const changed=!!handle;clear();return changed;}
      validateSamplingSphereDisplay(sphere);
      const next={centerAngstrom:transformPoint(transform,sphere.centerAngstrom),radiusAngstrom:sphere.radiusAngstrom};
      if(owner===key&&current&&next.radiusAngstrom===current.radiusAngstrom&&next.centerAngstrom.every((value,axis)=>value===current!.centerAngstrom[axis]))return false;
      if(owner!==key)clear();
      if(handle&&base){
        const ratio=next.radiusAngstrom/base.radiusAngstrom,offset=next.centerAngstrom.map((value,axis)=>value-base!.centerAngstrom[axis]*ratio);
        if(!rootReady(handle.renderedShapeObj)||!Number.isFinite(ratio)||!offset.every(Number.isFinite)){fallbacks++;clear();}
      }
      if(!handle)create(next,key);else{current=next;transformRoot(handle.renderedShapeObj);updates++;}
      bounds=includeRenderPoint(null,next.centerAngstrom,next.radiusAngstrom);
      // Consumers of owned-shape bounds (depth and diagnostic fit) need the
      // physical sphere, not the immutable original mesh's local bounds.
      if(handle?.boundingSphere?.center?.set){handle.boundingSphere.center.set(...next.centerAngstrom);handle.boundingSphere.radius=next.radiusAngstrom;}
      return true;
    },
    /** Compile only this new handle; setView subsequently presents the scene. */
    prepare():boolean{
      const group=viewer.modelGroup;if(!handle)return true;
      if(!group||typeof group.add!=='function'||typeof handle.globj!=='function')return false;
      handle.globj(group);return rootReady(handle.renderedShapeObj);
    },
    clear,bounds:()=>bounds,
    diagnostics:()=>({sphereGeometryBuilds:builds,sphereNativeCompilations:compilations,sphereTransformUpdates:updates,sphereFallbacks:fallbacks,sphereOwnedHandles:handle?1:0}),
  };
}
