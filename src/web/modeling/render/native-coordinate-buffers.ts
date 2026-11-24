import type { Vector3 } from '../../../core/types';
import type { retainNativeCoordinateUpload } from './native-coordinate-upload';

type CoordinateSource = [first: number, second: number];
type Coordinates = { x:number; y:number; z:number; set?(x:number,y:number,z:number):void };
type BufferBinding = { values:Float32Array; sources:Int32Array };
type PickCylinder = { c1:Coordinates; c2:Coordinates; direction:Coordinates };

const key=(x:number,y:number,z:number)=>`${Math.fround(x)}|${Math.fround(y)}|${Math.fround(z)}`;

/** Refresh the locked Cylinder direction with the same Vector3 arithmetic. */
export function updateNativePickCylinder(cylinder:PickCylinder) {
  const {c1,c2,direction}=cylinder;
  const x=c2.x-c1.x,y=c2.y-c1.y,z=c2.z-c1.z,length=Math.sqrt(x*x+y*y+z*z);
  if(length===0){direction.x=0;direction.y=0;direction.z=0;}
  else {direction.x=x/length;direction.y=y/length;direction.z=z/length;}
}

/** Reuse only attested center/endpoint buffers from the locked 3Dmol imposter
 * path. Native mesh/material creation remains the single appearance authority. */
export function bindNativeCoordinateBuffers(model:any, uploads?: ReturnType<typeof retainNativeCoordinateUpload>){
  const root=model?.renderedMolObj,atoms=model?.atoms;
  if(!model?.molObj||!root?.children?.length||!Array.isArray(atoms)||!atoms.length)return undefined;
  const indexed=new Map<string,CoordinateSource|null>();
  const remember=(point:string,source:CoordinateSource)=>{indexed.set(point,indexed.has(point)?null:source);};
  for(const [index,atom] of atoms.entries()){
    if(atom.index!==index||![atom.x,atom.y,atom.z].every((value:number)=>Number.isFinite(Math.fround(value)))||atom.bondOrder?.some((order:number)=>order!==1))return undefined;
    remember(key(atom.x,atom.y,atom.z),[index,index]);
  }
  for(const [index,atom] of atoms.entries())for(const other of atom.bonds??[]){
    if(other<=index)continue;
    const target=atoms[other];if(!target)return undefined;
    remember(key((atom.x+target.x)/2,(atom.y+target.y)/2,(atom.z+target.z)/2),[index,other]);
  }
  const bindings:BufferBinding[]=[],geometries=new Map<any,boolean>();
  function bind(values:Float32Array,vertexCount:number){
    if(Object.prototype.toString.call(values)!=='[object Float32Array]'||!Number.isSafeInteger(vertexCount)||vertexCount%4!==0||values.length<vertexCount*3)return false;
    const sources=new Int32Array(vertexCount/2);
    for(let offset=0,sourceOffset=0;offset<vertexCount*3;offset+=12,sourceOffset+=2){
      const x=values[offset],y=values[offset+1],z=values[offset+2];
      const source=indexed.get(key(x,y,z));
      if(!source)return false;
      for(let vertex=1;vertex<4;vertex++)if(values[offset+3*vertex]!==x||values[offset+3*vertex+1]!==y||values[offset+3*vertex+2]!==z)return false;
      sources[sourceOffset]=source[0];sources[sourceOffset+1]=source[1];
    }
    bindings.push({values,sources});
    return true;
  }
  for(const mesh of root.children){
    const geometry=mesh.geometry,shader=mesh.material?.shaderID;
    if(mesh.children?.length||!geometry?.imposter||!['sphereimposter','stickimposter'].includes(shader)||!Array.isArray(geometry.geometryGroups))return undefined;
    if(geometries.has(geometry))continue;
    for(const group of geometry.geometryGroups){
      if(!bind(group.vertexArray,group.vertices)||shader==='stickimposter'&&!bind(group.normalArray,group.vertices))return undefined;
    }
    geometries.set(geometry,shader==='stickimposter');
  }
  const picks=new Map<Coordinates,CoordinateSource>(),cylinders=new Set<PickCylinder>();
  const bindPoint=(center:Coordinates)=>{
    const source=indexed.get(key(center.x,center.y,center.z));
    if(source)picks.set(center,source);
    return !!source;
  };
  for(const atom of atoms){
    const hit=atom.intersectionShape;
    if(hit?.line?.length||hit?.triangle?.length)return undefined;
    for(const sphere of hit?.sphere??[])if(!bindPoint(sphere.center))return undefined;
    for(const cylinder of hit?.cylinder??[]){
      if(!bindPoint(cylinder.c1)||!bindPoint(cylinder.c2)||typeof cylinder.direction?.subVectors!=='function')return undefined;
      cylinders.add(cylinder);
    }
  }
  const pickTargets=[...picks.keys()],pickSources=new Int32Array(pickTargets.length*2);
  let pickIndex=0;
  for(const source of picks.values()){pickSources[pickIndex++]=source[0];pickSources[pickIndex++]=source[1];}
  const pickCylinders=[...cylinders];
  return (coordinates:readonly Vector3[])=>{
    if(!model.molObj||model.renderedMolObj!==root||model.atoms!==atoms||coordinates.length!==atoms.length)return false;
    for(const row of coordinates)if(!Number.isFinite(Math.fround(row[0]))||!Number.isFinite(Math.fround(row[1]))||!Number.isFinite(Math.fround(row[2])))return false;
    for(const {values,sources} of bindings)for(let i=0;i<sources.length;i+=2){
      const a=coordinates[sources[i]],b=coordinates[sources[i+1]];
      const x=a===b?a[0]:(a[0]+b[0])/2,y=a===b?a[1]:(a[1]+b[1])/2,z=a===b?a[2]:(a[2]+b[2])/2;
      for(let offset=i*6;offset<i*6+12;offset+=3){values[offset]=x;values[offset+1]=y;values[offset+2]=z;}
    }
    for(let i=0;i<atoms.length;i++){
      const atom=atoms[i],coordinate=coordinates[i];
      atom.x=coordinate[0];atom.y=coordinate[1];atom.z=coordinate[2];
    }
    for(let i=0;i<pickTargets.length;i++){
      const center=pickTargets[i],a=coordinates[pickSources[2*i]],b=coordinates[pickSources[2*i+1]];
      center.x=a===b?a[0]:(a[0]+b[0])/2;center.y=a===b?a[1]:(a[1]+b[1])/2;center.z=a===b?a[2]:(a[2]+b[2])/2;
    }
    for(const cylinder of pickCylinders)updateNativePickCylinder(cylinder);
    for(const [geometry,stickEndpoints] of geometries){
      for(const group of geometry.geometryGroups)uploads?.mark(geometry,group,stickEndpoints);
      geometry.verticesNeedUpdate=true;
    }
    return true;
  };
}
