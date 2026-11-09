import type {Structure} from '../../core/types';
import {superposeViewAtoms,type SuperpositionAtom,type AtomPair} from '../view-superposition';

/** A bounded witness search, never a global permutation optimum. Increasing these
 * constants changes the algorithm identity. No mapping escapes into playback. */
export const ELEMENT_GEOMETRY_ALGORITHM = 'element-geometry-v1' as const;
const MAX_ITERATIONS=8;
type Point=[number,number,number];
type Prepared={atoms:SuperpositionAtom[];points:Point[];elements:Map<string,number[]>;radial:Map<string,number[]>;features?:number[][]};
export type ElementGeometryEvidence={matched:boolean;rmsdAngstrom:number|null;route:'fixed'|'assignment'|'radial-rejected'|'incompatible'|'unresolved';iterations:number};
const distance=(a:Point,b:Point)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
function prepare(structure:Structure):Prepared{
 const atoms=structure.atoms.filter(a=>a.element!=='H'),n=atoms.length;
 const anchor=atoms[0],center:Point=[0,0,0];
 if(anchor)for(const a of atoms){center[0]+=(a.x-anchor.x)/n;center[1]+=(a.y-anchor.y)/n;center[2]+=(a.z-anchor.z)/n;}
 const points=atoms.map(a=>[a.x-anchor.x-center[0],a.y-anchor.y-center[1],a.z-anchor.z-center[2]] as Point);
 const elements=new Map<string,number[]>(),radial=new Map<string,number[]>();
 atoms.forEach((a,i)=>{const rows=elements.get(a.element)??[];rows.push(i);elements.set(a.element,rows);});
 for(const [e,indices]of elements)radial.set(e,indices.map(i=>Math.hypot(...points[i])).sort((a,b)=>a-b));
 return{atoms,points,elements,radial};
}
/** Hungarian minimum-cost bijection, deterministic ties, polynomial work. */
function assignment(cost:number[][]):number[]{
 const n=cost.length,u=Array(n+1).fill(0),v=Array(n+1).fill(0),p=Array(n+1).fill(0),way=Array(n+1).fill(0);
 for(let i=1;i<=n;i++){
  p[0]=i;let j0=0;const min=Array(n+1).fill(Infinity),used=Array(n+1).fill(false);
  do{used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;
   for(let j=1;j<=n;j++)if(!used[j]){const cur=cost[i0-1][j-1]-u[i0]-v[j];if(cur<min[j]){min[j]=cur;way[j]=j0;}if(min[j]<delta){delta=min[j];j1=j;}}
   if(!Number.isFinite(delta))throw Error('元素几何指派包含无效距离。');
   for(let j=0;j<=n;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else min[j]-=delta;j0=j1;
  }while(p[j0]!==0);
  do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0!==0);
 }
 const answer=Array(n).fill(-1);for(let j=1;j<=n;j++)answer[p[j]-1]=j-1;return answer;
}
function mapByCost(a:Prepared,b:Prepared,cost:(i:number,j:number)=>number):number[]{
 const map=Array(a.atoms.length).fill(-1);
 for(const [element,left]of a.elements){const right=b.elements.get(element)!;const chosen=assignment(left.map(i=>right.map(j=>cost(i,j))));left.forEach((i,k)=>map[i]=right[chosen[k]]);}
 return map;
}
function features(a:Prepared):number[][]{
 return a.features??=a.points.map(point=>[...a.elements.keys()].sort().flatMap(e=>a.elements.get(e)!.map(i=>distance(point,a.points[i])).sort((x,y)=>x-y)));
}
function fit(a:Prepared,b:Prepared,map:number[]){return superposeViewAtoms({movingAtoms:a.atoms,referenceAtoms:b.atoms,pairs:map.map((j,i)=>({movingAtomId:a.atoms[i].id!,referenceAtomId:b.atoms[j].id!})),mappingConfirmed:true});}
export function createElementGeometryComparer(){
 const cache=new WeakMap<Structure,Prepared>();const get=(s:Structure)=>{let p=cache.get(s);if(!p){p=prepare(s);cache.set(s,p);}return p;};
 return{prepare:get,compare(moving:Structure,reference:Structure,threshold:number,acceptMapping?:(pairs:readonly AtomPair[])=>boolean):ElementGeometryEvidence{
  const a=get(moving),b=get(reference),n=a.atoms.length;
  if(!n||n!==b.atoms.length||[...a.elements].some(([e,ids])=>ids.length!==b.elements.get(e)?.length))return{matched:false,rmsdAngstrom:null,route:'incompatible',iterations:0};
  // Reverse triangle inequality after equal-weight centering; sorted same-element
  // radii minimize this lower bound over all allowed bijections.
  let squared=0;for(const[e,radii]of a.radial){const other=b.radial.get(e)!;radii.forEach((r,i)=>squared+=(r-other[i])**2);}
  if(Math.sqrt(squared/n)>threshold+1e-10)return{matched:false,rmsdAngstrom:null,route:'radial-rejected',iterations:0};
  const byId=new Map(b.atoms.map((atom,i)=>[atom.id,i])),fixed=a.atoms.map(atom=>byId.get(atom.id)??-1);
  const accepted=(map:number[])=>!acceptMapping||acceptMapping(map.map((j,i)=>({movingAtomId:a.atoms[i].id!,referenceAtomId:b.atoms[j].id!})));
  if(fixed.every((j,i)=>j>=0&&a.atoms[i].element===b.atoms[j].element)){
   const result=fit(a,b,fixed);if(result.ok&&result.rmsd<=threshold+1e-10&&accepted(fixed))return{matched:true,rmsdAngstrom:result.rmsd,route:'fixed',iterations:0};
  }
  const af=features(a),bf=features(b);
  const seeds=[mapByCost(a,b,(i,j)=>af[i].reduce((sum,x,k)=>sum+(x-bf[j][k])**2,0)),
   mapByCost(a,b,(i,j)=>(Math.hypot(...a.points[i])-Math.hypot(...b.points[j]))**2)];
  if(fixed.every((j,i)=>j>=0&&a.atoms[i].element===b.atoms[j].element))seeds.push(fixed);
  const seen=new Set<string>();let best=Infinity,iterations=0;
  for(const seed of seeds){let map=seed;
   for(let step=0;step<MAX_ITERATIONS;step++){
    const key=map.join(',');if(seen.has(key))break;seen.add(key);iterations++;
    const result=fit(a,b,map);if(!result.ok)break;best=Math.min(best,result.rmsd);
    if(result.rmsd<=threshold+1e-10&&accepted(map))return{matched:true,rmsdAngstrom:result.rmsd,route:'assignment',iterations};
    const {rotation:r}=result.transform,rotated=a.points.map(point=>r.map(row=>row.reduce((s,x,k)=>s+x*point[k],0)) as Point);
    map=mapByCost(a,b,(i,j)=>distance(rotated[i],b.points[j])**2);
   }
  }
  return{matched:false,rmsdAngstrom:Number.isFinite(best)?best:null,route:'unresolved',iterations};
 }};
}
