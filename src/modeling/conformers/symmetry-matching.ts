import type { Structure } from '../../core/types';
import type { SharedModelConstraints } from '../../core/modeling/contracts';
import { assertBuilderStereoPreserved, builderDoubleBondGeometry, builderTetrahedralParity } from '../../core/builder-stereo';
import { superposeViewAtoms } from '../view-superposition';

/** Exact labelled graph isomorphism, with geometric fits evaluated only for
 * chemical mappings. No element-only permutations, search cap or fixed-ID
 * fallback is used. Non-fit hydrogen extensions stop at the first stereo- and
 * constraint-preserving extension of each heavy-atom mapping. */
interface Graph {
  structure: Structure; labels: string[]; edges: Map<number,string>[];
  constraints?: SharedModelConstraints; fit: Set<number>;
  tetrahedralCenters?:number[];
}
const textOrder=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function conformerSymmetryConnectivityIssue(structure:Structure):{reason:'missing-connectivity'|'incomplete-connectivity';message:string}|undefined {
  if(structure.atoms.length<=1)return;
  if(!Array.isArray(structure.bonds)||!structure.bonds.length)return{reason:'missing-connectivity',message:'对称等价原子匹配需要已有连接图；多原子无图或空图请先确认成键，或显式选择“固定原子对应”。'};
  const missing=(structure.bondPerceptionIssues??[]).some(issue=>['partial','unresolved'].includes(issue.kind)&&!structure.bonds!.some(bond=>{
    const a=structure.atoms[bond.a]?.id,b=structure.atoms[bond.b]?.id;return a===issue.atomIds[0]&&b===issue.atomIds[1]||a===issue.atomIds[1]&&b===issue.atomIds[0];
  }));
  if(missing)return{reason:'incomplete-connectivity',message:'对称等价原子匹配所需的连接图仍有未解决的缺失邻接；请先确认成键，或显式选择“固定原子对应”。'};
}
export function assertConformerSymmetryConnectivity(structure:Structure):void {
  const issue=conformerSymmetryConnectivityIssue(structure);
  if(issue)throw Object.assign(new Error(issue.message),{code:'CONFORMER_SYMMETRY_CONNECTIVITY_REQUIRED',reason:issue.reason});
}
function graph(structure:Structure,constraints?:SharedModelConstraints):Graph {
  assertConformerSymmetryConnectivity(structure);
  const enabled=constraints?.enabled!==false;
  const frozen=new Set(enabled?constraints?.frozenAtomIds:[]);
  for(const layer of structure.modelLayers??[])if(layer.frozen)for(const id of layer.atomIds)frozen.add(id);
  const rows=enabled?constraints?.coordinates??[]:[];
  const labels=structure.atoms.map(atom=>JSON.stringify([atom.element,atom.formalCharge??null,frozen.has(atom.id!),
    rows.filter(row=>row.atomIds.includes(atom.id!)).map(row=>JSON.stringify([row.type,row.action,row.value??null,row.steps,row.increment,row.start??null,row.end??null,row.values??null])).sort()]));
  const edges=structure.atoms.map(()=>new Map<number,string>());
  for(const bond of structure.bonds??[]){
    const label=JSON.stringify([bond.order,bond.aromatic??false,bond.orderKnown!==false,bond.kind??'covalent',bond.fractional??false]);
    edges[bond.a].set(bond.b,label);edges[bond.b].set(bond.a,label);
  }
  const heavy=structure.atoms.flatMap((atom,index)=>atom.element!=='H'?[index]:[]);
  return{structure,labels,edges,constraints,fit:new Set(heavy.length?heavy:structure.atoms.map((_,index)=>index))};
}
function refine(left:Graph,right:Graph):[string[],string[]] {
  let colors=[...left.labels,...right.labels],count=new Set(colors).size;
  const n=left.labels.length,edges=[...left.edges,...right.edges.map(row=>new Map([...row].map(([i,label])=>[i+n,label])))];
  for(let round=0;round<colors.length;round++){
    const keys=colors.map((color,index)=>JSON.stringify([color,[...edges[index]].map(([i,label])=>JSON.stringify([label,colors[i]])).sort()]));
    const dictionary=new Map([...new Set(keys)].sort().map((key,index)=>[key,String(index)]));
    const next=keys.map(key=>dictionary.get(key)!);colors=next;
    if(dictionary.size===count)break;count=dictionary.size;
  }
  return[colors.slice(0,n),colors.slice(n)];
}
/** Cheap bucket only; collisions are resolved by exact graph matching. */
export function symmetryGraphBucket(structure:Structure,constraints?:SharedModelConstraints):string {
  const g=graph(structure,constraints);
  return JSON.stringify([g.labels.slice().sort(),g.edges.flatMap((row,i)=>[...row].filter(([j])=>j>i).map(([,label])=>label)).sort()]);
}
function coordinateKey(g:Graph,mapIds:(id:string)=>string):string {
  if(g.constraints?.enabled===false)return '[]';
  return JSON.stringify((g.constraints?.coordinates??[]).map(row=>{
    const ids=row.atomIds.map(mapIds),forward=JSON.stringify(ids),reverse=JSON.stringify([...ids].reverse());
    // Reversing the complete B/A/D tuple preserves its physical definition.
    return JSON.stringify([row.type,forward<reverse?forward:reverse,row.action,row.value??null,row.steps,row.increment,row.start??null,row.end??null,row.values??null,row.images??null]);
  }).sort());
}
function constraintsMatch(left:Graph,right:Graph,mapping:readonly number[]):boolean {
  const ids=new Map(left.structure.atoms.map((atom,index)=>[atom.id!,right.structure.atoms[mapping[index]].id!]));
  return coordinateKey(left,id=>ids.get(id)??`missing:${id}`)===coordinateKey(right,id=>id);
}
function tetrahedralCenters(g:Graph):number[]{
  if(g.tetrahedralCenters)return g.tetrahedralCenters;
  const centers:number[]=[];
  for(const [center,atom]of g.structure.atoms.entries()){
    const neighbours=(g.structure.bonds??[]).filter(bond=>bond.kind!=='coordination'&&(bond.a===center||bond.b===center)).map(bond=>bond.a===center?bond.b:bond.a);
    if(neighbours.length!==4)continue;
    if(atom.stereoParity){centers.push(center);continue;}
    // Equal terminal substituents are provably exchangeable without search.
    if(neighbours.some((a,i)=>neighbours.slice(i+1).some(b=>g.labels[a]===g.labels[b]&&g.edges[a].size===1&&g.edges[b].size===1&&g.edges[center].get(a)===g.edges[center].get(b))))continue;
    const rooted={...g,labels:g.labels.map((label,index)=>JSON.stringify([label,index===center?'center':'']))};
    const [colors]=refine(rooted,rooted);
    let equivalent=false;
    for(let i=0;i<neighbours.length&&!equivalent;i++)for(let j=i+1;j<neighbours.length&&!equivalent;j++){
      const a=neighbours[i],b=neighbours[j];if(colors[a]!==colors[b])continue;
      // Refinement equality is not proof of chemical equivalence. Resolve a
      // remaining tie by a complete center-fixed automorphism search.
      const mark=(neighbour:number):Graph=>({...rooted,labels:rooted.labels.map((label,index)=>JSON.stringify([label,index===neighbour?'substituent':'']))});
      equivalent=search(mark(a),mark(b),()=>false,false,true);
    }
    if(!equivalent)centers.push(center);
  }
  g.tetrahedralCenters=centers;return centers;
}
function stereoMatch(left:Graph,right:Graph,mapping:readonly number[]):boolean {
  // A private comparison projection only. Neither source IDs nor coordinates
  // are written back, and ordered-neighbour stereo is checked after relabelling.
  const relabelled={...left.structure,atoms:left.structure.atoms.map((atom,index)=>({...atom,id:right.structure.atoms[mapping[index]].id}))};
  try{
    assertBuilderStereoPreserved(relabelled,right.structure);assertBuilderStereoPreserved(right.structure,relabelled);
    for(const center of tetrahedralCenters(left)){
      const id=relabelled.atoms[center].id!,before=builderTetrahedralParity(relabelled,id),after=builderTetrahedralParity(right.structure,id);
      if(before!==after&&(before!==0||after!==0))return false;
    }
    // Preserve the actual mapped substituent relationship as well as the
    // existing defined E/Z labels. This does not depend on the bounded-depth
    // CIP-like priority helper resolving distant substituent differences.
    for(const bond of left.structure.bonds??[]){
      if(bond.order!==2||bond.kind==='coordination')continue;
      const neighbours=(center:number,other:number)=>[...left.edges[center].keys()].filter(index=>index!==other);
      for(const a of neighbours(bond.a,bond.b))for(const d of neighbours(bond.b,bond.a)){
        const tuple=[a,bond.a,bond.b,d];
        const before=builderDoubleBondGeometry(left.structure,tuple.map(index=>left.structure.atoms[index].id!) as [string,string,string,string]);
        const after=builderDoubleBondGeometry(right.structure,tuple.map(index=>right.structure.atoms[mapping[index]].id!) as [string,string,string,string]);
        if(before!==after&&(before!=='undefined'||after!=='undefined'))return false;
      }
    }
    return true;
  }catch{return false;}
}
function search(left:Graph,right:Graph,visit:(mapping:readonly number[])=>boolean,stereo:boolean,firstOnly:boolean):boolean {
  if(left.labels.length!==right.labels.length)return false;
  const [lc,rc]=refine(left,right),sorted=(v:string[])=>JSON.stringify([...v].sort());
  if(sorted(lc)!==sorted(rc))return false;
  const options=lc.map(color=>rc.flatMap((value,index)=>value===color?[index]:[]));
  const mapping=Array(left.labels.length).fill(-1) as number[],used=new Set<number>();let found=false,stop=false;
  const walk=(depth:number):boolean=>{
    if(stop)return true;
    if(depth===mapping.length){
      if(!constraintsMatch(left,right,mapping)||stereo&&!stereoMatch(left,right,mapping))return false;
      found=true;stop=visit(mapping)||firstOnly;return true;
    }
    const remaining=mapping.flatMap((j,i)=>j<0?[i]:[]),fitPending=remaining.some(i=>left.fit.has(i));
    const choices=remaining.filter(i=>!fitPending||left.fit.has(i)).map(i=>({i,candidates:options[i].filter(j=>!used.has(j)&&mapping.every((mapped,k)=>mapped<0||left.edges[i].get(k)===right.edges[j].get(mapped)))}));
    choices.sort((a,b)=>a.candidates.length-b.candidates.length||left.edges[b.i].size-left.edges[a.i].size||a.i-b.i);
    const choice=choices[0];if(!choice?.candidates.length)return false;
    let extension=false;
    for(const j of choice.candidates){mapping[choice.i]=j;used.add(j);const accepted=walk(depth+1);used.delete(j);mapping[choice.i]=-1;
      extension ||= accepted;
      if(stop||accepted&&!fitPending)return true;
    }
    return extension;
  };
  walk(0);return found;
}
export function symmetryGraphsEquivalent(moving:Structure,reference:Structure,movingConstraints?:SharedModelConstraints,referenceConstraints?:SharedModelConstraints):boolean {
  if(conformerSymmetryConnectivityIssue(moving)||conformerSymmetryConnectivityIssue(reference))return false;
  return search(graph(moving,movingConstraints),graph(reference,referenceConstraints),()=>false,false,true);
}
export function compareSymmetryConformerGeometry(moving:Structure,reference:Structure,movingConstraints?:SharedModelConstraints,referenceConstraints?:SharedModelConstraints) {
  const issue=conformerSymmetryConnectivityIssue(moving)??conformerSymmetryConnectivityIssue(reference);
  if(issue)return{comparable:false as const,reason:'connectivity' as const,detail:issue.reason,message:issue.message};
  const left=graph(moving,movingConstraints),right=graph(reference,referenceConstraints);
  return comparePreparedSymmetry(left,right);
}
/** Local to one immutable cluster batch; never keyed by original atom IDs or
 * reused across result/constraint revisions. */
