import type { Structure, Vector3 } from './types';
import { minimumImage } from './periodic';
import { atomicNumber } from './elements';

const sub = (a: Vector3, b: Vector3): Vector3 => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross = (a: Vector3,b: Vector3): Vector3 => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot = (a: Vector3,b: Vector3) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const xyz = (a: Structure['atoms'][number]): Vector3 => [a.x,a.y,a.z];
function distinguishableNeighbours(s:Structure,center:number):boolean{
  const edges=(s.bonds??[]).filter(b=>b.kind!=='coordination'),neighbours=edges.filter(b=>b.a===center||b.b===center).map(b=>b.a===center?b.b:b.a);
  if(neighbours.length!==4)return false;
  // Rooted graph refinement distinguishes substituent graphs rather than their
  // Cartesian directions. Four equivalent H atoms must never create a chiral C.
  let labels=s.atoms.map((a,i)=>i===center?'CENTER':`${a.element}:${a.formalCharge??0}`);
  // After deleting center-touching edges, two equally labelled terminal H
  // retain identical refinement keys at EVERY step. They cannot make four
  // distinct neighbours. Keep initial label construction (including failures)
  // and all specified-parity/wedge handling in the callers unchanged.
  const terminalHydrogenLabels=new Set<string>();
  for(const neighbour of new Set(neighbours)){
    if(neighbour===center||s.atoms[neighbour]?.element!=='H'||edges.some(b=>(b.a===neighbour||b.b===neighbour)&&b.a!==center&&b.b!==center))continue;
    const label=labels[neighbour];
    if(terminalHydrogenLabels.has(label))return false;
    terminalHydrogenLabels.add(label);
  }
  for(let step=0;step<Math.min(s.atoms.length,32);step++){
    const keys=s.atoms.map((_,i)=>i===center?'CENTER':`${labels[i]}|${edges.filter(b=>(b.a===i||b.b===i)&&b.a!==center&&b.b!==center).map(b=>`${b.aromatic?1.5:b.order}:${labels[b.a===i?b.b:b.a]}`).sort().join(',')}`);
    const dictionary=[...new Set(keys)].sort();const next=keys.map(k=>`${dictionary.indexOf(k)}`);
    if(next.every((v,i)=>v===labels[i]))break;labels=next;
  }
  return new Set(neighbours.map(i=>labels[i])).size===4;
}
/** This is ordered-neighbour parity, not a CIP R/S assignment. */
export function builderTetrahedralParity(structure: Structure, atomId: string): -1|0|1 {
  const i=structure.atoms.findIndex(a=>a.id===atomId);
  if(i<0) throw new Error('手性中心不存在。');
  const neighbours=(structure.bonds??[]).filter(b=>b.kind!=='coordination'&&(b.a===i||b.b===i)).map(b=>b.a===i?b.b:b.a)
    .sort((a,b)=>{const aa=structure.atoms[a].id??`${a}`,bb=structure.atoms[b].id??`${b}`;return aa<bb?-1:aa>bb?1:0;});
  if(neighbours.length!==4) return 0;
  const p=neighbours.map(n=>{
    if(!structure.cell)return xyz(structure.atoms[n]);
    const b=structure.bonds?.find(b=>(b.a===i&&b.b===n)||(b.b===i&&b.a===n));
    if(!b?.image)return minimumImage(structure,i,n).delta;
    const delta=sub(xyz(structure.atoms[n]),xyz(structure.atoms[i]));
    b.image.forEach((v,j)=>structure.cell!.vectors[j].forEach((c,k)=>{delta[k]+=c*v*(b.a===i?1:-1);}));
    return delta;
  });
  const determinant=dot(sub(p[0],p[3]),cross(sub(p[1],p[3]),sub(p[2],p[3])));
  return Math.abs(determinant)<1e-7?0:determinant>0?1:-1;
}
/** Geometric same/opposite side using explicitly chosen substituents; no invented CIP priorities. */
export function builderDoubleBondGeometry(structure:Structure, atomIds:[string,string,string,string]): 'same'|'opposite'|'undefined' {
  const p=atomIds.map(id=>{const a=structure.atoms.find(a=>a.id===id);if(!a)throw new Error('双键构型原子不存在。');return xyz(a);});
  if(structure.cell)for(let i=1;i<p.length;i++){
    const from=structure.atoms.findIndex(a=>a.id===atomIds[i-1]),to=structure.atoms.findIndex(a=>a.id===atomIds[i]),b=structure.bonds?.find(b=>(b.a===from&&b.b===to)||(b.b===from&&b.a===to));
    let delta=sub(xyz(structure.atoms[to]),xyz(structure.atoms[from]));
    if(b?.image)b.image.forEach((v,j)=>structure.cell!.vectors[j].forEach((c,k)=>{delta[k]+=c*v*(b.a===from?1:-1);}));else delta=minimumImage(structure,from,to).delta;
    p[i]=[p[i-1][0]+delta[0],p[i-1][1]+delta[1],p[i-1][2]+delta[2]];
  }
  const axis=sub(p[2],p[1]), n1=cross(axis,sub(p[0],p[1])), n2=cross(axis,sub(p[3],p[2]));
  const value=dot(n1,n2);
  return Math.abs(value)<1e-8?'undefined':value>0?'same':'opposite';
}
/** E/Z is assigned only when explicit substituent priorities can be resolved.
 * First atomic-number/attached-neighbour priorities include multiple-bond
 * duplicate atoms; deeper ties (and isotope distinctions) remain undefined. */
