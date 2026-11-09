import type {Structure} from '../../core/types';
import type {ModelCoordinate,SharedModelConstraints} from '../../core/modeling/contracts';
import type {AtomPair} from '../view-superposition';

/** Full formula, including hydrogens; neither atom IDs nor bond labels occur. */
export function elementCompositionKey(structure:Structure):string{
 const counts=new Map<string,number>();for(const atom of structure.atoms)counts.set(atom.element,(counts.get(atom.element)??0)+1);
 return JSON.stringify([...counts].sort(([a],[b])=>a<b?-1:a>b?1:0));
}
type ConstraintKind='unconstrained'|'mapped-internal'|'unresolved';
export interface ElementConstraintProfile{key:string;kind:ConstraintKind;rows:ModelCoordinate[]}
const parameters=(row:ModelCoordinate)=>[row.type,row.action,row.value??null,row.steps,row.increment,row.start??null,row.end??null,row.values??null,row.images??null];
/** A candidate-pool key only, not proof of constraint equivalence. Missing
 * Cartesian targets or implicit internal targets are deliberately unresolved. */
export function elementConstraintProfile(structure:Structure,constraints?:SharedModelConstraints):ElementConstraintProfile{
 const byId=new Map(structure.atoms.map(atom=>[atom.id!,atom.element]));
 const frozen=new Set<string>();
 if(constraints?.enabled!==false)for(const id of constraints?.frozenAtomIds??[])frozen.add(id);
 for(const layer of structure.modelLayers??[])if(layer.frozen)for(const id of layer.atomIds)frozen.add(id);
 const rows=constraints?.enabled===false?[]:constraints?.coordinates??[];
 if(!frozen.size&&!rows.length)return{key:'unconstrained',kind:'unconstrained',rows:[]};
 const coarseRows=rows.map(row=>{
  const elements=row.atomIds.map(id=>byId.get(id)??'missing'),forward=JSON.stringify(elements),reverse=JSON.stringify([...elements].reverse());
  return JSON.stringify([parameters(row),forward<reverse?forward:reverse]);
 }).sort();
 const key=JSON.stringify([[...frozen].map(id=>byId.get(id)??'missing').sort(),coarseRows]);
 const unresolved=frozen.size>0||rows.some(row=>row.action!=='freeze'||!Number.isFinite(row.value)
  ||row.atomIds.length!==({B:2,A:3,D:4}[row.type])||new Set(row.atomIds).size!==row.atomIds.length
  ||row.atomIds.some(id=>!byId.has(id)||byId.get(id)==='H')||row.images?.some(image=>image.some(Boolean)));
 return{key,kind:unresolved?'unresolved':'mapped-internal',rows};
}
/** Called only for a geometrically verified heavy-atom mapping. IDs are used to
 * apply that witness to the definitions, never to restrict the candidate pool. */
export function elementConstraintsMatch(left:ElementConstraintProfile,right:ElementConstraintProfile,pairs:readonly AtomPair[]):boolean{
 if(left.key!==right.key||left.kind==='unresolved'||right.kind==='unresolved')return false;
 if(left.kind==='unconstrained')return right.kind==='unconstrained';
 const map=new Map(pairs.map(pair=>[pair.movingAtomId,pair.referenceAtomId]));
 const canonical=(rows:ModelCoordinate[],translate:(id:string)=>string|undefined)=>{
  const keys:string[]=[];for(const row of rows){const ids=row.atomIds.map(translate);if(ids.some(id=>id===undefined))return null;
   const forward=JSON.stringify(ids),reverse=JSON.stringify([...ids].reverse());keys.push(JSON.stringify([parameters(row),forward<reverse?forward:reverse]));
  }return JSON.stringify(keys.sort());
 };
 const l=canonical(left.rows,id=>map.get(id)),r=canonical(right.rows,id=>id);
 return l!==null&&l===r;
}
