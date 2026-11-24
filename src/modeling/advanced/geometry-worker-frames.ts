import type { Atom, Structure } from '../../core/types';

type AtomHeader = Omit<Atom,'x'|'y'|'z'>;
export interface GeometryWorkerFrame {
  header: Omit<Structure,'atoms'|'bonds'>;
  topology?: readonly AtomHeader[];
  graph?: {bonds?:Structure['bonds']};
  coordinates: Float64Array;
}

function sameFields(a:object,b:object,ignored?:ReadonlySet<string>):boolean {
  const keys = Object.keys(a).filter(key=>!ignored?.has(key));
  if(keys.length!==Object.keys(b).length)return false;
  return keys.every(key=>{
    const x=(a as Record<string,unknown>)[key],y=(b as Record<string,unknown>)[key];
    return Object.hasOwn(b,key)&&(Object.is(x,y)||Array.isArray(x)&&Array.isArray(y)&&x.length===y.length&&x.every((value,i)=>Object.is(value,y[i])));
  });
}
const xyz = new Set(['x','y','z']);

export function packGeometryWorkerFrames(share:boolean){
  let topology:readonly AtomHeader[]|undefined,graph:{bonds?:Structure['bonds']}|undefined;
  return (structure:Structure):GeometryWorkerFrame=>{
    const {atoms,bonds,...header}=structure;
    const sameTopology=topology&&atoms.length===topology.length&&atoms.every((atom,i)=>sameFields(atom,topology![i],xyz));
    const sameGraph=graph&&(graph.bonds===bonds||!!graph.bonds&&!!bonds&&graph.bonds.length===bonds.length&&bonds.every((bond,i)=>sameFields(bond,graph!.bonds![i])));
    if(!sameTopology)topology=atoms.map(({x:_x,y:_y,z:_z,...atom})=>atom);
    if(!sameGraph)graph={bonds};
    const coordinates=new Float64Array(share?new SharedArrayBuffer(atoms.length*24):new ArrayBuffer(atoms.length*24));
    atoms.forEach((atom,i)=>{coordinates[i*3]=atom.x;coordinates[i*3+1]=atom.y;coordinates[i*3+2]=atom.z;});
    return {header,coordinates,...(!sameTopology?{topology}:{}),...(!sameGraph?{graph}:{})};
  };
}

/** The exact comparer can keep its immutable frame identities. Only the
 * current comparison's atom objects stay materialized inside each worker. */
export function geometryWorkerFrames(){
  let topology:readonly AtomHeader[]|undefined,graph:{bonds?:Structure['bonds']}|undefined;
  const hot=new Map<number,Atom[]>(),structures:Structure[]=[];
  return {structures,add(frame:GeometryWorkerFrame){
    topology=frame.topology??topology;graph=frame.graph??graph;
    if(!topology||!graph||frame.coordinates.length!==topology.length*3)throw Error('构象几何工作页的原子数量或索引无效。');
    const index=structures.length,atoms=topology,coordinates=frame.coordinates;
    structures.push({...frame.header,bonds:graph.bonds,get atoms(){
      const found=hot.get(index);if(found){hot.delete(index);hot.set(index,found);return found;}
      const next=atoms.map((atom,i)=>({...atom,x:coordinates[i*3],y:coordinates[i*3+1],z:coordinates[i*3+2]}));
      hot.set(index,next);if(hot.size>3)hot.delete(hot.keys().next().value!);
      return next;
    }});
  }};
}