export function createSymmetryConformerGeometryComparer(){
  const cache=new WeakMap<Structure,{constraints:SharedModelConstraints|undefined;value:Graph}>();
  const prepare=(structure:Structure,constraints?:SharedModelConstraints)=>{
    const cached=cache.get(structure);if(cached&&cached.constraints===constraints)return cached.value;
    const value=graph(structure,constraints);cache.set(structure,{constraints,value});return value;
  };
  return(moving:Structure,reference:Structure,movingConstraints?:SharedModelConstraints,referenceConstraints?:SharedModelConstraints)=>{
    const issue=conformerSymmetryConnectivityIssue(moving)??conformerSymmetryConnectivityIssue(reference);
    if(issue)return{comparable:false as const,reason:'connectivity' as const,detail:issue.reason,message:issue.message};
    try{
      const left=prepare(moving,movingConstraints),right=prepare(reference,referenceConstraints);
      if(!search(left,right,()=>false,false,true))return{comparable:false as const,reason:'connectivity' as const};
      return comparePreparedSymmetry(left,right);
    }catch{return{comparable:false as const,reason:'connectivity' as const,detail:'invalid-geometry-or-connectivity'};}
  };
}
function comparePreparedSymmetry(left:Graph,right:Graph){
  const moving=left.structure,reference=right.structure;
  let best=Infinity,aligned=false;
  const matched=search(left,right,mapping=>{
    const pairs=[...left.fit].map(i=>({movingAtomId:moving.atoms[i].id!,referenceAtomId:reference.atoms[mapping[i]].id!}));
    const fit=superposeViewAtoms({movingAtoms:moving.atoms.filter((_,i)=>left.fit.has(i)),referenceAtoms:reference.atoms.filter((_,i)=>right.fit.has(i)),pairs,mappingConfirmed:true});
    if(fit.ok){aligned=true;best=Math.min(best,fit.rmsd);}
    // Zero is the mathematical lower bound. Otherwise every allowed fit is
    // searched, including large automorphism groups, without an accuracy cap.
    return best===0;
  },true,false);
  if(!matched)return{comparable:false as const,reason:'stereochemistry' as const};
  if(!aligned)return{comparable:false as const,reason:'alignment' as const};
  return{comparable:true as const,rmsdAngstrom:best,fitAtomIds:[...right.fit].map(i=>reference.atoms[i].id!).sort(textOrder),fitScope:reference.atoms.some(atom=>atom.element!=='H')?'heavy-atoms' as const:'all-atoms' as const};
}