export function builderDoubleBondConfiguration(s:Structure,aId:string,bId:string):'E'|'Z'|'undefined'{
  const a=s.atoms.findIndex(a=>a.id===aId),b=s.atoms.findIndex(a=>a.id===bId);if(a<0||b<0)return 'undefined';
  if(!(s.bonds??[]).some(edge=>edge.order===2&&((edge.a===a&&edge.b===b)||(edge.a===b&&edge.b===a))))return 'undefined';
  const signature=(root:number,excluded:number,depth:number):number[]=>{
    let layer:{index:number;parent:number;visited:Set<number>;duplicate?:boolean}[]=[{index:root,parent:excluded,visited:new Set([excluded])}],out:number[]=[];
    for(let d=0;d<=depth;d++){
      out.push(...layer.map(n=>atomicNumber(s.atoms[n.index].element)).sort((x,y)=>y-x),-1);
      const next:typeof layer=[];
      for(const n of layer){if(n.duplicate||n.visited.has(n.index))continue;const visited=new Set(n.visited);visited.add(n.index);
        for(const edge of s.bonds??[]){if(edge.kind==='coordination')continue;const j=edge.a===n.index?edge.b:edge.b===n.index?edge.a:-1;if(j<0)continue;
          if(j!==n.parent)next.push({index:j,parent:n.index,visited,duplicate:visited.has(j)});
          for(let k=1;k<Math.min(3,Math.round(edge.order));k++)next.push({index:j,parent:n.index,visited,duplicate:true});
        }
      }
      layer=next;if(!layer.length)break;
    }
    return out;
  };
  const priority=(center:number,opposite:number):number|undefined=>{
    const ns=(s.bonds??[]).filter(edge=>edge.kind!=='coordination'&&(edge.a===center||edge.b===center)).map(edge=>edge.a===center?edge.b:edge.a).filter(i=>i!==opposite);
    if(ns.length===1)return s.atoms[ns[0]].element==='H'?undefined:ns[0];
    if(ns.length!==2)return undefined;
    // Bound the expansion. If a graph remains tied, no configurational label is invented.
    for(let depth=0;depth<Math.min(2,s.atoms.length);depth++){
      const left=signature(ns[0],center,depth),right=signature(ns[1],center,depth),length=Math.max(left.length,right.length);
      for(let i=0;i<length;i++){const delta=(left[i]??-1)-(right[i]??-1);if(delta)return delta>0?ns[0]:ns[1];}
      if(left.length>4096||right.length>4096)return undefined;
    }
    return undefined;
  };
  const left=priority(a,b),right=priority(b,a);if(left===undefined||right===undefined)return 'undefined';
  const geometry=builderDoubleBondGeometry(s,[s.atoms[left].id!,aId,bId,s.atoms[right].id!]);return geometry==='same'?'Z':geometry==='opposite'?'E':'undefined';
}
export function updateBuilderStereo(structure:Structure, affectedAtomIds?: readonly string[]): {structure:Structure;touchedIds:string[]} {
  const affected=affectedAtomIds ? new Set(affectedAtomIds) : undefined;
  const atoms=structure.atoms.map(a=>({...a}));
  const bonds=(structure.bonds??[]).map(b=>({...b}));
  const touchedIds:string[]=[];
  for(const atom of atoms){
    if(!atom.id || affected && !affected.has(atom.id)) continue;
    const i=atoms.indexOf(atom),specified=atom.stereoParity!==undefined||bonds.some(b=>(b.a===i||b.b===i)&&(b.stereo===1||b.stereo===6));
    const parity=specified||distinguishableNeighbours(structure,i)?builderTetrahedralParity(structure,atom.id):0;
    if(atom.stereoParity!==parity&&(parity!==0||atom.stereoParity!==undefined)){atom.stereoParity=parity;touchedIds.push(atom.id);}
  }
  // Wedges belong to the independent diagram projection, not global XYZ z.
  // Synthesize each candidate wedge and choose the sign whose decoded stable-ID
  // parity agrees with the Cartesian parity under the ACTUAL current 2D layout.
  bonds.forEach(b=>{if((b.stereo===1||b.stereo===6)&&(!affected||affected.has(atoms[b.a].id!)||affected.has(atoms[b.b].id!)))b.stereo=0;});
  for(let i=0;i<atoms.length;i++){
    if(!atoms[i].stereoParity || affected && !affected.has(atoms[i].id!))continue;
    const candidates=bonds.filter(b=>b.order===1&&b.kind!=='coordination'&&(b.a===i||b.b===i)&&!(b.stereo===1||b.stereo===6))
      .sort((a,b)=>Number(!!atoms[a.a===i?a.b:a.a].stereoParity)-Number(!!atoms[b.a===i?b.b:b.a].stereoParity));
    for(const candidate of candidates){
      const trial=bonds.map(b=>b===candidate?{...b,a:i,b:b.a===i?b.b:b.a,stereo:1}:{...b,stereo:b.a===i||b.b===i?0:b.stereo});
      const parity=requestedBuilder2DParity({...structure,atoms,bonds:trial},atoms[i].id!);if(!parity)continue;
      if(candidate.a!==i){[candidate.a,candidate.b]=[candidate.b,candidate.a];if(candidate.image)candidate.image=candidate.image.map(v=>-v) as Vector3;}
      candidate.stereo=parity===atoms[i].stereoParity?1:6;break;
    }
  }
  return {structure:{...structure,atoms,bonds:structure.bonds?bonds:undefined},touchedIds};
}
export function assertBuilderStereoPreserved(before:Structure,after:Structure,preserveDoubleBonds=true):void{
  // XYZ imports may have no wedge/parity annotation. The actual starting
  // geometry of four distinguishable substituent graphs is still the automatic
  // baseline. Equivalent neighbours (e.g. CH4) do not acquire a stereo guard.
  // Derive from `before` on each check: a deliberate manual edit has already
  // become that reference, while an explicitly planar baseline stays undefined.
  for(const [index,atom]of before.atoms.entries()){if(!atom.id||!atom.stereoParity&&!distinguishableNeighbours(before,index))continue;
    const previous=builderTetrahedralParity(before,atom.id),next=builderTetrahedralParity(after,atom.id);
    if(previous&&next!==previous)throw new Error('局部自动几何会改变或压平当前手性；如需改变构型，请先明确手工调整。');
  }
  if(preserveDoubleBonds)for(const bond of before.bonds??[]){
    if(bond.order!==2)continue;const a=before.atoms[bond.a].id,b=before.atoms[bond.b].id;if(!a||!b)continue;
    const neighbourIds=(before.bonds??[]).filter(b=>[bond.a,bond.b].includes(b.a)||[bond.a,bond.b].includes(b.b)).flatMap(b=>[before.atoms[b.a].id,before.atoms[b.b].id]);
    if(neighbourIds.some(id=>!after.atoms.some(atom=>atom.id===id)))continue;
    const previous=builderDoubleBondConfiguration(before,a,b),next=builderDoubleBondConfiguration(after,a,b);
    if(previous!=='undefined'&&next!==previous)throw new Error('自动几何会改变或丢失双键 E/Z 构型。');
  }
}
/** Decode a native 2D wedge drawing into the same stable-neighbour parity. */
export function requestedBuilder2DParity(structure:Structure,atomId:string):-1|0|1{
  const center=structure.atoms.findIndex(a=>a.id===atomId);if(center<0)return 0;
  const explicit=structure.atoms[center].stereoParity;
  const wedges=(structure.bonds??[]).filter(b=>(b.a===center||b.b===center)&&(b.stereo===1||b.stereo===6));
  if(!wedges.length)return explicit??0;
  const atoms=structure.atoms.map(a=>{const p=a.id?structure.layout2D?.[a.id]:undefined;return {...a,x:p?.x??a.x,y:p?.y??a.y,z:0};});
  for(const b of wedges){const other=b.a===center?b.b:b.a;atoms[other].z=(b.stereo===1?1:-1)*(b.a===center?1:-1);}
  return builderTetrahedralParity({...structure,atoms,cell:undefined},atomId);
}
